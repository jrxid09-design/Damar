"use strict";

/**
 * FG-03 GOVERNED MODE FOUNDATION (ADR-17, ARCH-Q-02, ratified).
 *
 * ACC subdomain `src/cognition/governed/**` -- the canonical, reusable
 * off/shadow/governed gate and GovernedCognitiveProjection guarantees.
 * This is a FOUNDATION, not a new authority owner: it never touches
 * Authority, never constructs an ActionIntent, never dispatches a tool,
 * and holds no mutable state of its own (every export below is a pure
 * function or a frozen constant -- there is nothing here to persist,
 * restart, or leak).
 *
 * MODEL != AUTHORITY. COGNITION != AUTHORITY. ACC OUTPUT != EXECUTION
 * AUTHORITY. A GovernedCognitiveProjection is always advisory-only data;
 * turning it into an intent, a grant, or a permission is the caller's
 * violation, not something this module can prevent by itself -- so it
 * makes the violation impossible to construct *through* this module's
 * own API surface, and `assertNoAuthorityShapedFields`/
 * `validateGovernedCognitiveProjection` exist so every consumer can
 * cheaply prove a projection it received (or built) carries none.
 *
 * Extracted from `src/cognition/longhorizon/index.js`, which was the
 * first (and until now, only) governed-mode producer -- longhorizon now
 * imports MODES/AUTHORITY_SHAPED_KEYS/assertNoAuthorityShapedFields/
 * resolveMode/isInfluenceAllowed from here instead of holding its own
 * copies, closing the duplication before a second lane (W8-L2/L4/L6)
 * had a chance to grow a THIRD copy independently.
 *
 * Restart/recovery (ADR-17 "reversible to SHADOW and OFF"): this module
 * holds no state, so there is nothing to resume -- every caller passes
 * `mode` explicitly at construction (matching the existing off/shadow
 * convention in `src/cognition/config/ACCConfig.js` and `longhorizon`),
 * and `resolveMode` fails closed to "off" for anything unrecognized,
 * missing, or hostile. A process restart can therefore never silently
 * resurrect a live/permissive mode -- the caller must say so again,
 * every time.
 */

const { types: utilTypes } = require("node:util");
const { MODES } = require("./bounds");
const { REASONS, GovernedError, fail } = require("./errors");

/**
 * Proxy probe via internal slot: zero traps, and correct for a revoked Proxy
 * too. Reflection on a Proxy EXECUTES caller code, and an `ownKeys` trap can
 * HIDE a field from the walk -- so this guard must run BEFORE the first
 * reflection, not be discovered by it.
 */
function isProxyValue(value) {
    try {
        return utilTypes.isProxy(value);
    } catch {
        return true;
    }
}

/**
 * Authority-shaped vocabulary. Independent audit of 0b8abb7 found the
 * original list covered only this repo's historical field NAMES
 * (authProof/capabilityGrant/executionLease/...) and therefore let equally
 * authoritative synonyms through: a projection carrying `authority`,
 * `permission`, `approved`, `decision`, or a bearer/lease token validated
 * clean. The list below is the containment boundary, so it is deliberately
 * vocabulary-family based rather than a record of names seen so far.
 */
const AUTHORITY_SHAPED_KEYS = Object.freeze([
    // historical names this repo already used
    "authorityDecision", "allow", "grant", "owner", "authProof", "route",
    "capabilityGrant", "executionLease", "executor", "trustedNode", "rootAuthority",
    // authority/permission family
    "authority", "authorities", "authorized", "authorization", "authorizations",
    "authorizationCode", "unauthorized",
    "permission", "permissions", "privilege", "privileges", "permit", "permitted", "permitAll",
    "allowed", "denied", "deny", "forbidden",
    "approved", "approval", "approvedBy", "entitlement", "entitlements",
    "consent", "scope", "scopes", "authentication", "authenticated",
    // decision/grant family
    "decision", "decisions", "decisionMaker", "granted", "grants", "grantedBy",
    "delegation", "delegated", "delegate", "mandate", "mandated",
    // bearer-token / lease family. NOTE: bare `token`/`tokens` are deliberately
    // NOT listed -- they are ordinary advisory vocabulary (e.g. a planning
    // token budget), and listing them risks rejecting legitimate projections.
    // The specific credential forms below carry the actual authority risk.
    "lease", "leases", "leasedUntil", "bearer", "bearerToken", "leaseToken", "authToken",
    "accessToken", "refreshToken", "idToken", "sessionToken",
    // credential family
    "credential", "credentials", "creds", "secret", "secrets", "apiKey", "accessKey",
    "privateKey", "password", "passphrase", "auth", "oauthToken", "jwt",
    "sessionCredential",
    // credential-bearing names actually used elsewhere in this repo (audit of
    // 321c7b3 named `bindingSecret` as a real persistent device credential in
    // src/authority/ownerTrust/bindings.js) plus their obvious siblings.
    "bindingSecret", "clientSecret", "secretKey", "apiToken", "privateToken",
    "accessCredential", "authorizationBearer",
    // Authority-family terms this repo classifies as authority/bearer terms in
    // src/action/intent.js and src/action/actuation/dispatcher.js (audit of
    // c37be79): the vocabulary must cover the repo's OWN authority vocabulary,
    // not a hand-picked subset of it.
    "authorize", "authorized", "approve", "approved", "trust", "trusted",
    "privileged", "admin", "administrator", "root", "role", "roles",
    "canExecute", "allowDecision", "trustLevel", "trustedBy",
    // Tiga token yang masih hilang dari daftar ini padahal ada di kosakata
    // kanonik repo (INTENT_AUTHORITY_TOKENS, src/action/intent.js) -- parity
    // diperiksa test, bukan diklaim (audit of fg03 r10).
    "authorisation", "ownerapproved", "superuser"
]);

/**
 * Normalisasi nama field untuk pencocokan keluarga: huruf kecil, tanpa
 * pemisah. Ini menutup dua celah yang ditemukan audit 8f78a21 pada daftar
 * sebelumnya: pencocokan yang PERSIS dan PEKA-HURUF membuat `AUTHORIZATION`,
 * `auth_token`, `accessToken`, dan `permitted` lolos begitu saja, padahal
 * maknanya identik dengan entri yang sudah ditolak.
 *
 * Pencocokan tetap EXACT setelah normalisasi (bukan substring): `decision`
 * ditolak, sementara `decisionInfluence` -- field proyeksi yang sah -- tidak
 * boleh ikut tertolak.
 */
function normalizeAuthorityKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const AUTHORITY_SHAPED_KEY_SET = new Set(AUTHORITY_SHAPED_KEYS.map(normalizeAuthorityKey));

/**
 * Kunci yang berbahaya HANYA bila nilainya berupa string.
 *
 * `token`/`tokens` adalah kosakata advisory yang sah ketika berupa ANGKA (mis.
 * anggaran token perencanaan), tetapi sebuah string seperti
 * `"Bearer root-secret"` adalah materi kredensial. Audit d409f56 menunjukkan
 * bahwa mengecualikan `token` sepenuhnya membuka bypass kredensial, sementara
 * memblokirnya tanpa syarat akan menolak proyeksi advisory yang sah. Karena
 * itu aturannya bergantung pada BENTUK NILAI, bukan pada nama kunci saja.
 */
const CONDITIONAL_AUTHORITY_KEYS = Object.freeze(new Set(["token", "tokens"]));

function isAuthorityShapedKey(key) {
    return typeof key === "string" && AUTHORITY_SHAPED_KEY_SET.has(normalizeAuthorityKey(key));
}

function isConditionallyAuthorityShapedKey(key) {
    return typeof key === "string" && CONDITIONAL_AUTHORITY_KEYS.has(normalizeAuthorityKey(key));
}

// Bug review independen (extraksi FG-03, sibling langsung dari class
// round-14's AUD14-P1-1/round-30's AUD30-ADV-1): recursion tanpa budget
// kedalaman/simpul bisa DoS pada proyeksi bersarang dalam; WeakSet
// mencegah crash pada referensi siklik. Sumber proyeksi ini SELALU
// lane cognition tepercaya (bukan input caller mentah), jadi ini
// pertahanan berlapis murah, bukan sanitisasi input adversarial.
const MAX_PROJECTION_DEPTH = 16;
const MAX_PROJECTION_NODES = 4096;

function walkForAuthorityShapedFields(value, label, seen, budget, depth, requireFrozen = false) {
    if (typeof value === "function") {
        throw new Error(`ACC governed: ${label} tidak boleh berupa fungsi`);
    }
    if (!value || typeof value !== "object") return;
    // A Proxy is refused outright. Without this, the walk's guarantee is
    // unsound twice over: `ownKeys`/`getOwnPropertyDescriptor` EXECUTE caller
    // code, and an `ownKeys` trap returning [] hides `authProof` from the
    // scan entirely. Independent audit of 0b8abb7 proved exactly that bypass.
    if (isProxyValue(value)) {
        throw new Error(`ACC governed: ${label} tidak dapat dibekukan/diverifikasi -- tidak boleh berupa Proxy`);
    }
    if (seen.has(value)) return;
    if (requireFrozen && !Object.isFrozen(value)) {
        throw new Error(`ACC governed: ${label} wajib dibekukan secara mendalam`);
    }
    if (requireFrozen) {
        let prototype;
        try {
            prototype = Object.getPrototypeOf(value);
        } catch {
            throw new Error(`ACC governed: ${label} tidak dapat diverifikasi dengan aman`);
        }
        const allowedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
        if (prototype !== null && prototype !== allowedPrototype) {
            throw new Error(`ACC governed: ${label} wajib berupa objek data biasa`);
        }
    }
    seen.add(value);
    if (depth > MAX_PROJECTION_DEPTH) {
        throw new Error(`ACC governed: ${label} terlalu dalam untuk diverifikasi dengan aman`);
    }
    budget.count += 1;
    if (budget.count > MAX_PROJECTION_NODES) {
        throw new Error(`ACC governed: ${label} melebihi batas jumlah simpul`);
    }
    let keys;
    try {
        keys = Reflect.ownKeys(value);
    } catch {
        throw new Error(`ACC governed: ${label} tidak dapat diverifikasi dengan aman`);
    }
    for (const key of keys) {
        if (isAuthorityShapedKey(key)) {
            throw new Error(`ACC governed: ${label} tidak boleh membawa field '${key}'`);
        }
    }
    for (const key of keys) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, key);
        } catch {
            throw new Error(`ACC governed: ${label} tidak dapat dibaca dengan aman`);
        }
        if (!descriptor || !("value" in descriptor)) {
            throw new Error(`ACC governed: ${label}.${String(key)} wajib berupa data property`);
        }
        // Kunci berkondisi (token/tokens): HANYA angka (anggaran token
        // perencanaan) yang sah. Setiap representasi lain -- string, array
        // bersisi string, objek `{value:...}`, boolean, bahkan objek kotak
        // `new String(...)` -- gagal-tutup, karena semuanya bisa menyelundupkan
        // materi kredensial (audit 321c7b3 memperlihatkan `["Bearer ..."]`,
        // `{value:"Bearer ..."}`, dan `true` semuanya lolos).
        if (isConditionallyAuthorityShapedKey(key)) {
            const tokenValue = descriptor.value;
            if (typeof tokenValue !== "number" || !Number.isFinite(tokenValue)) {
                throw new Error(`ACC governed: ${label}.${String(key)} hanya boleh berupa angka (anggaran token)`);
            }
        }
        walkForAuthorityShapedFields(descriptor.value, `${label}.${String(key)}`, seen, budget, depth + 1, requireFrozen);
    }
}

/**
 * Deep, recursive authority-shaped-key guard -- generalizes longhorizon's
 * original two-level-shallow check (projection + projection.selfModel
 * only) to arbitrary depth, since any future L2/L4/L6 projection shape
 * is not yet known and a shallow check would silently stop protecting
 * past whatever depth the ORIGINAL producer happened to nest fields at.
 */
function assertNoAuthorityShapedFields(value, label) {
    walkForAuthorityShapedFields(value, label, new WeakSet(), { count: 0 }, 0, false);
}

/**
 * Fail-closed mode normalizer -- the single place every governed-mode
 * consumer resolves a caller-supplied mode string. Anything not exactly
 * "off"/"shadow"/"governed" (including undefined, null, a revoked Proxy,
 * or a hostile object) resolves to "off".
 */
function resolveMode(mode) {
    try {
        return MODES.includes(mode) ? mode : "off";
    } catch {
        return "off";
    }
}

/**
 * ADR-17: shadow is decisionInfluence:false ALWAYS (zero influence by
 * contract, not merely by "no consumer exists yet"); governed is the
 * only mode where ADVISORY_ONLY influence is permitted. off never
 * reaches this (callers gate cycle-level work on mode==="off" earlier
 * and return before producing anything to check).
 */
function isInfluenceAllowed(mode) {
    return mode === "governed";
}

/**
 * Schema/shape check for a GovernedCognitiveProjection: correct
 * schemaVersion, decisionInfluence is exactly "ADVISORY_ONLY", frozen,
 * and carries no authority-shaped field at any depth. Throws a plain
 * Error with a clear reason on any violation; callers that need a
 * domain-coded failure should catch and re-fail with their own REASONS.
 */
function validateGovernedCognitiveProjection(projection) {
    try {
        if (!projection || typeof projection !== "object") {
            throw new Error("ACC governed: proyeksi wajib objek");
        }
        const schemaDescriptor = Object.getOwnPropertyDescriptor(projection, "schemaVersion");
        const influenceDescriptor = Object.getOwnPropertyDescriptor(projection, "decisionInfluence");
        if (!schemaDescriptor || !("value" in schemaDescriptor) ||
            !influenceDescriptor || !("value" in influenceDescriptor)) {
            throw new Error("ACC governed: proyeksi wajib berupa data properties");
        }
        if (schemaDescriptor.value !== "governedCognitiveProjection.v1") {
            throw new Error("ACC governed: schemaVersion proyeksi tidak dikenal");
        }
        if (influenceDescriptor.value !== "ADVISORY_ONLY") {
            throw new Error("ACC governed: decisionInfluence proyeksi wajib 'ADVISORY_ONLY'");
        }
        if (!Object.isFrozen(projection)) {
            throw new Error("ACC governed: proyeksi wajib dibekukan");
        }
        walkForAuthorityShapedFields(projection, "GovernedCognitiveProjection", new WeakSet(), { count: 0 }, 0, true);
        return true;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("ACC governed:")) throw error;
        throw new Error("ACC governed: proyeksi tidak dapat diverifikasi dengan aman (authProof/accessor boundary)");
    }
}

/**
 * Auditable mode transition (ADR-17: "a mode gate becomes a declared,
 * audited configuration transition"). Thin, fail-closed wrapper around
 * the same "audit failure never blocks cognition" pattern already used
 * by longhorizon's own auditSelfModelTransitions -- a missing/throwing/
 * revoked ledger never raises, it just means the transition goes
 * unaudited rather than crashing the caller.
 */
function recordModeTransition(options) {
    return recordModeTransitionChecked(options).event;
}

/**
 * Auditable mode transition with an explicit durability outcome.
 *
 * ADR-17 requires the mode gate to be a DECLARED, AUDITED configuration
 * transition. The previous implementation could not distinguish "audited"
 * from "silently went unaudited": a supplied ledger that was missing,
 * rejected, or threw produced exactly the same return value as a successful
 * append, so a caller could proceed in governed mode believing the
 * transition was recorded. Independent audit of 0b8abb7 flagged that as
 * fail-open.
 *
 * `recordModeTransitionChecked` never throws (the established "audit failure
 * must not take down the operation" law) but REPORTS the outcome so the
 * caller can fail closed on it:
 *   auditSupplied  -- a caller-supplied positive audit path existed
 *   audited        -- that path CONFIRMED a durable append
 *   failedOpen     -- a supplied path did NOT confirm; the caller must not
 *                     treat the transition as audited
 *
 * A missing ledger is a declared configuration (no positive audit claim is
 * made, `auditSupplied:false`), which is what keeps the Wave7 L7 convergence
 * contract's `mode: "governed"` construction -- with no ledger -- intact.
 * The fail-open case is specifically "you gave me a ledger and it did not
 * record", which is detectably different and must not be silently ignored.
 */
/**
 * Baca satu field dari hasil `append` sebagai DATA milik objek itu sendiri.
 *
 * `"ok" in result` menelusuri RANTAI PROTOTIPE dan `result.ok` adalah `[[Get]]`
 * mentah yang menjalankan accessor/trap Proxy -- sehingga `ok:true` warisan,
 * array yang ditempel `ok=true`, dan Proxy yang menyintesis `ok:true` semuanya
 * lolos sebagai "terkonfirmasi" (audit d409f56). Pembacaan di sini hanya lewat
 * deskriptor MILIK SENDIRI, jadi tidak ada jalur warisan, accessor, maupun Proxy
 * yang bisa memalsukannya.
 */
function readOwnDataField(value, key) {
    if (value === null || typeof value !== "object" || isProxyValue(value)) return undefined;
    let desc;
    try {
        desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
        return undefined;
    }
    if (!desc || desc.get || desc.set || !("value" in desc)) return undefined;
    return desc.value;
}

/**
 * Objek data biasa: prototipe `Object.prototype` atau `null`, bukan array,
 * bukan Proxy. Objek kotak (`new String(...)`), `Date`, `Map`, dan instance
 * kelas lain PUNYA properti sendiri yang bisa menyamar, jadi semuanya ditolak
 * (audit 321c7b3).
 */
function isPlainDataObject(value) {
    if (value === null || typeof value !== "object" || isProxyValue(value) || Array.isArray(value)) return false;
    let proto;
    try {
        proto = Object.getPrototypeOf(value);
    } catch {
        return false;
    }
    return proto === Object.prototype || proto === null;
}

/**
 * Ekstrak eventId dari hasil append, bila bentuknya memang salah satu kontrak
 * yang sah: `{ok:true, event:{eventId}}` (appendSafe) atau rekaman tersimpan
 * yang membawa `eventId` (append kanonik).
 */
function extractConfirmedEventId(result) {
    const direct = readOwnDataField(result, "eventId");
    if (typeof direct === "string" && direct) return direct;
    const event = readOwnDataField(result, "event");
    const nested = event === undefined ? undefined : readOwnDataField(event, "eventId");
    return typeof nested === "string" && nested ? nested : null;
}

/**
 * Bukti TULIS-BALIK: rekaman benar-benar ADA di ledger, dibaca lewat API baca
 * ledger itu sendiri.
 *
 * Bentuk kembalian tidak bisa membuktikan durabilitas -- ledger yang
 * dipasok pemanggil bisa saja mengembalikan `{ok:true}` tanpa menulis apa pun
 * (audit 321c7b3). Karena itu "terkonfirmasi" hanya sah bila ledger
 * mengekspos pembacaan (`getByEventId`/`list`) DAN rekaman itu benar-benar
 * dapat dibaca kembali dari sana. Ledger tanpa API baca tidak dapat
 * mengonfirmasi apa pun, jadi jalur itu gagal-tutup.
 */
/**
 * Pemeriksa merek ledger kanonik, di-resolve MALAS.
 *
 * `governed/` tidak boleh mengimpor runtime record-sink saat modul dimuat
 * (pola yang sama dengan pemeriksa `SpatialError` di lane Wave7 lain), jadi
 * pemeriksa ini dicari saat pertama dipakai dan di-cache. Bila modul ledger
 * tidak tersedia, TIDAK ADA ledger yang dapat dibuktikan kanonik -- gagal-tutup.
 */
let ledgerBrandCheck;

function isCanonicalLedger(candidate) {
    if (ledgerBrandCheck === undefined) {
        try {
            const mod = require("../../runtime/auditLedger");
            ledgerBrandCheck = typeof mod.isAuditLedger === "function" ? mod.isAuditLedger : null;
        } catch {
            ledgerBrandCheck = null;
        }
    }
    if (typeof ledgerBrandCheck !== "function") return false;
    try {
        return ledgerBrandCheck(candidate) === true;
    } catch {
        return false;
    }
}

/** Salinan struktur-dalam milik ledger kanonik, bila tersedia. */
let ledgerDetach;

function detachRecord(value) {
    if (ledgerDetach === undefined) {
        try {
            const mod = require("../../runtime/auditLedger/ledger");
            ledgerDetach = typeof mod.detach === "function" ? mod.detach : null;
        } catch {
            ledgerDetach = null;
        }
    }
    return typeof ledgerDetach === "function" ? ledgerDetach(value) : null;
}

/**
 * Apakah rekaman hasil baca-balik benar-benar memuat event yang kita append?
 *
 * Perbandingan dilakukan pada SALINAN STRUKTUR-DALAM milik ledger kanonik
 * (`detach`), bukan pada objek hidup: salinan itu bebas accessor/Proxy dan
 * hanya memuat data property, sehingga tidak ada kode pemanggil yang berjalan
 * dan tidak ada rantai prototipe yang bisa menipu. Bila `detach` tidak
 * tersedia, hasil baca-balik tidak dapat dibandingkan dengan aman dan
 * jawabannya gagal-tutup.
 */
function readBackCorresponds(ledger, eventId, event) {
    if (typeof eventId !== "string" || !eventId) return false;
    const readBack = readOwnDataField(ledger, "getByEventId");
    if (typeof readBack !== "function") return false;
    let record;
    try {
        record = readBack.call(ledger, eventId);
    } catch {
        return false;
    }
    if (!record || typeof record !== "object") return false;
    if (readOwnDataField(record, "eventId") !== eventId) return false;

    // READ-BACK ALONE IS NOT PROOF. A look-alike ledger can append into a
    // transient variable and echo it back, which proves correspondence but NOT
    // persistence (audit of cd3dedf). Only the lexical brand of a genuine
    // canonical ledger is unforgeable, so that check is the hard gate and this
    // content check is layered on top of it.
    if (!event || typeof event !== "object") return false;
    const storedCore = detachRecord(record);
    const eventCore = detachRecord(event);
    if (storedCore === null || eventCore === null) return false;
    return containsEventCore(storedCore, eventCore);
}

/**
 * Apakah rekaman tersimpan MEMUAT event yang kita append?
 *
 * Sengaja SUBSET, bukan kesamaan penuh: ledger kanonik menambah field miliknya
 * sendiri (sequence, digest, atMs, ...), jadi menuntut jumlah kunci yang sama
 * akan menolak setiap rekaman yang sah (ditemukan saat menjalankan suite).
 * Yang harus dibuktikan adalah setiap field yang kita kirim ada di rekaman itu
 * dengan nilai yang sama -- cukup untuk menolak rekaman lain yang kebetulan
 * ber-id sama, tanpa melarang pengayaan yang wajar.
 */
function containsEventCore(stored, appended, depth = 0) {
    if (depth > 8) return false;
    if (stored === null || appended === null
        || typeof stored !== "object" || typeof appended !== "object") {
        return stored === appended;
    }
    for (const key of Object.keys(appended)) {
        if (!Object.prototype.hasOwnProperty.call(stored, key)) return false;
        const valueStored = readOwnDataField(stored, key);
        const valueAppended = readOwnDataField(appended, key);
        if (valueAppended !== null && typeof valueAppended === "object") {
            if (!containsEventCore(valueStored, valueAppended, depth + 1)) return false;
        } else if (valueStored !== valueAppended) {
            return false;
        }
    }
    return true;
}

function recordModeTransitionChecked(options) {
    let auditLedger, from, to, at;
    try {
        const source = options && typeof options === "object" ? options : {};
        const read = (key) => {
            if (isProxyValue(source)) return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(source, key);
            return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
        };
        auditLedger = read("auditLedger"); from = read("from"); to = read("to"); at = read("at");
    } catch {
        auditLedger = null; from = undefined; to = undefined; at = undefined;
    }
    const safeAt = typeof at === "number" && Number.isFinite(at) ? at : null;
    const event = Object.freeze({
        eventType: "cognition.governed.mode.transition",
        source: "acc.governed",
        outcome: "ok",
        metadata: Object.freeze({ from: resolveMode(from), to: resolveMode(to), at: safeAt })
    });

    // "Supplied" means the caller actually passed a ledger, which is
    // detectable independently of whether a usable `append` exists on it.
    // Treating "a callable append was found" as the definition (the previous
    // behaviour) let `{}`, a revoked Proxy, a throwing getter, or a
    // non-callable `append` all report failedOpen:false and proceed in
    // governed mode unaudited (independent audit of 8f78a21).
    const auditSupplied = auditLedger !== null && auditLedger !== undefined;
    let audited = false;
    try {
        const append = auditSupplied && !isProxyValue(auditLedger) ? auditLedger.append : undefined;
        if (auditSupplied) {
            if (typeof append !== "function") {
                audited = false;                  // supplied, but unusable
            } else {
                // DURABLE append, bukan append biasa.
                //
                // Merek kanonik membuktikan ASAL-PABRIK, bukan durabilitas:
                // `append(event)` tanpa opsi TIDAK pernah menyentuh sink, jadi
                // ledger kanonik tanpa sink -- dan ledger dengan sink yang tidak
                // pernah dipakai -- sama-sama melaporkan terkonfirmasi (audit
                // bd45f18). Dengan `{durable:true}` ledger menulis ke sink-nya,
                // dan ledger TANPA sink melempar NO_SINK sehingga terkonfirmasi
                // menjadi false dan governed gagal-tutup. Konfirmasi akhirnya
                // membuktikan yang diklaimnya: rekaman durabel.
                const result = append.call(auditLedger, event, { durable: true });
                // Probe `then` with a get (NOT an own-descriptor read: a real
                // Promise carries `then` on Promise.prototype, so an
                // own-descriptor probe would miss it and leave the rejection
                // unhandled). The probe is inside try/catch so a hostile
                // `then` accessor still cannot run uncontrolled.
                let isThenable = false;
                try {
                    isThenable = !!result && typeof result.then === "function";
                } catch {
                    isThenable = false;
                }
                if (isThenable) {
                    // Async ledgers cannot confirm durability here; unconfirmed
                    // rather than assumed successful.
                    Promise.resolve(result).catch(() => {});
                } else if (!isPlainDataObject(result)) {
                    // Rejects `false`, `undefined`, `null`, primitives, arrays,
                    // boxed strings, Dates, Maps, and class instances in one
                    // check -- none of them can be a durable confirmation.
                    audited = false;
                } else {
                    // Positive confirmation requires PROOF OF PERSISTENCE: the
                    // returned record must be readable back from the ledger's
                    // OWN read API. A shape-only check let a caller-supplied
                    // ledger return {ok:true} or a forged {eventId} without
                    // recording anything (audit of 321c7b3), and a ledger with
                    // no read API can prove nothing at all -- so both fail
                    // closed rather than counting as durable.
                    // Positive confirmation requires BOTH:
                    //  1. the LEDGER is a genuine canonical ledger (lexical
                    //     brand -- unforgeable, and the only check that actually
                    //     excludes a caller-supplied look-alike that echoes what
                    //     it was handed without storing anything), and
                    //  2. the appended record is readable back and MATCHES the
                    //     event we appended.
                    // A shape-only check let a ledger return {ok:true} or a
                    // forged {eventId} without recording anything (audits of
                    // 321c7b3 / cd3dedf).
                    audited = isCanonicalLedger(auditLedger)
                        && readBackCorresponds(auditLedger, extractConfirmedEventId(result), event);
                }
            }
        }
    } catch { /* audit failure never blocks cognition -- reported, not thrown */
        audited = false;
    }

    return { event, auditSupplied, audited, failedOpen: auditSupplied && !audited };
}

module.exports = Object.freeze({
    MODES,
    REASONS,
    GovernedError,
    fail,
    AUTHORITY_SHAPED_KEYS,
    isAuthorityShapedKey,
    assertNoAuthorityShapedFields,
    resolveMode,
    isInfluenceAllowed,
    validateGovernedCognitiveProjection,
    recordModeTransition,
    recordModeTransitionChecked
});
