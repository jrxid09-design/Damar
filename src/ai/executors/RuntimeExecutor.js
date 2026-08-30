const ToolExecutor = require("../tools/ToolExecutor");
const ArgumentValidator = require("../tools/ArgumentValidator");
const SchemaMinimizer = require("../tools/SchemaMinimizer");
const Budget = require("../tools/Budget");
const { TurnController } = require("../tools/TurnController");
const toolStats = require("../tools/ToolStats");
const { canonicalRequestExec } = require("../runtime/requestIdentity");
const { createInternalGrantDomain } = require("../tools/internalGrant");
const executorGrantDomains = new WeakMap();

/**
 * Menjalankan satu request AI sampai selesai, termasuk
 * loop tool-calling: model meminta tool -> tool dieksekusi ->
 * hasilnya dikembalikan ke model -> ulangi sampai model
 * menjawab tanpa tool call.
 */
class RuntimeExecutor {

    constructor(service, options = {}) {

        this.service = service;

        this.toolRegistry = null;

        this.toolExecutor = null;

        this.maxToolIterations =
            options.maxToolIterations ?? Number.MAX_SAFE_INTEGER;

        /**
         * Batas untuk SATU panggilan model, bukan untuk seluruh loop.
         *
         * Loop tool bisa berputar beberapa kali, dan tiap putaran
         * adalah panggilan inferensi yang utuh. Membatasi totalnya
         * membuat tugas yang memakai banyak tool selalu kalah dari
         * jam, betapapun sehatnya ia berjalan.
         */
        this.callTimeout =
            options.callTimeout ?? 120000;

        this.events = options.events ?? null;

        this.logger = options.logger ?? null;

        const grantDomain = options.grantDomain ?? createInternalGrantDomain();
        if (!grantDomain || typeof grantDomain.isCanonicalInternalGrant !== "function" ||
            typeof grantDomain.isToolAuthorizedByGrant !== "function") {
            throw new TypeError("invalid trusted execution grant domain");
        }
        executorGrantDomains.set(this, grantDomain);

    }

    setToolRegistry(registry) {

        this.toolRegistry = registry;

        this.toolExecutor =
            new ToolExecutor(registry);

        return this;

    }

    /**
     * Catatan langkah yang berjalan (Â§29, Â§30).
     *
     * Loop tool di bawah ini tidak menyimpan apa pun: bila proses
     * mati di tengah rantai panjang, tak ada satu pun jejak tentang
     * apa yang sudah terlanjur dikerjakan â€” pesan yang sudah
     * terkirim, berkas yang sudah tertulis. Checkpoint per langkah
     * membuat sisa pekerjaan itu dapat dibaca setelah proses hidup
     * lagi, alih-alih hilang tanpa bekas.
     *
     * Seluruhnya dibungkus try/catch: gagal mencatat tidak boleh
     * menjatuhkan permintaan yang sedang dilayani.
     */
    startPlan(request) {

        try {

            const ExecutionPlan = require("../../agent/models/executionPlan");

            const terakhir = [...(request.messages ?? [])]
                .reverse()
                .find(m => m.role === "user");

            return new ExecutionPlan({
                goal: String(terakhir?.content ?? "").slice(0, 200),
                thought: "runtime tool loop"
            });

        }
        catch {
            return null;
        }

    }

    checkpoint(plan) {

        if (!plan) return;

        try {
            require("../../agent/planStore").save(plan);
        }
        catch { /* checkpoint bersifat tambahan, bukan syarat */ }

    }

    /**
     * Rencana yang tuntas tidak perlu ditinggalkan sebagai puing.
     *
     * Sengaja HANYA dipanggil di jalur tuntas. Permintaan yang
     * berakhir dengan galat (batas iterasi, penjaga loop liar, tool
     * gagal) justru wajib meninggalkan checkpoint-nya: itulah satu-
     * satunya jejak tentang apa yang sempat terlanjur dikerjakan
     * (Â§30). Puing yang dulu menumpuk di data/plans/ bukan berasal
     * dari sini melainkan dari rencana yang setiap langkahnya `done`
     * namun berkasnya tak sempat terhapus â€” dibereskan di
     * planStore.unfinished().
     */
    finishPlan(plan) {

        if (!plan) return;

        try {
            require("../../agent/planStore").remove(plan.id);
        }
        catch { /* diabaikan */ }

    }

    async execute(request) {

        // H1/CLOSURE: identitas kanonik juga untuk pemakaian executor
        // langsung — loop tool (executeTools → request.exec) dan
        // deferred disclosure memakai identitas yang SAMA dengan
        // disklosur awal; capabilitySet tidak pernah tertinggal di sini.
        const domain = executorGrantDomains.get(this);
        request.exec = domain.isCanonicalInternalGrant(request.exec)
            ? request.exec
            : canonicalRequestExec(request);

        const plan = this.startPlan(request);

        // Anggaran giliran: panggilan/waktu/pembatalan (di atas loopGuard).
        const controller = new TurnController({ signal: request.signal });

        let iterations = 0;

        // Model gratis (dan kadang lokal saat sibuk) sesekali
        // membalas kosong â€” tanpa isi, tanpa tool call. Alih-alih
        // meneruskan hampa itu ke pengguna, coba ulang beberapa
        // kali; percobaan berikutnya biasanya berhasil.
        let emptyRetries = 0;
        const maxEmptyRetries = 2;
        let lastFingerprint = null;
        let repeatCount = 0;
        const maxRepeat = 4;

        while (iterations++ < this.maxToolIterations) {

            controller.assertCanContinue();

            const response =
                await this.callModel(request, iterations);

            if (!response.toolCalls?.length) {

                const isEmpty =
                    !response.content || !response.content.trim();

                if (isEmpty && emptyRetries < maxEmptyRetries) {

                    emptyRetries++;

                    // Percobaan kosong tidak dihitung sebagai iterasi
                    // tool, jadi loop tidak cepat habis.
                    iterations--;

                    await new Promise(resolve =>
                        setTimeout(resolve, 400 * emptyRetries)
                    );

                    continue;

                }

                this.finishPlan(plan);

                return response;

            }

            // MODEL TOOL CALL != AUTHORITY. Provider output is untrusted;
            // only the canonical in-process grant may cross this final sink.
            // Empty/omitted tools, role, and channel are never permission.
            const calls = response.toolCalls || [];
            if (!domain.isCanonicalInternalGrant(request.exec) ||
                !calls.every(call => domain.isToolAuthorizedByGrant(
                    request.exec, call.name || call.function?.name))) {
                this.finishPlan(plan);
                return { ...response, toolCalls: [], finishReason: response.finishReason ?? "stop" };
            }

            const fingerprint = JSON.stringify(
                (response.toolCalls || []).map(call => [
                    call.name || call.function?.name,
                    call.arguments || call.function?.arguments
                ])
            );
            if (fingerprint === lastFingerprint) {
                repeatCount++;
                if (repeatCount >= maxRepeat) {
                    throw new Error(
                        "Damar terdeteksi memanggil tool yang sama berulang " +
                        "tanpa hasil baru, jadi dihentikan agar tidak loop liar. " +
                        "Perintah terakhir: " + fingerprint
                    );
                }
            } else {
                lastFingerprint = fingerprint;
                repeatCount = 0;
            }

            if (!this.toolExecutor) {

                throw new Error(
                    "Model requested a tool call but no tool registry is configured."
                );

            }

            const results =
                await this.executeTools(response, plan, controller, request.exec);

            this.appendToolMessages(

                request,

                response,

                results

            );

            // Disclosure: tool_search berhasil → lampirkan schema
            // tool yang ditemukan pada putaran berikutnya.
            this.discloseFromResults(request, results);

            // Anggaran giliran habis → hentikan dengan jawaban yang
            // jujur, bukan melempar dan membuang kerja sejauh ini.
            if (controller.stopRequested) {
                this.finishPlan(plan);
                return {
                    content: controller.stopReason,
                    toolCalls: [],
                    usage: response.usage ?? null
                };
            }

        }

        throw new Error(
            `Maximum tool iterations (${this.maxToolIterations}) exceeded.`
        );

    }

    /**
     * Satu panggilan model, dengan batas waktunya sendiri.
     *
     * Pesan errornya menyebutkan putaran keberapa yang mandek, karena
     * "Request timeout." tanpa konteks tidak memberi tahu apakah
     * modelnya lambat atau loopnya yang terlalu panjang.
     */
    async callModel(request, iteration) {

        if (!(this.callTimeout > 0)) {
            return this.service.chat(request);
        }

        let timer = null;

        const batas = new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(
                    `Model tidak menjawab dalam ${Math.round(this.callTimeout / 1000)} detik ` +
                    `(putaran tool ke-${iteration}).`
                )),
                this.callTimeout
            );
        });

        try {
            return await Promise.race([this.service.chat(request), batas]);
        }
        finally {
            clearTimeout(timer);
        }

    }

    /**
     * Jalankan tool yang diminta model dalam satu putaran.
     *
     * Model kerap meminta beberapa tool sekaligus â€” "cek kamera lalu
     * kirim ke WhatsApp" bisa datang sebagai dua panggilan pada satu
     * balasan. Menjalankannya berurutan berarti menunggu keduanya
     * satu per satu padahal tak saling bergantung.
     *
     * Kesiapan dinilai lewat `plan.ready()`, semantik DAG yang sama
     * dengan perencana â€” bukan aturan kedua yang harus dijaga
     * selaras. Tool aman (baca murni) boleh berjalan bersamaan karena
     * tidak mengubah apa pun; sisanya tetap berurutan, sebab dua
     * tulisan atau dua pesan yang berangkat bersamaan sulit
     * ditelusuri dan bisa saling mendahului.
     */
    async executeTools(response, plan = null, controller = null, exec = null) {

        const calls = response.toolCalls ?? [];

        const riskCatalog = require("../../core/safety/riskCatalog");

        const bacaan = calls.filter(c => riskCatalog.riskOf(c.name) === false);

        // Perlu minimal dua bacaan agar paralel berarti sesuatu.
        if (bacaan.length > 1) {

            const sisa = calls.filter(c => !bacaan.includes(c));

            const hasilBaca = await Promise.all(
                bacaan.map(call => this.runOne(call, plan, controller, exec))
            );

            const hasilSisa = [];
            for (const call of sisa) {
                hasilSisa.push(await this.runOne(call, plan, controller, exec));
            }

            // Urutan asli dipertahankan: model mencocokkan hasil
            // dengan toolCallId, tetapi log yang berloncatan sulit
            // dibaca saat menelusuri.
            const peta = new Map();
            for (const [i, call] of bacaan.entries()) peta.set(call, hasilBaca[i]);
            for (const [i, call] of sisa.entries()) peta.set(call, hasilSisa[i]);

            return calls.map(call => peta.get(call));

        }

        const results = [];

        for (const call of calls) {
            results.push(await this.runOne(call, plan, controller, exec));
        }

        return results;

    }

    /**
     * Satu panggilan tool, tercatat di rencana dan tidak melempar.
     *
     * Urutan gerbang (Phase 6):
     *   anggaran giliran → TOOL_NOT_FOUND → VALIDATION_ERROR
     *   → ToolGuard (POLICY_DENIED bila menolak) → eksekusi berbatas
     *   waktu → klasifikasi EXECUTION_ERROR/TIMEOUT/CANCELLED.
     * Semua kegagalan kembali ke model sebagai {error:{code,...}} —
     * machine-readable, sehingga model bisa memperbaiki panggilannya.
     */
    async runOne(call, plan = null, controller = null, exec = null) {

        this.events?.emit("tool:started", call);

        const step = this.trackStart(plan, call);

        const started = Date.now();

        try {

            if (controller) controller.beginTool(call.name, call.arguments);

            // 1. Tool harus ada (lookup di registry penuh, bukan
            // hanya di daftar schema yang terlihat model).
            const tool = this.toolExecutor?.registry?.get?.(call.name);

            if (!tool) {
                return this.failOne(step, call, controller,
                    ArgumentValidator.make(
                        ArgumentValidator.CODES.TOOL_NOT_FOUND,
                        `Tool '${call.name}' tidak terdaftar. Gunakan tool_search untuk menemukan nama yang benar.`
                    ), started);
            }

            // 2. OTORISASI SEBELUM VALIDASI ARGUMEN (L1/CLOSURE):
            // pemanggil di luar set/peran menerima PERMISSION_DENIED
            // tanpa pernah melihat schema/kebutuhan argumen tool yang
            // dilarangnya. Pemanggil berizin tetap divalidasi normal.
            // Penolakan otorisasi BUKAN penolakan anggaran — ditangkap
            // tersendiri agar loop tool TIDAK berhenti (tanpa
            // stopRequested) dan hasil tetap machine-readable.
            try {
                require("../tools/Authorization")
                    .assertExecution(tool, exec ?? {});
            }
            catch (authError) {
                return this.failOne(step, call, controller, authError, started);
            }

            // 3. Argumen divalidasi SEBELUM menyentuh apa pun.
            const verdict = ArgumentValidator.validate(tool, call.arguments ?? {});

            if (!verdict.ok) {
                return this.failOne(step, call, controller, verdict.error, started);
            }

            call.arguments = verdict.args;

        }
        catch (error) {

            // Penolakan anggaran (MAX_TOOL_CALLS / wall clock / cancel).
            return this.failOne(step, call, controller, error, started,
                { stopRequested: true });

        }

        let result;

        try {

            result = await this.withToolTimeout(
                this.toolExecutor.execute(call, exec),
                call.name
            );

            this.events?.emit("tool:completed", result);

            this.trackDone(plan, step, result);

            controller?.endTool(call.name, null);

            toolStats.record(call.name, true, Date.now() - started);

            return result;

        }

        catch (error) {

            this.events?.emit("tool:failed", {
                call,
                error
            });

            this.trackFailed(plan, step, error);

            return this.failOne(step, call, controller, error, started);

        }

    }

    /** Batas waktu SATU panggilan tool — hang tak boleh menggantung giliran. */
    withToolTimeout(promise, name) {

        const ms = Number(process.env.DAMAR_TOOL_TIMEOUT_MS) || 120_000;

        if (!(ms > 0)) return promise;

        return new Promise((resolve, reject) => {

            const timer = setTimeout(() => {
                reject(ArgumentValidator.make(
                    ArgumentValidator.CODES.TIMEOUT,
                    `Tool '${name}' melebihi ${Math.round(ms / 1000)} detik.`
                ));
            }, ms);

            promise
                .then(v => { clearTimeout(timer); resolve(v); })
                .catch(e => { clearTimeout(timer); reject(e); });

        });

    }

    /** Klasifikasikan error apa pun menjadi kode machine-readable. */
    classify(error) {

        if (!error) return ArgumentValidator.CODES.EXECUTION_ERROR;

        if (error.toolError) return error.code;

        if (error.name === "AbortError") return ArgumentValidator.CODES.CANCELLED;

        const msg = String(error.code ?? "");

        if (/LOOP_DETECTED|REPEATED_FAILURE|KILL_SWITCH|SAFETY_STOP|PATH_DENIED|DENIED/i.test(msg)) {
            return ArgumentValidator.CODES.POLICY_DENIED;
        }

        if (/ETIMEDOUT|timeout/i.test(String(error.message ?? ""))) {
            return ArgumentValidator.CODES.TIMEOUT;
        }

        return ArgumentValidator.CODES.EXECUTION_ERROR;

    }

    /**
     * Susun hasil gagal terstruktur untuk model. Bila kegagalan
     * berasal dari anggaran giliran, tandai controller agar loop
     * berhenti setelah hasil ini dilampirkan.
     */
    failOne(step, call, controller, error, started, opts = {}) {

        const code = this.classify(error);

        // Round-2 (klaim-3): PENOLAKAN bukan kegagalan tool — jangan
        // mencemari reliability rolling dengan noise otorisasi.
        const AUTHZ_NOISE = new Set(["PERMISSION_DENIED", "POLICY_DENIED",
            "CANCELLED", "TOOL_NOT_FOUND"]);

        const countsAgainstReliability = !AUTHZ_NOISE.has(code);

        controller?.endTool(call.name, code);

        if (opts.stopRequested && controller) {
            controller.stopRequested = true;
            controller.stopReason =
                `${error.message}`;
        }

        if (countsAgainstReliability) {
            toolStats.record(call.name, false, Date.now() - started, code);
        }

        return {
            toolCallId: call.id,
            name: call.name,
            result: {
                error: {
                    code,
                    message: String(error.message ?? "tool gagal"),
                    ...(error.details ? { details: error.details } : {})
                }
            }
        };

    }

    /**
     * Disclosure dinamis (Phase 8): hasil tool_search yang sukses
     * membawa direktori nama; schema tool tersebut dilampirkan pada
     * request agar model bisa langsung memanggilnya — tetap dalam
     * anggaran skema, tanpa pernah mengirim seluruh katalog.
     */
    /**
     * Deferred disclosure (invariant F): schema hanya menempel SETELAH
     * lolos GERBANG DISKLOSUR YANG SAMA dengan Pipeline/tool_search
     * (Authorization.disclosureFilter) — identitas dari request.exec.
     * tool_search tidak bisa memperluas otorisasi, hanya meminta.
     */
    discloseFromResults(request, results = []) {

        try {

            const Authorization = require("../tools/Authorization");

            for (const r of results) {

                if (r?.name !== "tool_search") continue;

                const dir = r.result?.directory;

                if (!Array.isArray(dir) || !dir.length) continue;

                const currentNames = new Set((request.tools ?? []).map(t => t.name));

                // Universe kandidat mentah → gerbang disklosur yang sama.
                const rawCandidates = dir
                    .map(entry => this.toolRegistry?.get?.(entry.name))
                    .filter(Boolean);

                const eligible = Authorization.disclosureFilter(
                    rawCandidates,
                    request.exec ?? {}
                );

                const profile = Budget.profileFor(
                    request.exec?.contextTokens ||
                    Number(process.env.DAMAR_MODEL_CONTEXT_TOKENS) ||
                    32768
                );

                const additions = eligible
                    .filter(full => !currentNames.has(full.name))
                    .map(full => SchemaMinimizer.toView(full, profile));

                if (additions.length) {
                    request.tools = [...(request.tools ?? []), ...additions]
                        .slice(0, Budget.HARD_CAP);
                }

            }

        }
        catch { /* disclosure bersifat tambahan; kegagalan tak mengeksekusi apa pun */ }

    }

    // ---- Pencatatan langkah -----------------------------------------
    // Dipisah dari loop supaya jalur eksekusi tetap terbaca, dan
    // supaya setiap kegagalan pencatatan tertahan di sini.

    trackStart(plan, call) {

        if (!plan) return null;

        try {

            const step = plan.addStep({
                tool: call.name,
                arguments: call.arguments ?? {}
            });

            step.status = "running";
            step.startedAt = new Date().toISOString();
            step.attempts += 1;

            this.checkpoint(plan);

            return step;

        }
        catch {
            return null;
        }

    }

    trackDone(plan, step, result) {

        if (!plan || !step) return;

        try {

            step.status = "done";
            step.finishedAt = new Date().toISOString();

            // Bukti, bukan klaim (Â§46) â€” disimpan terpisah dari hasil.
            step.verification = result?.result?.verification ?? null;

            this.checkpoint(plan);

        }
        catch { /* diabaikan */ }

    }

    trackFailed(plan, step, error) {

        if (!plan || !step) return;

        try {

            step.status = "failed";
            step.finishedAt = new Date().toISOString();
            step.error = error?.message ?? String(error);

            this.checkpoint(plan);

        }
        catch { /* diabaikan */ }

    }

    /**
     * Isi pesan hasil tool, dengan batas untuk konten dari luar.
     *
     * Hasil tool adalah vektor injeksi yang sering terlupa (Â§232):
     * halaman web yang diambil `http.get` masuk ke prompt persis
     * seperti perintah pengguna. Membungkusnya membuat model tahu
     * mana data dan mana wewenang.
     *
     * CONTEXT INTELLIGENCE (Phase 6): hasil besar TIDAK boleh
     * terus diwariskan utuh ke setiap iterasi. Kompaksi head+tail
     * dengan penanda ukuran; RAW tidak dibuang — ditulis ke
     * logs/tool-observations/ untuk audit. Observasi identik dalam
     * satu giliran didedupe (model tak perlu membaca salinan sama
     * dua kali).
     */
    boundContent(result, request = null) {

        const raw = typeof result.result === "string"
            ? result.result
            : JSON.stringify(result.result);

        // ---- Dedupe observasi (H5 Round-2): identitas memuat OUTCOME.
        // Sukses & gagal dengan body sama TIDAK setara; kegagalan tidak
        // pernah diganti teks netral — semantik loop/retry tetap utuh.
        const isErrorResult =
            result && typeof result.result === "object" &&
            result.result !== null && "error" in result.result;

        const errorCode = isErrorResult
            ? (result.result.error?.code ?? "ERROR")
            : "OK";

        if (request) {
            try {
                request.__obsFingerprints = request.__obsFingerprints || new Map();

                const fp = `${errorCode}:${result.name}:` +
                    require("../../ai/context/Dedupe").fingerprint(raw);

                if (raw.length > 80) {
                    const seen = request.__obsFingerprints.get(fp);
                    if (seen !== undefined) {

                        if (isErrorResult) return raw;   // gagal: utuh selalu

                        return JSON.stringify({
                            deduped: true,
                            status: "OK",
                            tool: result.name,
                            note: "hasil identik dengan observasi sebelumnya — tidak diulang"
                        });
                    }
                    request.__obsFingerprints.set(fp, true);
                }
            }
            catch { /* dedupe bersifat tambahan */ }
        }

        // ---- Kompaksi hasil raksasa --------------------------------
        const MAX_CHARS = Number(process.env.DAMAR_OBSERVATION_MAX_CHARS) || 4000;

        let content = raw;

        if (raw.length > MAX_CHARS) {
            content = this.compactObservation(result, raw, MAX_CHARS);
        }

        try {

            const boundary = require("../../core/safety/contentBoundary");
            // H8 Round-2: DEFAULT = batas tool (hasil eksekusi = data,
            // bukan otoritas). Peta eksplisit hanya menambah spesifik.
            const kind = boundary.boundaryFor(result.name) ?? "tool";

            return kind
                ? boundary.wrap(kind, content, { source: result.name })
                : content;

        }
        catch {
            // Kegagalan membungkus tidak boleh memutus loop tool.
            return content;
        }

    }

    /**
     * Kompaksi head+tail; raw utuh dipersisten (best-effort) supaya
     * debugging tetap bisa mengakses apa yang SEBENARNYA dikembalikan
     * tool — bukan hanya potongan yang dilihat model.
     */
    compactObservation(result, raw, maxChars) {

        const head = Math.floor(maxChars * 0.7);
        const tail = Math.max(0, maxChars - head - 80);

        let archived = null;

        try {

            const fs = require("node:fs");
            const path = require("node:path");

            const dir = path.join(process.cwd(), "logs", "tool-observations");

            fs.mkdirSync(dir, { recursive: true });

            const safe = String(result.name ?? "tool").replace(/[^a-z0-9_-]/gi, "_");

            const file = path.join(dir, `${Date.now()}-${safe}.txt`);

            fs.writeFileSync(file, raw, "utf8");

            archived = path.relative(process.cwd(), file);

        }
        catch { /* arsip best-effort; kompaksi tetap jalan */ }

        const note =
            `\n[… ${raw.length - head - tail} karakter dipangkas; ` +
            `raw: ${archived ?? "tidak terarsip"} …]\n`;

        return raw.slice(0, head) + note + (tail > 0 ? raw.slice(-tail) : "");

    }

    appendToolMessages(request, response, results) {

        request.messages.push({

            role: "assistant",

            content: response.content ?? "",

            tool_calls:

                response.toolCalls.map(call => ({

                    id: call.id,

                    type: "function",

                    function: {

                        name: call.name,

                        arguments:

                            JSON.stringify(

                                call.arguments

                            )

                    }

                }))

        });

        for (const result of results) {

            request.messages.push({

                role: "tool",

                tool_call_id:
                    result.toolCallId,

                name:
                    result.name,

                content:

                    this.boundContent(result, request)

            });

        }

    }

    /**
     * Streaming SUNGGUHAN dari provider, dengan loop tool tetap hidup.
     *
     * Putaran model dikonsumsi dari service.stream() dan potongan
     * konten diteruskan begitu tiba â€” bukan diputar ulang dari teks
     * yang sudah selesai. Fragmen tool_calls tidak bisa dieksekusi
     * setengah-setengah (argumennya tiba bertahap), jadi ia
     * dikumpulkan dulu; begitu fragmen pertama terlihat, sisa
     * putaran itu milik loop tool. Setelah utuh, pemanggilan
     * diumumkan sebagai satu chunk penuh, dieksekusi lewat
     * ToolExecutor yang sama dengan jalur non-stream, hasilnya
     * dikembalikan ke model, lalu putaran berikutnya mengalir lagi
     * sampai model menjawab tanpa tool.
     */
    async *stream(request) {

        const AIStreamChunk = require("../models/AIStreamChunk");

        // H1/CLOSURE: paritas dengan execute() — streaming bukan hop
        // pelucutan identitas.
        const domain = executorGrantDomains.get(this);
        request.exec = domain.isCanonicalInternalGrant(request.exec)
            ? request.exec
            : canonicalRequestExec(request);

        const plan = this.startPlan(request);

        const controller = new TurnController({ signal: request.signal });

        let iterations = 0;
        let emptyRetries = 0;
        const maxEmptyRetries = 2;
        let lastFingerprint = null;
        let repeatCount = 0;
        const maxRepeat = 4;

        while (iterations++ < this.maxToolIterations) {

            try {
                controller.assertCanContinue();
            }
            catch (error) {
                yield new AIStreamChunk({
                    content: error.message,
                    isTerminal: true
                });
                return;
            }

            const round = yield* this.streamRound(request, iterations);

            if (!round.toolCalls.length) {

                const isEmpty = !round.content || !round.content.trim();

                if (isEmpty && emptyRetries < maxEmptyRetries) {
                    emptyRetries++;
                    iterations--;
                    await new Promise(resolve =>
                        setTimeout(resolve, 400 * emptyRetries)
                    );
                    continue;
                }

                // Penutup untuk konsumen bila provider tidak
                // mengirimkan chunk terminalnya sendiri.
                if (!round.terminalDelivered) {
                    yield new AIStreamChunk({
                        id: round.id,
                        model: round.model,
                        provider: round.provider,
                        delta: "",
                        toolCalls: [],
                        finishReason: round.finishReason ?? "stop",
                        usage: round.usage,
                        done: true
                    });
                }

                this.finishPlan(plan);

                return;

            }

            // Keep streaming parity with execute(): never announce or run a
            // provider tool call without canonical trusted execution context.
            const calls = round.toolCalls || [];
            if (!domain.isCanonicalInternalGrant(request.exec) ||
                !calls.every(call => domain.isToolAuthorizedByGrant(
                    request.exec, call.name || call.function?.name))) {
                this.finishPlan(plan);
                yield new AIStreamChunk({
                    id: round.id,
                    model: round.model,
                    provider: round.provider,
                    delta: "",
                    toolCalls: [],
                    finishReason: "stop",
                    done: true
                });
                return;
            }

            const fingerprint = JSON.stringify(
                (round.toolCalls || []).map(call => [
                    call.name || call.function?.name,
                    call.arguments || call.function?.arguments
                ])
            );
            if (fingerprint === lastFingerprint) {
                repeatCount++;
                if (repeatCount >= maxRepeat) {
                    yield new AIStreamChunk({
                        id: round.id,
                        content:
                            "Aku menghentikan langkah ini karena terdeteksi " +
                            "memanggil tool yang sama berulang tanpa hasil " +
                            "baru (anti loop liar).",
                        isTerminal: true
                    });
                    return;
                }
            } else {
                lastFingerprint = fingerprint;
                repeatCount = 0;
            }

            if (!this.toolExecutor) {
                throw new Error(
                    "Model requested a tool call but no tool registry is configured."
                );
            }

            // Umumkan pemanggilan UTUH â€” bukan fragmen â€” supaya klien
            // bisa menampilkan tool yang benar-benar akan dijalankan.
            yield new AIStreamChunk({
                id: round.id,
                model: round.model,
                provider: round.provider,
                delta: "",
                toolCalls: round.toolCalls,
                finishReason: round.finishReason,
                done: false
            });

            const results =
                await this.executeTools(round, plan, controller, request.exec);

            this.appendToolMessages(request, round, results);

            // Disclosure: tool_search → schema tool terpilih ikut
            // putaran berikutnya.
            this.discloseFromResults(request, results);

            if (controller.stopRequested) {
                this.finishPlan(plan);
                yield new AIStreamChunk({
                    id: round.id,
                    content:
                        "Aku menghentikan langkah ini sesuai batas giliran: " +
                        controller.stopReason,
                    isTerminal: true
                });
                return;
            }

        }

        throw new Error(
            `Maximum tool iterations (${this.maxToolIterations}) exceeded.`
        );

    }

    /**
     * Satu putaran model via streaming: diteruskan live ke konsumen
     * sekaligus diagregasi untuk kebutuhan loop tool.
     *
     * Nilai kembali (hasil `yield*`): { content, toolCalls,
     * finishReason, usage, id, model, provider, terminalDelivered }.
     */
    async *streamRound(request, iteration) {

        const AIStreamChunk = require("../models/AIStreamChunk");

        const fragments = [];

        let content = "";
        let sawToolCall = false;
        let finishReason = null;
        let usage = null;
        let terminalDelivered = false;
        let id = null;
        let model = null;
        let provider = null;

        const source = this.service.stream({
            ...request,
            stream: true
        });

        for await (
            const chunk
            of this.withStreamTimeout(source, iteration)
        ) {

            if (!chunk) {
                continue;
            }

            if (!id && chunk.id) id = chunk.id;
            if (!model && chunk.model) model = chunk.model;
            if (!provider && chunk.provider) provider = chunk.provider;

            if (Array.isArray(chunk.toolCalls) && chunk.toolCalls.length) {
                sawToolCall = true;
                this.mergeToolCallFragments(chunk.toolCalls, fragments);
            }

            if (chunk.delta) {
                content += chunk.delta;
            }

            if (chunk.finishReason != null) {
                finishReason = chunk.finishReason;
            }

            if (chunk.usage) {
                usage = chunk.usage;
            }

            // Setelah fragmen tool terlihat, sisa putaran tidak
            // diteruskan live: konten sesudahnya langka dan milik
            // jalur tool; pemanggilan utuh akan diumumkan sendiri.
            if (sawToolCall) {
                continue;
            }

            // Chunk terminal (finish_reason/usage) ditahan sampai
            // putaran terbukti tanpa tool, supaya putaran kosong
            // bisa dicoba ulang tanpa pernah menulis "selesai".
            const isTerminal =
                chunk.finishReason != null || chunk.done || chunk.usage;

            if (chunk.delta || chunk.reasoning) {
                yield chunk;
                if (isTerminal) {
                    terminalDelivered = true;
                }
            }

        }

        return {
            content,
            toolCalls: this.finalizeToolCalls(fragments),
            finishReason,
            usage,
            id,
            model,
            provider,
            terminalDelivered
        };

    }

    /**
     * Batas waktu berlaku per PANGGILAN MODEL dengan jendela yang
     * direset tiap chunk tiba: stream yang sehat boleh lama asal
     * terus mengalir; yang menggantung diam-diam diputus.
     */
    async *withStreamTimeout(stream, iteration) {

        if (!(this.callTimeout > 0)) {
            yield* stream;
            return;
        }

        const iterator = stream[Symbol.asyncIterator]();

        try {

            while (true) {

                let timer = null;

                const deadline = new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(
                            `Model tidak menjawab dalam ${Math.round(this.callTimeout / 1000)} detik ` +
                            `(putaran tool ke-${iteration}).`
                        )),
                        this.callTimeout
                    );
                });

                let next;

                try {
                    next = await Promise.race([
                        iterator.next(),
                        deadline
                    ]);
                }
                finally {
                    clearTimeout(timer);
                }

                if (next.done) {
                    return;
                }

                yield next.value;

            }

        }
        finally {
            // Tutup stream provider bila kita keluar lebih awal
            // (timeout, error, atau konsumen membatalkan). Jangan
            // menunggu: stream yang menggantung justru sumber
            // timeouts ini â€” menggantung menunggu penutupannya
            // membatalkan batas waktu yang baru saja menang.
            const closing = iterator.return?.();
            if (closing && typeof closing.then === "function") {
                Promise.resolve(closing).catch(() => {});
            }
        }

    }

    /**
     * Kumpulkan fragmen tool_calls streaming.
     *
     * Dua bentuk bisa tiba: fragmen mentah OpenAI-compatible
     * ({ index, id, function:{ name, arguments } } dengan argumen
     * string yang menyambung antar chunk) atau panggilan utuh
     * bentuk AIToolCall (mapper lokal memetakan sejak awal).
     */
    mergeToolCallFragments(chunkToolCalls, fragments) {

        for (const call of chunkToolCalls) {

            if (!call) {
                continue;
            }

            if (call.function) {

                const key = Number.isInteger(call.index)
                    ? call.index
                    : `raw-${fragments.length}`;

                let fragment = fragments.find(f => f.key === key);

                if (!fragment) {
                    fragment = { key, raw: true, id: null, name: "", args: "" };
                    fragments.push(fragment);
                }

                if (call.id) {
                    fragment.id = call.id;
                }

                if (call.function.name && !fragment.name) {
                    fragment.name = call.function.name;
                }

                if (call.function.arguments) {
                    fragment.args += call.function.arguments;
                }

                continue;

            }

            // Panggilan utuh: id-nya kunci; argumen objek digabung
            // dangkal bila provider mengirim ulang bertahap.
            const key = call.id ?? `obj-${fragments.length}`;

            let fragment = fragments.find(f => f.key === key);

            if (!fragment) {
                fragment = { key, raw: false, id: call.id ?? null, name: call.name ?? "", args: call.arguments ?? {} };
                fragments.push(fragment);
                continue;
            }

            if (typeof call.arguments === "string") {
                fragment.args =
                    (typeof fragment.args === "string"
                        ? fragment.args
                        : JSON.stringify(fragment.args ?? {})) +
                    call.arguments;
            }
            else if (call.arguments && typeof call.arguments === "object") {
                fragment.args = {
                    ...(typeof fragment.args === "object" && fragment.args
                        ? fragment.args
                        : {}),
                    ...call.arguments
                };
            }

        }

    }

    /** Fragmen terkumpul menjadi AIToolCall siap eksekusi. */
    finalizeToolCalls(fragments) {

        return fragments.map((fragment, index) => new (require("../tools/AIToolCall"))({
            id: fragment.id ?? `call-stream-${Date.now()}-${index}`,
            name: fragment.name,
            arguments: typeof fragment.args === "string"
                ? this.parseArguments(fragment.args)
                : (fragment.args ?? {})
        }));

    }

            parseArguments(args) {

        if (!args) {
            return {};
        }

        if (typeof args === "object" && args !== null) {
            return args;
        }

        try {
            return JSON.parse(args);
        }
        catch (err) {
            // Perbaikan argumen rusak â€” dulu ditelan senyap menjadi {}.
            const escCtrl = (s) => {
                let out = "", inStr = false, esc = false;
                for (const ch of s) {
                    if (esc) { out += ch; esc = false; continue; }
                    if (ch === "\\") { out += ch; esc = true; continue; }
                    if (ch === '"') { inStr = !inStr; out += ch; continue; }
                    if (inStr) {
                        if (ch === "\n") out += "\\n";
                        else if (ch === "\r") out += "";
                        else if (ch === "\t") out += "\\t";
                        else out += ch;
                    } else out += ch;
                }
                return out;
            };
            let text = String(args).trim();
            const block = text.match(/\{[\s\S]*\}/);
            if (block) text = block[0];
            // Backslash Windows tak ter-escape (C:\Users\...) -> C:/Users/... (aman di Node).
            text = text
                .replace(/\\\\/g, "\u0000")
                .replace(/\\(?!"\\\/bfnrtu\u0000])/g, "/")
                .replace(/\u0000/g, "\\\\");
            // Koma menggantung sebelum } atau ].
            text = text.replace(/,\s*([}\]])/g, "$1");
            try {
                const parsed = JSON.parse(text);
                console.error("[damar] parseArguments: argumen tool diperbaiki otomatis (JSON rusak).");
                return parsed;
            } catch (err2) {
                // Coba lagi: newline/tab mentah di dalam string literal.
                try {
                    const parsed = JSON.parse(escCtrl(text));
                    console.error("[damar] parseArguments: argumen tool diperbaiki (escape kontrol).");
                    return parsed;
                } catch (err3) {
                    console.error("[damar] parseArguments GAGAL total:", String(err3).slice(0, 200), "| mentah:", String(args).slice(0, 300));
                    return {};
                }
            }
        }
    }

}

module.exports = RuntimeExecutor;
