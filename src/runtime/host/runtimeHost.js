"use strict";

/**
 * DAMAR RUNTIME HOST V1 — compatibility facade
 * (Wave 5 Lane 4, repair R9 / DSC-R8-001).
 *
 * The RuntimeHost composition implementation moved to
 * src/integration/canonicalRuntimeComposition.js, the single lexical
 * ownership boundary for the RuntimeCore + RuntimeHost + Voice continuity
 * handshake.  This facade re-exports the ORDINARY, SANITIZED public factory
 * and the ordinary host vocabulary.
 *
 * DSC-R8-001: public createRuntimeHost accepts ONLY ordinary documented
 * options.  A caller-supplied `coreFactory` is ALWAYS treated as untrusted:
 * it receives only sanitized ordinary options and NEVER receives a trusted
 * continuity sink, a composition payload, or any privileged continuity
 * object.  No public option (voiceActivation / trustedContinuitySink /
 * continuityComposition / …) can receive a privileged capability.
 */

const {
    createRuntimeHost,
    HOST_VERSION,
    HOST_PHASE,
    HOST_COMMANDS,
    LOCAL_TRANSPORT_ID,
    governorMod,
    ib,
    presenceMod
} = require("../../integration/canonicalRuntimeComposition");

const VERSION = HOST_VERSION;

/**
 * KEPUTUSAN START (UIX-W5 Presence continuation).
 * START != RESUME dan bukan penyamaran RESUME.
 */
const START_CODES = Object.freeze({
    OK_STARTED: "OK_STARTED",
    OK_ALREADY_STARTED: "OK_ALREADY_STARTED"
});

let canonicalHostInstance = null;
let canonicalHostPromise = null;
let canonicalStartPromise = null;

async function ensureCanonicalRuntimeHost(options = {}) {
    if (canonicalHostInstance !== null) {
        if (canonicalHostInstance.phase === "TERMINATED") {
            canonicalHostInstance = null;
        } else {
            return canonicalHostInstance;
        }
    }
    if (canonicalHostPromise !== null) {
        return canonicalHostPromise;
    }
    canonicalHostPromise = (async () => {
        const mergedOpts = {
            ...options,
            coreOptions: {
                enableManagerIngress: true,
                ...(options.coreOptions || {})
            }
        };
        const host = await createRuntimeHost(mergedOpts);
        canonicalHostInstance = host;
        return host;
    })();
    try {
        return await canonicalHostPromise;
    } finally {
        canonicalHostPromise = null;
    }
}

function getCanonicalRuntimeHost() {
    return canonicalHostInstance;
}

function lifecycleStatusOf(host) {
    if (!host || typeof host.lifecycleStatus !== "function") return null;
    try {
        return host.lifecycleStatus();
    } catch {
        return null;
    }
}

function startResult(host, {
    started,
    code,
    previousInstanceId = null,
    previousInstancePresent = false,
    joinedInFlightStart = false
}) {
    const lifecycle = lifecycleStatusOf(host);
    return Object.freeze({
        ok: true,
        code,
        started,
        joinedInFlightStart,
        instanceId: lifecycle === null ? null : lifecycle.instanceId,
        lifecycleState: lifecycle === null ? null : lifecycle.lifecycleState,
        readiness: lifecycle === null ? null : lifecycle.readiness,
        phase: host === null ? null : host.phase,
        // Best-effort: kalau owner lama sudah dimusnahkan, identitasnya
        // TIDAK dikarang — null, tapi keberadaannya tetap dilaporkan.
        previousInstancePresent,
        previousInstanceId,
        // START tidak pernah mengklaim kontinuitas lintas restart: tidak ada
        // state ON_HOLD, aktivitas, atau identitas owner yang diwarisi.
        restartContinuity: false
    });
}

/**
 * START KANONIK (governed) — satu-satunya jalur yang boleh MENCIPTAKAN
 * instance Presence kanonik.
 *
 * START berarti: "belum ada instance Presence kanonik yang hidup;
 * bangun/ikat TEPAT SATU owner lewat komposisi runtime kanonik."
 * RESUME berarti: "instance kanonik SUDAH hidup dan sedang ON_HOLD;
 * pakai instance YANG SAMA." Karena itu START tidak pernah memanggil
 * RESUME, tidak pernah mengangkat HOLD, dan tidak pernah menyentuh
 * jalur hold/resume sama sekali.
 *
 * Kontrak:
 *   - instance sudah hidup  -> OK_ALREADY_STARTED, `started:false`,
 *     owner TIDAK diganti dan TIDAK ada host kedua yang dibangun;
 *   - START bersamaan       -> hanya satu yang membangun (`started:true`),
 *     yang lain bergabung ke START yang sama (`joinedInFlightStart:true`);
 *   - instance TERMINATED   -> komposisi baru = owner BARU
 *     (`previousInstanceId` dilaporkan, `restartContinuity:false`).
 *
 * Membangun host bukan tindakan konsekuensi menurut aturan kanon yang
 * sudah ada (HOST_COMMANDS hanya menggerakkan lifecycle; boot daemon
 * juga tidak melewati Gate otoritas). START tidak memberi izin,
 * tidak mengautentikasi, dan tidak mengaktifkan aktuator.
 */
async function startCanonicalRuntimeHost(options = {}) {
    const existing = canonicalHostInstance;
    if (existing !== null && existing.phase !== "TERMINATED") {
        return startResult(existing, {
            started: false,
            code: START_CODES.OK_ALREADY_STARTED
        });
    }
    if (canonicalStartPromise !== null) {
        const host = await canonicalStartPromise;
        return startResult(host, {
            started: false,
            code: START_CODES.OK_ALREADY_STARTED,
            joinedInFlightStart: true
        });
    }

    const previousInstancePresent = existing !== null;
    const previousInstanceId = existing === null
        ? null
        : (lifecycleStatusOf(existing)?.instanceId ?? null);

    canonicalStartPromise = ensureCanonicalRuntimeHost(options);
    let host;
    try {
        host = await canonicalStartPromise;
    } finally {
        canonicalStartPromise = null;
    }
    return startResult(host, {
        started: true,
        code: START_CODES.OK_STARTED,
        previousInstancePresent,
        previousInstanceId
    });
}

async function resetCanonicalRuntimeHostForTesting() {
    if (canonicalHostInstance) {
        try {
            await canonicalHostInstance.shutdown();
        } catch {
            // ignore shutdown errors in test reset
        }
    }
    canonicalHostInstance = null;
    canonicalHostPromise = null;
    canonicalStartPromise = null;
}

module.exports = Object.freeze({
    createRuntimeHost,
    ensureCanonicalRuntimeHost,
    startCanonicalRuntimeHost,
    getCanonicalRuntimeHost,
    resetCanonicalRuntimeHostForTesting,
    START_CODES,
    VERSION,
    HOST_PHASE,
    HOST_COMMANDS,
    LOCAL_TRANSPORT_ID,
    governorMod,
    ib,
    presenceMod
});
