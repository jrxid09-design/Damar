const sqlite3 = require("sqlite3");
const path = require("node:path");
const fs = require("node:fs");
const { AsyncLocalStorage } = require("node:async_hooks");

/**
 * Pembungkus Promise di atas node-sqlite3 yang berbasis callback.
 *
 * Seluruh lapisan memori memakai satu koneksi. SQLite menulis
 * secara serial, jadi menambah koneksi tidak menambah throughput
 * tulis — yang ada malah menaikkan risiko SQLITE_BUSY.
 *
 * KEPEMILIKAN TRANSAKSI (R4): keanggotaan transaksi hanya lewat capability
 * `TransactionScope` yang diberikan ke callback `exclusive` / `transaction`.
 * Konteks async (AsyncLocalStorage) TIDAK memberi kepemilikan; ia hanya
 * dipakai untuk mengenali asal panggilan (provenance).
 *
 * SIKLUS HIDUP TRANSAKSI (R5/R6): Database memiliki BEGIN/COMMIT/ROLLBACK.
 *   - capability menolak pernyataan kontrol transaksi (BEGIN, COMMIT, END,
 *     ROLLBACK, SAVEPOINT, RELEASE, ABORT) pada awal pernyataan. Pemisahan
 *     pernyataan mengikuti tokenizer SQLite: `;` dan komentar hanya bermakna di
 *     luar literal dan identifier kutip (R6-F1). Satu capability call = satu
 *     pernyataan;
 *   - span berstatus ACTIVE → COMPLETED | EXPIRED | FAILED, satu transisi terminal;
 *   - span yang EXPIRED / sudah berakhir tidak bisa lagi menyentuh database lewat
 *     API publik (R6-F2). Konteks async hanya dipakai untuk mendeteksi asal itu;
 *   - COMMIT atau ROLLBACK yang gagal / tidak terbukti = instance di-POISON:
 *     handle native ditutup (transaksi tersisa dibuang SQLite), dan instance ini
 *     tidak pernah dipakai lagi. Pemanggil membuat Database baru secara eksplisit;
 *   - keadaan koneksi saat span keluar diperiksa dengan ROLLBACK: "no transaction
 *     is active" berarti bersih;
 *   - span yang menunggu kerja di luar dirinya dibatasi `spanDeadlineMs`.
 */

const DEFAULT_SPAN_DEADLINE_MS = 30_000;
const BUSY_ATTEMPTS = 8;

const CODES = Object.freeze({
    UNSCOPED: "UNSCOPED_DB_CALL_DURING_ACTIVE_TRANSACTION",
    EXPIRED: "TX_CAPABILITY_EXPIRED",
    REENTRANT: "DB_SPAN_REENTRANT",
    FOREIGN: "FOREIGN_DB_TX_CAPABILITY",
    DEADLINE: "DB_SPAN_DEADLINE_EXCEEDED",
    SPAN_EXPIRED: "DB_SPAN_EXPIRED",
    SPAN_ENDED: "DB_SPAN_ENDED",
    DANGLING: "DB_TX_DANGLING_AT_SPAN_EXIT",
    POISONED: "DB_CONNECTION_POISONED",
    ROLLBACK_FAILED: "DB_TX_ROLLBACK_FAILED",
    COMMIT_FAILED: "DB_TX_COMMIT_FAILED",
    TX_CONTROL: "TX_CONTROL_NOT_ALLOWED",
    DATABASE_TRANSACTION_CONTROL_FORBIDDEN: "TX_CONTROL_NOT_ALLOWED",
    MULTI_STATEMENT: "TX_MULTI_STATEMENT_NOT_ALLOWED",
    MALFORMED_SQL: "TX_SQL_MALFORMED",
    BEGIN_BUSY: "TX_BEGIN_BUSY"
});

const SPAN_STATE = Object.freeze({
    ACTIVE: "ACTIVE",
    COMPLETED: "COMPLETED",
    EXPIRED: "EXPIRED",
    FAILED: "FAILED"
});

const COMMIT = Symbol("commit");
const ROLLBACK = Symbol("rollback");
const BEGIN = Symbol("begin");
const INTERNAL_LIFECYCLE_BRAND = Symbol("Database.internalLifecycle");

const SPAN_CONTEXT = new AsyncLocalStorage();

const CONTROL_KEYWORDS = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ABORT"]);
const WORD = /[A-Za-z_]\w*/y;

const noop = () => {};

function dbError(code, message, cause) {
    return Object.assign(new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause }), { code });
}

/* ------------------------- pemecah SQL (R6-F1) --------------------------- */

/** Lewati spasi dan komentar mulai dari `i`; kembalikan indeks token bermakna berikutnya. */
function skipTrivia(text, i) {
    while (i < text.length) {
        if (/\s/.test(text[i])) {
            i += 1;
        }
        else if (text.startsWith("--", i)) {
            const newline = text.indexOf("\n", i);
            i = newline < 0 ? text.length : newline + 1;
        }
        else if (text.startsWith("/*", i)) {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? text.length : end + 2;
        }
        else {
            break;
        }
    }
    return i;
}

/** Indeks setelah penutup `quote` (kutip ganda `''` adalah escape). -1 bila tidak tertutup. */
function closeQuote(text, from, quote) {
    let i = from;
    for (;;) {
        const at = text.indexOf(quote, i);
        if (at < 0) {
            return -1;
        }
        if (text[at + 1] === quote) {
            i = at + 2;
            continue;
        }
        return at + 1;
    }
}

/**
 * Pecah SQL di batas pernyataan sejati: `;` di luar literal string, identifier
 * kutip ("…", `…`, […]), dan komentar. Tidak memotong komentar secara membabi
 * buta dan tidak mencari substring. `malformed` bila literal/identifier tidak tertutup.
 */
function splitStatements(sql) {

    const text = String(sql ?? "");
    const statements = [];
    let start = 0;
    let i = 0;
    let inTrigger = false;
    let triggerBodyDepth = 0;
    let caseDepth = 0;

    while (i < text.length) {

        const ch = text[i];

        if (ch === "'" || ch === "\"" || ch === "`") {
            const end = closeQuote(text, i + 1, ch);
            if (end < 0) {
                return { statements, malformed: true };
            }
            i = end;
        }
        else if (ch === "[") {
            const end = text.indexOf("]", i + 1);
            if (end < 0) {
                return { statements, malformed: true };
            }
            i = end + 1;
        }
        else if (text.startsWith("/*", i)) {
            const end = text.indexOf("*/", i + 2);
            if (end < 0) {
                return { statements, malformed: true };
            }
            i = end + 2;
        }
        else if (text.startsWith("--", i)) {
            i = skipTrivia(text, i);
        }
        else {

            if (!inTrigger) {
                const words = leadingWords(text.slice(start), 3);
                if (words[0] === "CREATE" && (
                    words[1] === "TRIGGER" ||
                    ((words[1] === "TEMP" || words[1] === "TEMPORARY") && words[2] === "TRIGGER")
                )) {
                    inTrigger = true;
                    triggerBodyDepth = 0;
                    caseDepth = 0;
                }
            }

            if (inTrigger) {
                WORD.lastIndex = i;
                const match = WORD.exec(text);
                if (match) {
                    const word = match[0].toUpperCase();

                    if (word === "CASE") {
                        caseDepth += 1;
                    }
                    else if (word === "BEGIN" && triggerBodyDepth === 0 && caseDepth === 0) {
                        triggerBodyDepth = 1;
                    }
                    else if (word === "END") {
                        if (caseDepth > 0) {
                            caseDepth -= 1;
                        }
                        else if (triggerBodyDepth === 1) {
                            const afterEnd = skipTrivia(text, match.index + match[0].length);
                            if (text[afterEnd] === ";") {
                                statements.push(text.slice(start, afterEnd));
                                start = afterEnd + 1;
                                i = afterEnd + 1;
                                inTrigger = false;
                                triggerBodyDepth = 0;
                                caseDepth = 0;
                                continue;
                            }
                        }
                    }
                    i = match.index + match[0].length;
                    continue;
                }
                i += 1;
                continue;
            }

            if (ch === ";") {
                statements.push(text.slice(start, i));
                start = i + 1;
            }
            i += 1;
        }

    }

    statements.push(text.slice(start));

    return { statements, malformed: false };

}

/** Kata kunci pertama sebuah pernyataan (huruf besar), melewati komentar dan spasi. */
function leadingWords(statement, max) {

    const words = [];
    let i = skipTrivia(statement, 0);

    while (words.length < max && i < statement.length) {
        WORD.lastIndex = i;
        const match = WORD.exec(statement);
        if (!match) {
            break;
        }
        words.push(match[0].toUpperCase());
        i = skipTrivia(statement, i + match[0].length);
    }

    return words;

}

/** Ringkasan SQL untuk gerbang capability. */
function inspectSql(sql) {

    const { statements, malformed } = splitStatements(sql);
    const meaningful = statements.filter(statement => skipTrivia(statement, 0) < statement.length);

    const control = meaningful.some(statement => {
        let words = leadingWords(statement, 4);
        if (words[0] === "EXPLAIN") {
            words = words[1] === "QUERY" && words[2] === "PLAN" ? words.slice(3) : words.slice(1);
        }
        return CONTROL_KEYWORDS.has(words[0]);
    });

    return { count: meaningful.length, control, malformed };

}

/** Pernyataan kontrol transaksi pada SQL teks. */
function isTransactionControl(sql) {
    return inspectSql(sql).control;
}

/** Galat bila SQL publik memuat kontrol transaksi atau malformed; null bila boleh. */
function refusePublicSql(sql) {

    const { control, malformed } = inspectSql(sql);

    if (malformed) {
        return dbError(CODES.MALFORMED_SQL, "unterminated string literal, identifier, or comment");
    }
    if (control) {
        return dbError(CODES.TX_CONTROL, "DATABASE_TRANSACTION_CONTROL_FORBIDDEN: Transaction lifecycle statements (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE) are owned by Database.transaction, not direct SQL");
    }

    return null;

}

/** Validasi token kepemilikan internal agar tidak bisa dipalsukan oleh pemanggil publik. */
function assertInternalLifecycleToken(token, expectedDb) {

    if (
        !token ||
        typeof token !== "object" ||
        token[INTERNAL_LIFECYCLE_BRAND] !== true ||
        token.db !== expectedDb ||
        expectedDb.isPoisoned ||
        expectedDb.isClosed
    ) {
        throw dbError(CODES.TX_CONTROL, "DATABASE_TRANSACTION_CONTROL_FORBIDDEN: internal lifecycle token is invalid, foreign, or stale");
    }

}

/** Galat bila SQL tidak boleh lewat capability; null bila boleh. */
function refuseCapabilitySql(sql) {

    const { count, control, malformed } = inspectSql(sql);

    if (malformed) {
        return dbError(CODES.MALFORMED_SQL, "unterminated string literal or identifier");
    }
    if (control) {
        return dbError(CODES.TX_CONTROL, "BEGIN/COMMIT/ROLLBACK/SAVEPOINT are owned by Database.transaction, not the capability");
    }
    if (count > 1) {
        return dbError(CODES.MULTI_STATEMENT, `one statement per capability call, got ${count}`);
    }

    return null;

}

/* ------------------------------ span (R6) -------------------------------- */

/**
 * Span satu transaksi. Operasinya berurutan (FIFO).
 *
 * Status hidup: ACTIVE → COMPLETED | EXPIRED | FAILED (satu transisi terminal).
 * `sealed` menolak operasi baru tanpa membatalkan yang sudah diantre; `finishing`
 * menandai COMMIT/ROLLBACK, yang tidak bisa lagi kedaluwarsa.
 */
class Span {

    #gate;
    #state = SPAN_STATE.ACTIVE;
    #sealed = false;
    #finishing = false;
    #chain = Promise.resolve();

    constructor(gate) {
        this.#gate = gate;
    }

    get gate() {
        return this.#gate;
    }

    get state() {
        return this.#state;
    }

    /** Sudah selesai dalam arti apa pun (COMPLETED / EXPIRED / FAILED). */
    isEnded() {
        return this.#state !== SPAN_STATE.ACTIVE;
    }

    /** Batas deadline. Span yang sedang COMMIT/ROLLBACK tidak bisa kedaluwarsa. */
    expire() {
        if (this.#state !== SPAN_STATE.ACTIVE || this.#finishing) {
            return false;
        }
        this.#state = SPAN_STATE.EXPIRED;
        return true;
    }

    /** Transisi terminal pertama yang menang. */
    conclude(state) {
        if (this.#state === SPAN_STATE.ACTIVE) {
            this.#state = state;
        }
    }

    seal() {
        this.#sealed = true;
    }

    /** Hanya span ACTIVE yang belum disegel boleh mulai COMMIT/ROLLBACK. */
    beginFinish() {
        if (this.#state !== SPAN_STATE.ACTIVE || this.#sealed || this.#finishing) {
            return false;
        }
        this.#finishing = true;
        return true;
    }

    /** Antrekan operasi penyimpanan di belakang operasi span sebelumnya. */
    enqueue(work, { closing = false } = {}) {

        const ctx = SPAN_CONTEXT.getStore();

        // Capability span lain yang masih hidup pada konteks ini: tolak.
        if (ctx && ctx.span !== this && !ctx.span.isEnded()) {
            return Promise.reject(dbError(CODES.FOREIGN, "transaction capability belongs to another open span"));
        }

        // Diperiksa saat dipanggil, bukan saat dijalankan: operasi yang sudah
        // diterima sebelum deadline tetap jalan dan di-rollback di exit span.
        const usable = closing ? this.#finishing : (!this.#sealed && this.#state === SPAN_STATE.ACTIVE);
        if (!usable) {
            return Promise.reject(dbError(CODES.EXPIRED, `transaction capability is no longer usable (span ${this.#state})`));
        }

        const run = this.#chain.then(async () => work(await this.#gate.ensure()));

        this.#chain = run.then(noop, noop);

        return run;

    }

    /** Tunggu operasi penyimpanan yang sudah diantre. Tidak menunggu kerja pengguna. */
    drain() {
        return this.#chain;
    }

}

/**
 * Capability transaksi yang diberikan ke callback. Opaque: tidak bisa
 * diserialisasi dan mati setelah span selesai.
 */
class TransactionScope {

    #span;

    constructor(span) {
        this.#span = span;
    }

    run(sql, params = []) {
        return this.#statement(sql, db => runOn(db, sql, params));
    }

    get(sql, params = []) {
        return this.#statement(sql, db => getOn(db, sql, params));
    }

    all(sql, params = []) {
        return this.#statement(sql, db => allOn(db, sql, params));
    }

    exec(sql) {
        return this.#statement(sql, db => execOn(db, sql));
    }

    toJSON() {
        throw dbError(CODES.EXPIRED, "transaction capability is not serializable");
    }

    #statement(sql, work) {

        const refusal = refuseCapabilitySql(sql);
        if (refusal) {
            return Promise.reject(refusal);
        }

        return this.#span.enqueue(work);

    }

    /** BEGIN IMMEDIATE dengan retry terbatas bila kunci tulis sibuk. */
    async [BEGIN](token, dbInstance) {

        assertInternalLifecycleToken(token, dbInstance);

        for (let attempt = 1; ; attempt += 1) {

            try {
                await this.#span.enqueue(db => runOn(db, "BEGIN IMMEDIATE", []));
                return;
            }
            catch (error) {

                const busy = error?.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(String(error?.message ?? ""));

                if (!busy) {
                    throw error;
                }

                if (attempt >= BUSY_ATTEMPTS) {
                    throw dbError(CODES.BEGIN_BUSY, "write lock not acquired");
                }

                await new Promise(resolve => setTimeout(resolve, 10 * attempt));

            }

        }

    }

    /**
     * COMMIT. Sukses hanya bila SQLite melaporkan COMMIT selesai. Gagal = hasil
     * tidak terbukti, jadi instance di-poison dan pemanggil tidak menerima sukses.
     */
    async [COMMIT](token, dbInstance) {

        assertInternalLifecycleToken(token, dbInstance);

        const span = this.#span;

        if (!span.beginFinish()) {
            throw dbError(CODES.EXPIRED, "span ended before COMMIT; the transaction is rolled back at span exit");
        }

        try {
            await span.enqueue(db => runOn(db, "COMMIT", []), { closing: true });
        }
        catch (error) {
            await span.gate.poison(error);
            throw dbError(CODES.COMMIT_FAILED, "COMMIT did not complete; the outcome is unverified, so the write is not acknowledged. Database instance poisoned; create a new Database instance", error);
        }

    }

    /**
     * ROLLBACK setelah callback gagal. "no transaction is active" = sudah bersih.
     * Kegagalan lain = hasil tidak terbukti; instance di-poison dan error asli
     * tetap dilampirkan, tidak ditelan.
     */
    async [ROLLBACK](token, dbInstance, callbackError) {

        assertInternalLifecycleToken(token, dbInstance);

        const span = this.#span;

        // Span sudah berakhir (mis. deadline): exit span yang melakukan ROLLBACK dan memverifikasi.
        if (!span.beginFinish()) {
            return;
        }

        try {
            await span.enqueue(db => runOn(db, "ROLLBACK", []), { closing: true });
        }
        catch (error) {

            if (/no transaction is active/i.test(String(error?.message ?? ""))) {
                return;
            }

            await span.gate.poison(error);

            throw Object.assign(dbError(CODES.ROLLBACK_FAILED, `ROLLBACK failed after callback error (${callbackError?.message ?? "unknown"}). Transaction outcome unknown, so it is not reported as rolled back. Database instance poisoned; create a new Database instance`, error), { callbackError });

        }

    }

}

/**
 * Gerbang kepemilikan koneksi. Dipakai bersama oleh backend SQLite dan
 * backend memori (`createMemoryAccStore`) agar kontrak transaksi identik.
 *
 *   - operasi unscoped mengantre FIFO; dari dalam span hidup milik gerbang ini
 *     ia DITOLAK sebelum menyentuh data;
 *   - dari dalam span yang sudah berakhir (provenance) ia DITOLAK juga, sebelum
 *     antrean: callback zombie tidak boleh menyentuh database;
 *   - span memegang antrean; keluar span: seal → drain → settle → conclude;
 *   - kerja melebihi `spanDeadlineMs` dipaksa berakhir (antrean dilepas);
 *   - COMMIT/ROLLBACK tidak terbukti, atau settle gagal = poison.
 */
class TransactionGate {

    #open;
    #settle;
    #release;
    #deadlineMs;
    #queue = Promise.resolve();
    #poisoned = null;

    /**
     * @param {object} hooks
     * @param {() => Promise<*>} hooks.open  siapkan koneksi, kembalikan handle-nya
     * @param {(connection: *) => Promise<boolean>} hooks.settle  pastikan tidak ada
     *        transaksi tersisa; true bila ada yang terbuka dan sudah di-rollback
     * @param {() => Promise<void>} [hooks.release]  lepaskan handle native saat poison
     */
    constructor({ open, settle, release = async () => {}, spanDeadlineMs = DEFAULT_SPAN_DEADLINE_MS }) {
        this.#open = open;
        this.#settle = settle;
        this.#release = release;
        this.#deadlineMs = spanDeadlineMs;
    }

    get poisonError() {
        return this.#poisoned;
    }

    ensure() {
        if (this.#poisoned) {
            return Promise.reject(this.#poisoned);
        }
        return this.#open();
    }

    /**
     * Instance tidak terbukti bersih: tandai poisoned selamanya dan lepaskan
     * handle. Bila pelepasan gagal, instance tetap poisoned (tanpa reuse).
     */
    async poison(cause) {

        if (this.#poisoned) {
            return;
        }

        this.#poisoned = dbError(CODES.POISONED, "database instance is poisoned: transaction state is unknown, so this instance is never used again; create a new Database instance", cause);

        try {
            await this.#release();
        }
        catch {
            // Handle dipertahankan; close() bisa mencoba lagi. Instance tetap poisoned.
        }

    }

    /** Antrean koneksi: satu unit kerja berjalan setelah unit sebelumnya selesai. */
    acquire(work, { closing = false } = {}) {

        const run = this.#queue.then(() => {
            if (this.#poisoned && !closing) {
                throw this.#poisoned;
            }
            return work();
        });

        this.#queue = run.then(noop, noop);

        return run;

    }

    /** Span milik gerbang ini pada konteks async saat ini (provenance), atau null. */
    #ambient() {
        const ctx = SPAN_CONTEXT.getStore();
        return ctx && ctx.gate === this ? ctx.span : null;
    }

    /** Penolakan untuk panggilan dari dalam span; null bila panggilan boleh. */
    #refusal(exclusive) {

        const span = this.#ambient();

        if (!span) {
            return null;
        }

        // R6-F2: EXPIRED / FAILED span callbacks are zombies. A COMPLETED span's callback created
        // later is an ordinary external caller (R4 contract); the residual is listed in the evidence.
        if (span.state === SPAN_STATE.EXPIRED) {
            return dbError(CODES.SPAN_EXPIRED, "span expired; its callbacks have no database access. The callback may still run, but it cannot reach the database");
        }

        if (span.state === SPAN_STATE.FAILED) {
            return dbError(CODES.SPAN_ENDED, "span failed; its callbacks have no database access");
        }

        if (span.state === SPAN_STATE.COMPLETED) {
            return null;
        }

        return exclusive
            ? dbError(CODES.REENTRANT, "exclusive span cannot be nested inside an open transaction")
            : dbError(CODES.UNSCOPED, "plain Database call inside an open transaction; use the transaction capability");

    }

    unscoped(work, { closing = false } = {}) {

        const refusal = this.#refusal(false);
        if (refusal) {
            return Promise.reject(refusal);
        }

        return this.acquire(async () => work(closing ? null : await this.ensure()), { closing });

    }

    exclusive(work) {

        const refusal = this.#refusal(true);
        if (refusal) {
            return Promise.reject(refusal);
        }

        return this.acquire(() => this.#runSpan(work));

    }

    async #runSpan(work) {

        const span = new Span(this);
        const ctx = { gate: this, span };

        let timer;

        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                if (span.expire()) {
                    reject(dbError(
                        CODES.DEADLINE,
                        `span exceeded ${this.#deadlineMs} ms; queued callers released`
                    ));
                }
            }, this.#deadlineMs);
        });

        // Kerja yang terlambat tidak boleh menjadi unhandled rejection setelah deadline.
        const attempt = SPAN_CONTEXT.run(ctx, () => Promise.resolve().then(() => work(span)));
        attempt.catch(noop);

        let value;
        let failure = null;

        try {
            value = await Promise.race([attempt, deadline]);
        }
        catch (error) {
            failure = error;
        }
        finally {
            clearTimeout(timer);
        }

        span.seal();

        await span.drain();

        let dangling = false;

        if (!this.#poisoned) {
            try {
                dangling = await this.#settle(await this.ensure());
            }
            catch (error) {
                await this.poison(error);
                failure = this.#poisoned;
            }
        }

        if (this.#poisoned) {
            failure = failure ?? this.#poisoned;
        }

        span.conclude(failure ? SPAN_STATE.FAILED : SPAN_STATE.COMPLETED);

        if (failure) {
            throw failure;
        }

        if (dangling) {
            throw dbError(CODES.DANGLING, "span exited with an open transaction; it was rolled back");
        }

        return value;

    }

}

class Database {

    #closed = false;
    #lifecycleToken;

    constructor(file, { spanDeadlineMs = DEFAULT_SPAN_DEADLINE_MS } = {}) {

        this.file = file;

        this.db = null;

        this.ready = null;

        this.#lifecycleToken = Object.freeze({
            [INTERNAL_LIFECYCLE_BRAND]: true,
            db: this
        });

        this.gate = new TransactionGate({
            open: () => this.ensure(),
            settle: settleConnection,
            release: () => this.#closeHandle({ keepOnError: true }),
            spanDeadlineMs
        });

    }

    get isPoisoned() {
        return this.gate.poisonError !== null;
    }

    get isClosed() {
        return this.#closed || (this.ready !== null && this.db === null);
    }

    /**
     * Operasi tanpa capability. Ditolak bila dipanggil dari konteks span yang
     * masih hidup (sebelum menyentuh database) atau sudah berakhir; selain itu
     * mengantre di belakang pemilik koneksi.
     */
    unscoped(work) {
        return this.gate.unscoped(work);
    }

    /**
     * Ambil kepemilikan koneksi untuk satu span. Hanya operasi lewat `tx`
     * yang menjadi anggota span ini.
     */
    exclusive(work) {
        return this.gate.exclusive(span => work(new TransactionScope(span)));
    }

    open() {

        if (this.gate.poisonError) {
            return Promise.reject(this.gate.poisonError);
        }

        if (this.ready) {
            return this.ready;
        }

        this.ready = new Promise((resolve, reject) => {

            fs.mkdirSync(path.dirname(this.file), { recursive: true });

            this.db = new sqlite3.Database(this.file, error => {

                if (error) {
                    return reject(error);
                }

                resolve(this.db);

            });

        }).then(async () => {

            // Beri kesempatan menunggu kunci alih-alih langsung
            // melempar SQLITE_BUSY. Harus PERTAMA: pragma berikutnya
            // berjalan di bawah timeout ini.
            await this.execRaw("PRAGMA busy_timeout = 5000");

            // WAL: pembaca tidak memblokir penulis. Penting karena
            // Console membaca memori sambil daemon terus menulis
            // observasi dari sensor/CCTV.
            //
            // A BRAND-NEW file opened by N processes at once can STILL raise
            // SQLITE_BUSY on the WAL transition (busy_timeout does not cover
            // every schema change), so the whole pragma sequence is retried on
            // busy. Without this a cold-start race surfaces as a raw
            // SQLITE_BUSY to the caller.
            for (let attempt = 1; ; attempt += 1) {

                try {

                    await this.execRaw("PRAGMA journal_mode = WAL");

                    await this.execRaw("PRAGMA synchronous = NORMAL");

                    await this.execRaw("PRAGMA foreign_keys = ON");

                    return this.db;

                } catch (error) {

                    const busy = error?.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(String(error?.message ?? ""));

                    if (!busy || attempt >= BUSY_ATTEMPTS) {

                        throw error;

                    }

                    await new Promise(resolve => setTimeout(resolve, 10 * attempt));

                }

            }

        }).catch(async error => {

            // P3-2: a failed initialization must never publish a handle that
            // looks usable. Invalidate the instance FIRST (so no observer can
            // see a half-open handle), then close the incomplete connection
            // best-effort. Clearing the cached open promise means a later
            // open() starts a fresh bounded attempt; fail-loud is preserved
            // because the error is still thrown to every caller waiting here.
            const handle = this.db;

            this.db = null;
            this.ready = null;

            if (handle) {
                // Best-effort, non-blocking: the instance is already
                // invalidated, so a slow or failed close must not stall the
                // failure path (nor hide the original error).
                try { handle.close(() => {}); } catch { /* best effort */ }
            }

            throw error;

        });

        return this.ready;

    }

    async ensure() {

        if (!this.db) {
            await this.open();
        }

        return this.db;

    }

    run(sql, params = []) {
        const refusal = refusePublicSql(sql);
        if (refusal) {
            return Promise.reject(refusal);
        }
        return this.unscoped(db => runOn(db, sql, params));
    }

    get(sql, params = []) {
        const refusal = refusePublicSql(sql);
        if (refusal) {
            return Promise.reject(refusal);
        }
        return this.unscoped(db => getOn(db, sql, params));
    }

    all(sql, params = []) {
        const refusal = refusePublicSql(sql);
        if (refusal) {
            return Promise.reject(refusal);
        }
        return this.unscoped(db => allOn(db, sql, params));
    }

    exec(sql) {
        const refusal = refusePublicSql(sql);
        if (refusal) {
            return Promise.reject(refusal);
        }
        return this.unscoped(db => execOn(db, sql));
    }

    /** exec tanpa antrean; hanya untuk pemanggil yang sudah memegang koneksi. */
    execRaw(sql) {
        const refusal = refusePublicSql(sql);
        if (refusal) {
            return Promise.reject(refusal);
        }
        return execOn(this.db, sql);
    }

    /**
     * Jalankan sekumpulan operasi dalam satu transaksi. Database memiliki
     * BEGIN IMMEDIATE, COMMIT, dan ROLLBACK; callback hanya menerima `tx`.
     *
     * Sukses callback = COMMIT selesai lebih dulu, baru resolve. Callback gagal
     * = ROLLBACK, lalu error asli dilempar. ROLLBACK atau COMMIT yang gagal
     * tidak pernah dilaporkan sebagai sukses: instance di-poison
     * (DB_TX_ROLLBACK_FAILED / DB_TX_COMMIT_FAILED).
     *
     * Dipakai saat menyimpan memori: baris memories, kaitan
     * entitas, dan indeks FTS harus masuk bersama-sama — memori
     * yang tersimpan tapi tidak terindeks sama saja hilang.
     */
    transaction(work) {

        const token = this.#lifecycleToken;

        return this.exclusive(async tx => {

            await tx[BEGIN](token, this);

            let result;

            try {
                result = await work(tx);
            }
            catch (error) {
                await tx[ROLLBACK](token, this, error);
                throw error;
            }

            await tx[COMMIT](token, this);

            return result;

        });

    }

    close() {
        this.#closed = true;
        return this.gate.unscoped(() => this.#closeHandle({ keepOnError: this.gate.poisonError !== null }), { closing: true });
    }

    /**
     * Tutup handle native. Transaksi yang belum selesai dibuang SQLite saat
     * koneksi ditutup, sehingga kunci tulis ikut lepas. Dengan keepOnError,
     * kegagalan menutup mempertahankan handle agar bisa dicoba lagi.
     */
    #closeHandle({ keepOnError }) {

        const handle = this.db;

        if (!handle) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => handle.close(error => {

            if (error && keepOnError) {
                return reject(error);
            }

            this.db = null;
            this.ready = null;
            resolve();

        }));

    }

}

/**
 * Pastikan koneksi tanpa transaksi. ROLLBACK di luar transaksi gagal dengan
 * "no transaction is active"; itu tanda bersih. Sisa transaksi di-rollback
 * dan dilaporkan (true). Kegagalan lain = keadaan tidak pasti (throw).
 */
async function settleConnection(db) {

    try {
        await execOn(db, "ROLLBACK");
        return true;
    }
    catch (error) {
        if (/no transaction is active/i.test(String(error?.message ?? ""))) {
            return false;
        }
        throw error;
    }

}

function runOn(db, sql, params) {

    return new Promise((resolve, reject) => {

        db.run(sql, params, function (error) {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve({
                lastID: this.lastID,
                changes: this.changes
            });

        });

    });

}

function getOn(db, sql, params) {

    return new Promise((resolve, reject) => {

        db.get(sql, params, (error, row) => {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve(row ?? null);

        });

    });

}

function allOn(db, sql, params) {

    return new Promise((resolve, reject) => {

        db.all(sql, params, (error, rows) => {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve(rows ?? []);

        });

    });

}

function execOn(db, sql) {

    return new Promise((resolve, reject) => {

        db.exec(sql, error => {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve();

        });

    });

}

/** Sertakan potongan SQL pada error agar mudah dilacak. */
function decorate(error, sql) {

    error.message = `${error.message} — SQL: ${
        String(sql).replace(/\s+/g, " ").trim().slice(0, 160)
    }`;

    return error;

}

module.exports = Database;
module.exports.CODES = CODES;
module.exports.TransactionGate = TransactionGate;
module.exports.dbError = dbError;
module.exports.isTransactionControl = isTransactionControl;
module.exports.splitStatements = splitStatements;
module.exports.inspectSql = inspectSql;
module.exports.refusePublicSql = refusePublicSql;
