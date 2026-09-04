"use strict";

/**
 * RF LIVE TRUST DOMAIN (MD-010, repaired by MD-015/016/017).
 *
 * LAW (corrected):
 *   CALLER DATA != LIVE RF TRUST
 *   STRING LINEAGE != LIVE RF TRUST
 *   RF OBJECT SHAPE != LIVE RF TRUST
 *   RF MANAGER INSTANCE != CANONICAL RF MANAGER
 *   CALIBRATED STRING != VALID CALIBRATION
 *   TRUSTED LIVE != AUTHORITY
 *
 * DESIGN (composition-owned, instance-local):
 *  - createRfTrustDomain() mints a FRESH closure with its OWN private
 *    WeakMap + private lexical state. Two domains NEVER recognize each
 *    other's observations:
 *        const a = createRfTrustDomain(); const b = createRfTrustDomain();
 *        a.markTrustedLive(obs, meta); b.verifyTrustedLive(obs) === null
 *  - Constructing another RfManager or another trust domain NEVER grants
 *    access to canonical live trust.
 *  - The canonical Mata Dewa composition creates EXACTLY ONE domain and
 *    distributes ONLY minimal capabilities, lexically:
 *       canonical RfManager    → trustedRfSubmit callback (submits evidence;
 *                                no mint reachable on the manager)
 *       MataDewaService        → the internal trusted-ingest closure
 *                                (normalize → mark the STORED object → store)
 *       RF watch evaluator     → read-only verifyTrustedLive
 *       public Mata Dewa API   → NONE (no mint/trusted-ingest export)
 *  - The mint (markTrustedLive) is a closure capability of the domain
 *    object itself. The composition never stores the domain object on the
 *    service, the manager, the package index, the controller, or any
 *    global; it lives in the private constructor closure and only the
 *    internal ingest function holds a reference to marking.
 *  - NO forgeable proof object exists. There is NO exported function that
 *    accepts { kind: "rf-live-trust", sensorId, captureSession } — such an
 *    object is inert JSON; the WeakMap entry can only be created by the
 *    domain's own mark capability after strict validation.
 *  - Trust is established AFTER successful canonical normalization, on the
 *    EXACT canonical frozen object that will be stored/evaluated (fixes
 *    MD-017: re-normalization can no longer orphan the trust).
 *  - Binding includes calibration state/generation/validity so the watch
 *    can compare the observation's DECLARED calibration metadata against
 *    the trusted INTERNAL metadata (Repair 3) — mismatch fails closed.
 */

const { CALIBRATION_STATE, CALIBRATION_LIMITS } = require("./calibration");

const BINDING_LIMITS = Object.freeze({
    MAX_SENSOR_ID: 128,
    MAX_SESSION: 128,
    MAX_SOURCE_KIND: 32,
    MAX_TTL_MS: 24 * 60 * 60 * 1000
});

function boundedNonEmptyString(value, field, max) {
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        return { ok: false, reason: `${field} wajib string non-kosong ≤ ${max}` };
    }
    return { ok: true, value };
}

function finiteNonNegative(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return { ok: false, reason: `${field} wajib number finite non-negatif` };
    }
    return { ok: true, value };
}

/**
 * Validasi KETAT binding calon-trusted (internal mark path). SourceKind
 * REPLAY/SIMULATED/asing TIDAK PERNAH lolos (Repair 5). Calibration wajib
 * CALIBRATED dengan metrik finite + generation sah (Repair 2/4).
 * Mengembalikan metadata beku (dipendek ke apa yang domain perlukan).
 */
function canonicalizeBinding(binding) {
    if (!binding || typeof binding !== "object") {
        return { ok: false, reason: "binding wajib objek" };
    }
    const sensor = boundedNonEmptyString(binding.sensorId, "sensorId", BINDING_LIMITS.MAX_SENSOR_ID);
    if (!sensor.ok) return sensor;
    const session = boundedNonEmptyString(binding.captureSession, "captureSession", BINDING_LIMITS.MAX_SESSION);
    if (!session.ok) return session;
    const kind = boundedNonEmptyString(binding.sourceKind, "sourceKind", BINDING_LIMITS.MAX_SOURCE_KIND);
    if (!kind.ok) return kind;
    const normKind = kind.value.toLowerCase();
    if (normKind === "replay" || normKind === "simulated" || normKind === "simulation") {
        return { ok: false, reason: `sourceKind '${kind.value}' TIDAK PERNAH bisa live-trust (replay/simulasi)` };
    }
    const channel = binding.channel === null || binding.channel === undefined
        ? null
        : (Number.isFinite(binding.channel) ? binding.channel : NaN);
    if (channel !== null && Number.isNaN(channel)) {
        return { ok: false, reason: "channel wajib null atau number finite" };
    }

    const cal = binding.calibration;
    if (!cal || typeof cal !== "object") {
        return { ok: false, reason: "kalibrasi wajib ada (bind legit calib metadata)" };
    }
    // Hanya CALIBRATED yang boleh di-mark live (MD-016 di lapisan trust:
    // COLLECTING/STALE/NOISY/INVALID/RECALIBRATION_REQUIRED → tidak di-mark).
    if (cal.state !== CALIBRATION_STATE.CALIBRATED) {
        return { ok: false, reason: `calibrationState harus CALIBRATED, dapat: ${String(cal.state)}` };
    }
    if (!Number.isSafeInteger(cal.generation) || cal.generation <= 0) {
        return { ok: false, reason: "generation wajib safe integer > 0" };
    }
    const validatedAt = finiteNonNegative(cal.validatedAtMs, "calibration.validatedAtMs");
    if (!validatedAt.ok) return validatedAt;
    const ttl = finiteNonNegative(cal.ttlMs, "calibration.ttlMs");
    if (!ttl.ok) return ttl;
    if (ttl.value === 0 || ttl.value > BINDING_LIMITS.MAX_TTL_MS) {
        return { ok: false, reason: `ttlMs wajib (0, ${BINDING_LIMITS.MAX_TTL_MS}]` };
    }

    const q = cal.quality;
    if (!q || typeof q !== "object") {
        return { ok: false, reason: "calibration.quality wajib ada (strict metrics)" };
    }
    if (!Number.isSafeInteger(q.sampleCount) ||
        q.sampleCount < CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES) {
        return { ok: false, reason: `sampleCount wajib ≥ ${CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES}` };
    }
    const baseline = finiteNonNegative(q.baselineMetric, "calibration.quality.baselineMetric");
    if (!baseline.ok) return baseline;
    const noise = finiteNonNegative(q.noiseMetric, "calibration.quality.noiseMetric");
    if (!noise.ok) return noise;
    if (noise.value > CALIBRATION_LIMITS.MAX_BASELINE_CV) {
        return { ok: false, reason: `noiseMetric > MAX_BASELINE_CV (${CALIBRATION_LIMITS.MAX_BASELINE_CV}) — reject, bukan clamp` };
    }

    return {
        ok: true,
        metadata: Object.freeze({
            sensorId: sensor.value,
            captureSession: session.value,
            sourceKind: kind.value,
            channel,
            calibrationState: CALIBRATION_STATE.CALIBRATED,
            calibrationGeneration: cal.generation,
            calibrationValidatedAtMs: validatedAt.value,
            calibrationTtlMs: ttl.value,
            calibrationQuality: Object.freeze({
                sampleCount: q.sampleCount,
                baselineMetric: baseline.value,
                noiseMetric: noise.value
            })
        })
    };
}

/**
 * Buat SATU trust domain instance-lokal.
 * @param {{ clock?: { nowMs(): number } }} options
 * @returns {{
 *   markTrustedLive(observation, binding): { ok:boolean, reason?:string },
 *   verifyTrustedLive(observation): object|null,
 *   diagnostics(): object
 * }}
 */
function createRfTrustDomain({ clock = { nowMs: () => Date.now() } } = {}) {
    // ---- INSTANCE-LOCAL closure state (bukan module-global, bukan singleton) ----
    const store = new WeakMap();   // stored canonical observation → metadata beku
    let markedCount = 0;
    let mintRejected = 0;

    /**
     * Mint: tandai EXACT objek kanonik yang akan disimpan sebagai
     * trusted-live. Dipanggil HANYA oleh komposisi kanonik (closure ingest),
     * SETELAH normalizeObservation menghasilkan objek baru yang akan
     * disimpan (MD-017). Reject keras untuk binding tak-sah (fail closed).
     */
    function markTrustedLive(observation, binding) {
        if (!observation || typeof observation !== "object") {
            mintRejected += 1;
            return { ok: false, reason: "observasi wajib objek" };
        }
        // Canonical objects are deep-frozen by normalizeObservation; the mint
        // only ever sees the canonical stored object.
        if (!Object.isFrozen(observation)) {
            mintRejected += 1;
            return { ok: false, reason: "objek belum kanonik beku — mint menolak" };
        }
        const verdict = canonicalizeBinding(binding);
        if (!verdict.ok) {
            mintRejected += 1;
            return { ok: false, reason: verdict.reason };
        }
        store.set(observation, verdict.metadata);
        markedCount += 1;
        return { ok: true };
    }

    /**
     * VERIFIKATOR read-only (satu-satunya yang boleh sampai ke watch).
     * Mengembalikan metadata internal beku, atau null (tidak dipercaya).
     */
    function verifyTrustedLive(observation) {
        if (!observation || typeof observation !== "object") return null;
        return store.get(observation) ?? null;
    }

    function diagnostics() {
        return Object.freeze({
            kind: "rf-trust-domain",
            markedCount,
            mintRejected,
            note: "instance-local; domain lain tidak saling mengenali"
        });
    }

    return Object.freeze({
        markTrustedLive,
        verifyTrustedLive,
        diagnostics
    });
}

/**
 * Klasifikasi mode sumber — LABEL, bukan trust. Dipakai untuk hasil
 * simulasi/replay yang eksplisit; TIDAK PERNAH mengotorisasi apa pun.
 */
function rfSourceModeOf(observation) {
    const lineageMode = String(observation?.lineage?.upstreamDataset ?? "").toLowerCase();
    const attrMode = String(observation?.attributes?.sourceKind ?? "").toLowerCase();
    const declared = observation?.attributes?.sourceMode ?? null;
    if (lineageMode === "replay" || attrMode === "replay" || declared === "REPLAY" || declared === "SIMULATED") {
        return "REPLAY";
    }
    if (lineageMode === "udp" || attrMode === "udp" || declared === "LIVE") {
        return "LIVE";
    }
    return "UNKNOWN";
}

module.exports = Object.freeze({
    createRfTrustDomain,
    rfSourceModeOf,
    BINDING_LIMITS
});