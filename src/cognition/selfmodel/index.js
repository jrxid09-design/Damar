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

    // --- state (semua di sini murni in-process; hanya successWindows durabel) ---
    const availabilityCache = new Map();   // capabilityId -> {availability, generation, observedAtMs}
    const successWindows = await loadSuccessWindows(store); // capabilityId -> {attempts, successes, windowStartedAt, history:[]}
    const lastOutcomes = new Map();        // capabilityId -> {outcomeRef, state, at}
    const lastUsedAt = new Map();          // capabilityId -> ms (kunci eviksi §9)
    let unknownsList = [];
    let limitationsList = [];
    let degradedSubsystems = [];           // [{subsystem, state, at}]

    function now() { return clock.nowMs(); }
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

        const assessment = buildAssessment({
            capabilityId,
            descriptorRef: descriptor.id ?? capabilityId,
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
        const { capabilityId, availability, generation, observedAtMs } = observation;
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
        const observedAt = Number.isFinite(Number(observedAtMs)) ? Number(observedAtMs) : now();
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
        const { capabilityId, tier, outcome, at, evidenceRef } = outcomeRecord;

        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            fail(REASONS.INVALID_OUTCOME, "capabilityId wajib string tidak kosong");
        }
        if (!ALLOWED_TIERS.has(tier)) {
            fail(REASONS.INVALID_OUTCOME, `tier '${tier}' tidak diterima, hanya T1/T2`);
        }
        if (!ALLOWED_OUTCOMES.has(outcome)) {
            fail(REASONS.INVALID_OUTCOME, `outcome '${outcome}' tidak dikenal`);
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
        const history = Object.freeze([...(window.history ?? []), Object.freeze({ at, outcome, evidenceRef })]
            .slice(-bounds.MAX_SUCCESS_WINDOW));
        const nextAppliedEvidenceRefs = Object.freeze(
            [...appliedEvidenceRefs, evidenceRef].slice(-bounds.MAX_APPLIED_EVIDENCE_REFS)
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
        const { subsystem, state, at } = healthEvent;
        if (typeof subsystem !== "string" || subsystem.length === 0) {
            fail(REASONS.INVALID_OBSERVATION, "subsystem wajib string tidak kosong");
        }
        const validStates = new Set(["HEALTHY", "DEGRADED", "DOWN", "UNKNOWN"]);
        if (!validStates.has(state)) {
            fail(REASONS.INVALID_OBSERVATION, `state '${state}' tidak dikenal`);
        }
        // Bug review independen (audit putaran-17, AUD17-P2-2): `at` tidak
        // pernah disaring seperti ingestOutcome's `at` -- BigInt di dalamnya
        // meledakkan JSON.stringify di snapshot()/buildGovernedProjection(),
        // yang dipanggil setiap siklus longhorizon shadow/governed.
        if (at !== undefined && typeof at !== "string" && typeof at !== "number") {
            fail(REASONS.INVALID_OBSERVATION, "'at', jika ada, wajib string atau number");
        }

        degradedSubsystems = degradedSubsystems.filter(d => d.subsystem !== subsystem);
        if (state !== "HEALTHY") {
            const entry = Object.freeze({ subsystem, state, at: at ?? nowIso() });
            if (degradedSubsystems.length >= bounds.MAX_DEGRADED_SUBSYSTEMS) {
                degradedSubsystems = degradedSubsystems.slice(1); // FIFO, batas keras
            }
            degradedSubsystems = [...degradedSubsystems, entry];
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
        const meshIdentity = safeCall(() => meshPort?.identity?.()) ?? null;
        const knownNodes = (safeCall(() => meshPort?.knownNodes?.()) ?? [])
            .slice(0, bounds.MAX_KNOWN_NODES);
        const reachableNodes = (safeCall(() => meshPort?.reachableNodes?.()) ?? [])
            .slice(0, bounds.MAX_KNOWN_NODES);
        const activeProviders = safeCall(() => providerPort?.activeProviders?.()) ?? [];
        const resourcePressure = safeCall(() => governorPort?.pressure?.()) ?? null;
        const presence = safeCall(() => presencePort?.state?.()) ?? null;

        return buildSnapshot({
            identity: {
                nodeId: meshIdentity?.nodeId ?? "UNKNOWN",
                nodeRole: meshIdentity?.nodeRole ?? "UNKNOWN"
            },
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
