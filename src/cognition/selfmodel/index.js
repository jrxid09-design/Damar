"use strict";

/**
 * W7-L1 SELF-MODEL AND CAPABILITY AWARENESS.
 *
 * ACC subdomain `src/cognition/selfmodel/**`. Bounded, evidence-aware
 * internal model of Damar's own capabilities, constraints, runtime state
 * and known limitations (`W7_SELF_MODEL_FORMAL_SPEC.md`).
 *
 * SELF-MODEL != AUTHORITY. This module never grants, mutates, or executes
 * anything; it only observes and reports, with explicit epistemic honesty
 * including "I do not know" (`unknowns()`).
 *
 * Availability is CACHE-ONLY, in-memory, never persisted: this is what
 * makes "restart never restores availability fresh" true by construction
 * rather than by a runtime check (spec §6, SM-A8).
 */

const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");
const { sanitizeBounds } = require("../core/bounds");
const { laws } = require("./laws");
const { requireCapabilityRegistryPort, safeCall } = require("./ports");
const {
    emptySuccessWindow, buildAssessment, unknownAssessment
} = require("./assessment");
const { makeUnknown, addUnknown } = require("./unknowns");
const { makeLimitation, addLimitation } = require("./limitations");
const { loadSuccessWindows, saveSuccessWindows } = require("./store");
const { buildSnapshot } = require("./snapshot");
const { canonicalAvailability } = require("../../capability/registry/availability");

const ALLOWED_TIERS = new Set(["T1", "T2"]);
const ALLOWED_OUTCOMES = new Set(["SUCCESS", "FAILED"]);

async function createSelfModel({
    capabilityRegistry, presencePort = null, meshPort = null,
    healthPort = null, governorPort = null, providerPort = null,
    clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS
} = {}) {

    requireCapabilityRegistryPort(capabilityRegistry);
    void healthPort; // reserved: ingestHealth() is push-based today, port unused directly

    // Bug review independen (audit putaran-53, AUD53-P2-2): `bounds` yang
    // dioverride pemanggil dibaca mentah (`bounds.MAX_*`) di puluhan titik
    // di seluruh lane ini -- Proxy yang di-revoke raw-throw pada baca
    // PERTAMA, di mana pun itu. Dinormalisasi SEKALI di sini (spread
    // memicu trap `ownKeys` kalau ada, jadi ini juga menguji keamanannya);
    // field yang hilang jatuh ke `BOUNDS` asli, bukan `undefined`.
    // Bug review independen (audit putaran-57, Codex, W7R57-P2-1):
    // normalisasi lama hanya memvalidasi `bounds` ITU SENDIRI sebagai
    // objek, bukan tiap NILAI override -- Infinity/NaN/negatif pada satu
    // MAX_* melumpuhkan batas itu. sanitizeBounds memvalidasi per key.
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

    // --- state (semua di sini murni in-process; hanya successWindows durabel) ---
    const availabilityCache = new Map();   // capabilityId -> {availability, generation, observedAtMs}
    const successWindows = await loadSuccessWindows(store); // capabilityId -> {attempts, successes, windowStartedAt, history:[]}
    const lastOutcomes = new Map();        // capabilityId -> {outcomeRef, state, at}
    const lastUsedAt = new Map();          // capabilityId -> ms (kunci eviksi §9)
    let unknownsList = [];
    let limitationsList = [];
    let degradedSubsystems = [];           // [{subsystem, state, at}]

    // Bug review independen (audit putaran-53, AUD53-P2-2): `clock.nowMs()`
    // mentah -- Proxy yang di-revoke (atau `nowMs` yang melempar/bukan
    // fungsi/mengembalikan non-finite) raw-throw dari SETIAP pemanggil
    // now()/nowIso() di seluruh lane. Envelope.js (putaran-48) sudah
    // punya kontrak yang sama untuk clock-nya; disamakan di sini.
    function now() {
        let candidate;
        try {
            candidate = typeof clock?.nowMs === "function" ? clock.nowMs() : undefined;
        } catch {
            candidate = undefined;
        }
        return Number.isFinite(candidate) ? candidate : Date.now();
    }
    function nowIso() { return new Date(now()).toISOString(); }

    function touch(capabilityId) {
        lastUsedAt.set(capabilityId, now());
        evictIfOverBound();
    }

    /** §9: evicted by lastUsedAt ASCENDING (paling lama dipakai, bukan confidence). */
    function evictIfOverBound() {
        if (lastUsedAt.size <= bounds.MAX_CAPABILITY_ASSESSMENTS) return;
        const ordered = [...lastUsedAt.entries()].sort((a, b) => a[1] - b[1]);
        const overflow = ordered.length - bounds.MAX_CAPABILITY_ASSESSMENTS;
        for (let i = 0; i < overflow; i++) {
            const [id] = ordered[i];
            availabilityCache.delete(id);
            successWindows.delete(id);
            lastOutcomes.delete(id);
            lastUsedAt.delete(id);
        }
    }

    function recordUnknown(subject, reason, lastKnown = null, probeCost = "NONE") {
        const entry = makeUnknown({ subject, reason, since: nowIso(), lastKnown, probeCost });
        const { list } = addUnknown(unknownsList, entry, bounds.MAX_UNKNOWNS);
        unknownsList = list;
        return entry;
    }

    function refreshLimitationForCapability(capabilityId, assessment) {
        const existingIdx = limitationsList.findIndex(l => l.subject === capabilityId);
        const shouldLimit = assessment.selfBelief === "UNUSABLE" || assessment.selfBelief === "DEGRADED";
        if (!shouldLimit) {
            if (existingIdx !== -1) limitationsList = limitationsList.filter((_, i) => i !== existingIdx);
            return;
        }
        const entry = makeLimitation({
            subject: capabilityId,
            reason: `capability selfBelief=${assessment.selfBelief}`,
            sourceRef: assessment.availabilityRef ? `gen:${assessment.availabilityRef.generation}` : null,
            since: nowIso(),
            severity: assessment.selfBelief === "UNUSABLE" ? "WARN" : "INFO"
        });
        if (existingIdx === -1) {
            const { list } = addLimitation(limitationsList, entry, bounds.MAX_ACTIVE_LIMITATIONS);
            limitationsList = list;
        } else {
            limitationsList = limitationsList.map((l, i) => (i === existingIdx ? entry : l));
        }
    }

    function assess(capabilityId) {
        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            fail(REASONS.INVALID_OBSERVATION, "capabilityId wajib string tidak kosong");
        }
        touch(capabilityId);

        // S-2: tanpa descriptor, satu-satunya nilai sah adalah UNKNOWN.
        const descriptor = safeCall(() => capabilityRegistry.get(capabilityId));
        if (!descriptor) {
            recordUnknown(capabilityId, "NO_SOURCE");
            return unknownAssessment(capabilityId);
        }

        const cacheEntry = availabilityCache.get(capabilityId) ?? null;
        const window = successWindows.get(capabilityId) ?? emptySuccessWindow(now());
        const lastOutcome = lastOutcomes.get(capabilityId) ?? null;

        if (!cacheEntry) {
            recordUnknown(capabilityId, "NEVER_OBSERVED");
        }

        // Bug review independen (audit putaran-50, W7R50-ADV-1): `safeCall`
        // di atas hanya membungkus PANGGILAN `capabilityRegistry.get()` --
        // kalau REGISTRY (dependency internal tepercaya) mengembalikan
        // descriptor berbentuk Proxy yang di-revoke, `descriptor.id` di
        // sini tetap [[Get]] mentah. Dibungkus try/catch, jatuh ke
        // `capabilityId` (fallback yang sama seperti `descriptor.id`
        // hilang/undefined).
        let descriptorRef;
        try {
            descriptorRef = descriptor.id ?? capabilityId;
        } catch {
            descriptorRef = capabilityId;
        }
        const assessment = buildAssessment({
            capabilityId,
            descriptorRef,
            cacheEntry, successWindow: window, lastOutcome,
            nowMs: now(), availabilityTtlMs: bounds.AVAILABILITY_TTL_MS
        });

        refreshLimitationForCapability(capabilityId, assessment);
        return assessment;
    }

    /**
     * observation: { capabilityId, availability, generation, observedAtMs }.
     * SM-A7: TIDAK PERNAH membaca nodeId dari sini — identitas node hanya
     * datang dari meshPort.identity() di snapshot().
     */
    function ingestAvailability(observation) {
        if (!observation || typeof observation !== "object") {
            fail(REASONS.INVALID_OBSERVATION, "observation wajib objek");
        }
        // Bug review independen (audit putaran-43, W7R43-P2-2): destructuring
        // di bawah membaca SETIAP properti `observation` lewat [[Get]] biasa
        // -- sebuah Proxy yang di-revoke melempar TypeError MENTAH pada
        // operasi ini, keluar dari `ingestAvailability()` publik, tidak
        // seperti sibling ingestOutcome/ingestHealth yang sudah aman.
        let capabilityId, availability, generation, observedAtMs;
        try {
            ({ capabilityId, availability, generation, observedAtMs } = observation);
        } catch {
            fail(REASONS.INVALID_OBSERVATION, "observation tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            fail(REASONS.INVALID_OBSERVATION, "capabilityId wajib string tidak kosong");
        }
        // SM-A5/S-2: tidak menyimpan availability untuk id yang tidak nyata.
        if (!safeCall(() => capabilityRegistry.has(capabilityId))) {
            fail(REASONS.UNKNOWN_CAPABILITY,
                `capability '${capabilityId}' tidak terdaftar di registry, availability ditolak`);
        }

        let canonical;
        try {
            canonical = canonicalAvailability(availability);
        } catch (error) {
            fail(REASONS.INVALID_OBSERVATION, `availability tidak sah: ${error.message}`);
        }

        // Bug review independen (audit putaran-27, AUD27-P2-5): `Number(generation)`
        // meledakkan TypeError mentah untuk Symbol SEBELUM Number.isFinite
        // sempat menolaknya, dan `Number({valueOf(){...}})` mengeksekusi
        // valueOf milik pemanggil di dalam proses kognisi.
        if (typeof generation === "symbol" || (typeof generation !== "number" && typeof generation !== "string" && typeof generation !== "boolean")) {
            fail(REASONS.INVALID_OBSERVATION, "generation wajib angka >= 0");
        }
        const gen = Number(generation);
        if (!Number.isFinite(gen) || gen < 0) {
            fail(REASONS.INVALID_OBSERVATION, "generation wajib angka >= 0");
        }

        const existing = availabilityCache.get(capabilityId);
        if (existing && gen <= existing.generation) {
            fail(REASONS.STALE_GENERATION,
                `generation ${gen} tidak lebih baru dari ${existing.generation}, ditolak`);
        }

        // Bug review independen (Codex putaran-5): observedAtMs masa depan
        // membuat (nowMs - observedAtMs) negatif, melewati cek staleness
        // dengan berpura-pura selalu "baru saja diamati".
        // Bug review independen (audit putaran-28, AUD28-P2-1): sibling
        // `generation` di fungsi yang sama dijaga putaran-27 -- `observedAtMs`
        // dua baris di bawahnya masih memanggil `Number(observedAtMs)`
        // mentah, meledakkan TypeError untuk Symbol dan mengeksekusi
        // valueOf hostile untuk objek, SEBELUM sempat jatuh ke fallback now().
        const observedAtNumeric = (typeof observedAtMs === "number" || typeof observedAtMs === "string" || typeof observedAtMs === "boolean")
            ? Number(observedAtMs) : NaN;
        const observedAt = Number.isFinite(observedAtNumeric) ? observedAtNumeric : now();
        if (observedAt > now() + bounds.MAX_FUTURE_SKEW_MS) {
            fail(REASONS.INVALID_OBSERVATION, "observedAtMs tidak boleh di masa depan (di luar toleransi skew jam)");
        }
        availabilityCache.set(capabilityId, {
            availability: canonical, generation: gen, observedAtMs: observedAt
        });
        touch(capabilityId);

        return assess(capabilityId);
    }

    /**
     * outcomeRecord: { capabilityId, tier: "T1"|"T2", outcome: "SUCCESS"|"FAILED",
     *                   at, evidenceRef }.
     * SM-A4: hanya T1/T2 dengan evidenceRef diterima; sisanya ditolak keras.
     */
    function ingestOutcome(outcomeRecord) {
        if (!outcomeRecord || typeof outcomeRecord !== "object") {
            fail(REASONS.INVALID_OUTCOME, "outcomeRecord wajib objek");
        }
        // Bug review independen (audit putaran-44, W7R44-P2-2): `typeof
        // outcomeRecord !== "object"` TIDAK menangkap Proxy yang di-revoke
        // (tetap typeof "object") -- destructuring ini tetap [[Get]] mentah
        // terhadapnya, sibling langsung dari ingestAvailability (round-43).
        let capabilityId, tier, outcome, at, evidenceRef;
        try {
            ({ capabilityId, tier, outcome, at, evidenceRef } = outcomeRecord);
        } catch {
            fail(REASONS.INVALID_OUTCOME, "outcomeRecord tidak dapat diverifikasi dengan aman, ditolak");
        }

        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            fail(REASONS.INVALID_OUTCOME, "capabilityId wajib string tidak kosong");
        }
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${tier}`/`${outcome}` mentah meledakkan TypeError untuk Symbol.
        if (!ALLOWED_TIERS.has(tier)) {
            fail(REASONS.INVALID_OUTCOME, `tier '${typeof tier === "string" ? tier : typeof tier}' tidak diterima, hanya T1/T2`);
        }
        if (!ALLOWED_OUTCOMES.has(outcome)) {
            fail(REASONS.INVALID_OUTCOME, `outcome '${typeof outcome === "string" ? outcome : typeof outcome}' tidak dikenal`);
        }
        if (typeof evidenceRef !== "string" || evidenceRef.length === 0) {
            fail(REASONS.INVALID_OUTCOME, "evidenceRef wajib ada (SM-A4)");
        }
        // Bug review independen (audit putaran-10, AUD10-P2-1; diperdalam
        // putaran-11, AUD11-P2-4): cek BigInt top-level saja tidak cukup --
        // BigInt BERSARANG di dalam objek `at` tetap lolos lalu meledakkan
        // JSON.stringify di saveSuccessWindows() saat persist(), dan objek
        // `at` disimpan lewat REFERENSI (tidak disalin/dibekukan), jadi
        // pemanggil yang memutasinya pasca-panggilan menulis ulang bukti
        // history kanonik. `at` di seluruh basis kode ini hanya pernah berupa
        // string ISO atau angka epoch -- ditolak tertutup untuk bentuk lain.
        if (typeof at !== "string" && typeof at !== "number") {
            fail(REASONS.INVALID_OUTCOME, "'at' wajib string atau number (tidak boleh objek/BigInt)");
        }
        // Bug review independen (audit putaran-32, AUD32-P2-4): sibling dari
        // sweep angka non-finite (envelope/goals/prospective/worldmodel di
        // putaran-30/31) yang belum menjangkau selfmodel -- `at` numerik
        // non-finite lolos, lalu diam-diam berubah jadi `null` saat
        // persist() lewat backend JSON, merusak bukti outcome kanonik.
        if (typeof at === "number" && !Number.isFinite(at)) {
            fail(REASONS.INVALID_OUTCOME, "'at' tidak boleh berupa angka non-finite (NaN/Infinity)");
        }
        if (!safeCall(() => capabilityRegistry.has(capabilityId))) {
            fail(REASONS.UNKNOWN_CAPABILITY,
                `capability '${capabilityId}' tidak terdaftar, outcome ditolak`);
        }

        const window = successWindows.get(capabilityId) ?? emptySuccessWindow(now());
        // Bug review independen (audit putaran-11, AUD11-P2-6; horizon
        // diperbaiki putaran-20, AUD20-P2-1): dedup semula cuma cek
        // `history` yang dipangkas FIFO ke MAX_SUCCESS_WINDOW (32) --
        // evidenceRef yang sudah terlempar dari 32 entri terakhir dianggap
        // BARU lagi saat di-replay, memalsukan confidence/selfBelief
        // (DEGRADED -> USABLE lewat replay evidenceRef lama). `appliedEvidenceRefs`
        // punya horizon independen jauh lebih besar (MAX_APPLIED_EVIDENCE_REFS),
        // sama seperti worldmodel's appliedRecordIds/contestedRecordIds.
        // Bug review independen (audit putaran-21, AUD21-P2-2; diperdalam
        // putaran-22, F-1): putaran-21 menambahkan fallback OR ke `history`
        // tapi TIDAK PERNAH menabur (seed) appliedEvidenceRefs dari history
        // window durabel yang sudah ada -- begitu window legacy itu
        // menerima >32 outcome baru, ref lama terlempar dari `history` (FIFO
        // 32) sementara appliedEvidenceRefs (masih [] karena tidak ditabur)
        // tidak pernah menerimanya juga, jadi fallback OR gagal menutup
        // celah tepat pada window yang seharusnya ia lindungi. Ditabur
        // sekali di sini dari history yang ada; OR tetap dipertahankan
        // sebagai jaring pengaman kedua.
        const appliedEvidenceRefs = window.appliedEvidenceRefs ?? (window.history ?? []).map(h => h.evidenceRef);
        if (appliedEvidenceRefs.includes(evidenceRef) ||
            (window.history ?? []).some(h => h.evidenceRef === evidenceRef)) {
            return assess(capabilityId);
        }
        // Bug review independen (audit putaran-8, W7R8-P1-2): `history`
        // (array DAN elemennya) tidak pernah dibekukan -- assess()'s
        // `Object.freeze({...window})` di assessment.js cuma dangkal, jadi
        // `assessment.successWindow.history` adalah REFERENSI YANG SAMA
        // dengan history kanonik ini. Pemanggil yang memutasi hasil assess()
        // menulis ulang bukti kanonik yang lalu ikut terbawa ke
        // ingestOutcome BERIKUTNYA (confidence bisa dipalsukan tanpa restart
        // sama sekali). Membekukan di sumbernya menutup jalur ini di mana
        // pun history dibaca, tidak cuma di satu titik baca.
        // Bug review independen (audit putaran-58, OpenCode, W7R58-P2-1):
        // `.slice(-bound)` dengan bound 0 (atau fractional antara 0 dan 1,
        // keduanya override sah lewat sanitizeBounds) trunc ke -0 --
        // `.slice(-0)` === `.slice(0)`, mengembalikan SELURUH array, bukan
        // kosong. Sibling dari bug goals' invalidatedBy (putaran-58,
        // Codex) yang belum disapu ke sini. Bound dibulatkan integer >= 0,
        // cabang 0 mengembalikan array kosong secara langsung.
        const maxHistory = Math.max(0, Math.trunc(bounds.MAX_SUCCESS_WINDOW));
        const combinedHistory = [...(window.history ?? []), Object.freeze({ at, outcome, evidenceRef })];
        const history = Object.freeze(maxHistory === 0 ? [] : combinedHistory.slice(-maxHistory));
        const maxAppliedRefs = Math.max(0, Math.trunc(bounds.MAX_APPLIED_EVIDENCE_REFS));
        const combinedAppliedRefs = [...appliedEvidenceRefs, evidenceRef];
        const nextAppliedEvidenceRefs = Object.freeze(
            maxAppliedRefs === 0 ? [] : combinedAppliedRefs.slice(-maxAppliedRefs)
        );
        const nextWindow = Object.freeze({
            attempts: history.length,
            successes: history.filter(h => h.outcome === "SUCCESS").length,
            windowStartedAt: window.windowStartedAt,
            history,
            appliedEvidenceRefs: nextAppliedEvidenceRefs
        });
        successWindows.set(capabilityId, nextWindow);
        lastOutcomes.set(capabilityId, Object.freeze({ outcomeRef: evidenceRef, state: outcome, at }));
        touch(capabilityId);

        return assess(capabilityId);
    }

    /** healthEvent: { subsystem, state: "HEALTHY"|"DEGRADED"|"DOWN"|"UNKNOWN", at }. */
    function ingestHealth(healthEvent) {
        if (!healthEvent || typeof healthEvent !== "object") {
            fail(REASONS.INVALID_OBSERVATION, "healthEvent wajib objek");
        }
        // Bug review independen (audit putaran-44, W7R44-P2-2): sibling
        // ingestOutcome di file yang sama.
        let subsystem, state, at;
        try {
            ({ subsystem, state, at } = healthEvent);
        } catch {
            fail(REASONS.INVALID_OBSERVATION, "healthEvent tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (typeof subsystem !== "string" || subsystem.length === 0) {
            fail(REASONS.INVALID_OBSERVATION, "subsystem wajib string tidak kosong");
        }
        const validStates = new Set(["HEALTHY", "DEGRADED", "DOWN", "UNKNOWN"]);
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${state}` mentah meledakkan TypeError untuk Symbol.
        if (!validStates.has(state)) {
            fail(REASONS.INVALID_OBSERVATION, `state '${typeof state === "string" ? state : typeof state}' tidak dikenal`);
        }
        // Bug review independen (audit putaran-17, AUD17-P2-2): `at` tidak
        // pernah disaring seperti ingestOutcome's `at` -- BigInt di dalamnya
        // meledakkan JSON.stringify di snapshot()/buildGovernedProjection(),
        // yang dipanggil setiap siklus longhorizon shadow/governed.
        if (at !== undefined && typeof at !== "string" && typeof at !== "number") {
            fail(REASONS.INVALID_OBSERVATION, "'at', jika ada, wajib string atau number");
        }
        // Bug review independen (audit putaran-32, AUD32-P2-4): sibling dari
        // ingestOutcome's non-finite 'at' guard di fungsi yang sama.
        if (typeof at === "number" && !Number.isFinite(at)) {
            fail(REASONS.INVALID_OBSERVATION, "'at', jika ada, tidak boleh berupa angka non-finite (NaN/Infinity)");
        }

        degradedSubsystems = degradedSubsystems.filter(d => d.subsystem !== subsystem);
        if (state !== "HEALTHY") {
            // Bug ditemukan lewat sapuan mandiri (setelah audit putaran-59):
            // sibling PERSIS dari kelas W7R59-P2-1..5 -- kapasitas 0
            // (sanksi sah lewat sanitizeBounds) dengan array kosong tidak
            // pernah dicegah dari SELALU di-append sesudah slice(1), jadi
            // cap 0 tetap kebobolan satu entri. Dibulatkan integer >= 0;
            // kapasitas 0 berarti TIDAK ADA entri degraded yang disimpan.
            const maxDegraded = Math.max(0, Math.trunc(bounds.MAX_DEGRADED_SUBSYSTEMS));
            if (maxDegraded > 0) {
                const entry = Object.freeze({ subsystem, state, at: at ?? nowIso() });
                if (degradedSubsystems.length >= maxDegraded) {
                    degradedSubsystems = degradedSubsystems.slice(1); // FIFO, batas keras
                }
                degradedSubsystems = [...degradedSubsystems, entry];
            }
        }
        return healthState();
    }

    function healthState() {
        if (degradedSubsystems.some(d => d.state === "DOWN")) return "DOWN";
        if (degradedSubsystems.length > 0) return "DEGRADED";
        return "UNKNOWN"; // SM-A9: tanpa sinyal kesehatan, tidak pernah HEALTHY by default
    }

    function unknowns() { return Object.freeze([...unknownsList]); }
    function limitations() { return Object.freeze([...limitationsList]); }

    function snapshot() {
        // Bug review independen (audit putaran-51, W7R51-ADV-1): `safeCall`
        // hanya membungkus PANGGILAN port (mesh/provider/governor/presence)
        // -- HASIL yang dikembalikan (mis. `meshIdentity`) tetap dibaca
        // MENTAH sesudahnya (`?.nodeId`, `.slice()`). Sebuah soft port yang
        // mengembalikan Proxy yang di-revoke (bukan melempar saat
        // dipanggil) tetap raw-throw di sini. Setiap pembacaan hasil
        // dibungkus try/catch sendiri, gagal aman ke default yang sudah
        // ada (UNKNOWN/array kosong), tidak pernah crash snapshot().
        const meshIdentity = safeCall(() => meshPort?.identity?.()) ?? null;
        let nodeId = "UNKNOWN", nodeRole = "UNKNOWN";
        try {
            nodeId = meshIdentity?.nodeId ?? "UNKNOWN";
            nodeRole = meshIdentity?.nodeRole ?? "UNKNOWN";
        } catch { /* jatuh ke default UNKNOWN */ }

        let knownNodes = [];
        try {
            const raw = safeCall(() => meshPort?.knownNodes?.()) ?? [];
            knownNodes = Array.isArray(raw) ? raw.slice(0, bounds.MAX_KNOWN_NODES) : [];
        } catch { knownNodes = []; }

        let reachableNodes = [];
        try {
            const raw = safeCall(() => meshPort?.reachableNodes?.()) ?? [];
            reachableNodes = Array.isArray(raw) ? raw.slice(0, bounds.MAX_KNOWN_NODES) : [];
        } catch { reachableNodes = []; }

        // Bug review independen (audit putaran-51, W7R51-ADV-1, sapuan
        // lanjutan; DIPERKUAT putaran-55, W7R55-P2-1): `buildSnapshot`'s
        // `assemble()` men-spread `[...activeProviders]` SEBELUM `deepFreeze`
        // sempat memprosesnya -- `Array.isArray` hanya membuktikan identitas,
        // BUKAN keamanan trap (pelajaran putaran-44/53 yang sama). Sebuah
        // array Proxy yang lolos Array.isArray tapi getter Symbol.iterator-nya
        // melempar tetap raw-throw lewat spread. Disalin di sini per-index
        // (tanpa iterator/spread), elemen yang hostile dilewati.
        let activeProviders = [];
        try {
            const raw = safeCall(() => providerPort?.activeProviders?.()) ?? [];
            if (Array.isArray(raw)) {
                let len;
                try { len = raw.length; } catch { len = 0; }
                if (!Number.isInteger(len) || len < 0) len = 0;
                // Bug review independen (audit putaran-56, Codex, W7R56-P2-1):
                // panjang yang dipalsukan besar (mis. 100000) tanpa batas atas
                // menyebabkan pembacaan per-index tak terbatas -- dibatasi
                // MAX_ACTIVE_PROVIDERS sebelum loop, sama seperti lane lain.
                if (len > bounds.MAX_ACTIVE_PROVIDERS) len = bounds.MAX_ACTIVE_PROVIDERS;
                for (let i = 0; i < len; i++) {
                    try { activeProviders.push(raw[i]); } catch { /* skip hostile index */ }
                }
            }
        } catch { activeProviders = []; }
        const resourcePressure = safeCall(() => governorPort?.pressure?.()) ?? null;
        const presence = safeCall(() => presencePort?.state?.()) ?? null;

        return buildSnapshot({
            identity: { nodeId, nodeRole },
            runtimeLocation: { presence },
            capabilityAssessments: [...availabilityCache.keys()].map(assess),
            unknowns: unknownsList,
            activeLimitations: limitationsList,
            healthState: healthState(),
            degradedSubsystems,
            resourcePressure,
            activeProviders,
            knownNodes, reachableNodes,
            activeGoalRefs: [], activeMissionRefs: [],
            generatedAtMs: now(),
            maxSnapshotBytes: bounds.MAX_SNAPSHOT_BYTES
        });
    }

    async function persist() {
        return saveSuccessWindows(store, successWindows);
    }

    return Object.freeze({
        snapshot, assess, unknowns, ingestOutcome, ingestAvailability,
        ingestHealth, limitations, persist, laws, bounds
    });
}

module.exports = { createSelfModel, laws, BOUNDS };
