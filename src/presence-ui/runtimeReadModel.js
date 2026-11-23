'use strict';

/**
 * UIX-W5 PRESENCE READ MODEL.
 *
 * Proyeksi BACA saja: status runtime Presence KANONIK -> state presentasi
 * UIX. Lapisan ini tidak memiliki state runtime apa pun, tidak menyimpan
 * apa pun, dan tidak punya permukaan untuk memutasi lifecycle owner —
 * satu-satunya masukannya adalah snapshot beku milik host kanonik.
 *
 * Arah kebenaran hanya satu:
 *
 *     runtime kanonik -> read model -> presentasi UIX
 *
 * Tidak pernah sebaliknya. Domain yang belum punya jalur baca kanonik
 * dilaporkan NOT_IMPLEMENTED, dan runtime yang tidak ada TIDAK PERNAH
 * dilaporkan siap.
 *
 * Kosakata presentasi memakai 14 state W3 yang sudah beku
 * (docs/uix-w3/VISUAL_STATE_MODEL.json) lewat `src/ui-platform/stateBinding`
 * — tidak ada kosakata presence kedua.
 */

const { VISUAL_STATES } = require('../ui-platform/stateBinding');
const { LIFECYCLE, ACTIVITY_MODE } = require('../runtime/presence/states');

const SCHEMA_VERSION = 'uix-w5.presence-read-model.v1';

/** State presentasi UIX = subset bebas dari state W3 (bukan kosakata baru). */
const PRESENTATION = Object.freeze({
    DORMANT: 'DORMANT',
    IDLE: 'IDLE',
    LISTENING: 'LISTENING',
    THINKING: 'THINKING',
    WAITING_FOR_AUTHORITY: 'WAITING_FOR_AUTHORITY',
    DEGRADED: 'DEGRADED',
    OFFLINE: 'OFFLINE',
    UNKNOWN: 'UNKNOWN'
});

const AVAILABILITY = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    ON_HOLD: 'ON_HOLD',
    UNAVAILABLE: 'UNAVAILABLE',
    UNKNOWN: 'UNKNOWN'
});

const FRESHNESS = Object.freeze({
    LIVE: 'LIVE',
    UNAVAILABLE: 'UNAVAILABLE',
    UNREADABLE: 'UNREADABLE'
});

const DOMAIN_STATUS = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    UNAVAILABLE: 'UNAVAILABLE',
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED'
});

/**
 * Peta eksplisit CANONICAL_RUNTIME_STATE -> UIX_PRESENCE_PRESENTATION_STATE.
 *
 * Saat state kanonik ACTIVE, presentasi ditentukan oleh mode aktivitas
 * hidup (precedence kanonik sudah diselesaikan Presence). SPEAKING
 * dipetakan ke THINKING — bukan ACTING: menghasilkan jawaban bukan bukti
 * eksekusi misi (aturan kebenaran W3: "THINKING is not ACTING").
 */
const ACTIVITY_TO_PRESENTATION = Object.freeze({
    [ACTIVITY_MODE.IDLE]: PRESENTATION.IDLE,
    [ACTIVITY_MODE.ATTENDING]: PRESENTATION.IDLE,
    [ACTIVITY_MODE.LISTENING]: PRESENTATION.LISTENING,
    [ACTIVITY_MODE.THINKING]: PRESENTATION.THINKING,
    [ACTIVITY_MODE.SPEAKING]: PRESENTATION.THINKING
});

/**
 * ON_HOLD tidak punya padanan langsung di W3. Dipetakan ke DORMANT
 * (hadir, tidak terlibat) — BUKAN siap kerja, BUKAN mengeksekusi. Kesiapan
 * sesungguhnya tetap dibawa apa adanya lewat `readiness: "ON_HOLD"` dan
 * `available: false`, jadi tidak ada klaim ketersediaan yang palsu.
 */
const LIFECYCLE_TO_PRESENTATION = Object.freeze({
    [LIFECYCLE.OFFLINE]: PRESENTATION.OFFLINE,
    [LIFECYCLE.BOOTING]: PRESENTATION.UNKNOWN,
    [LIFECYCLE.INITIALIZING]: PRESENTATION.UNKNOWN,
    [LIFECYCLE.DORMANT]: PRESENTATION.DORMANT,
    [LIFECYCLE.AWAKE]: PRESENTATION.IDLE,
    [LIFECYCLE.ON_HOLD]: PRESENTATION.DORMANT,
    [LIFECYCLE.WAITING_FOR_OWNER]: PRESENTATION.WAITING_FOR_AUTHORITY,
    [LIFECYCLE.DEGRADED]: PRESENTATION.DEGRADED,
    [LIFECYCLE.RECOVERING]: PRESENTATION.DEGRADED,
    [LIFECYCLE.SHUTTING_DOWN]: PRESENTATION.OFFLINE,
    [LIFECYCLE.FAILED]: PRESENTATION.OFFLINE
});

const AVAILABILITY_BY_READINESS = Object.freeze({
    IDLE_READY: AVAILABILITY.AVAILABLE,
    ACTIVE: AVAILABILITY.AVAILABLE,
    ON_HOLD: AVAILABILITY.ON_HOLD,
    UNAVAILABLE: AVAILABILITY.UNAVAILABLE
});

/** Domain yang belum punya jalur baca kanonik. Dinyatakan, bukan dikarang. */
const NOT_IMPLEMENTED_DOMAINS = Object.freeze([
    Object.freeze({
        domain: 'sensorium',
        status: DOMAIN_STATUS.NOT_IMPLEMENTED,
        reason: 'NO_CANONICAL_RUNTIME_READ_PATH_EXPOSED'
    }),
    Object.freeze({
        domain: 'missionActivity',
        status: DOMAIN_STATUS.NOT_IMPLEMENTED,
        reason: 'NO_CANONICAL_MISSION_READ_PATH_BOUND_TO_RUNTIME'
    })
]);

for (const id of Object.values(PRESENTATION)) {
    if (!VISUAL_STATES.includes(id)) {
        throw new Error(`UIX_PRESENCE_PRESENTATION_STATE_NOT_IN_W3:${id}`);
    }
}

function canonicalHost() {
    try {
        return require('../runtime/host/runtimeHost').getCanonicalRuntimeHost();
    } catch {
        return null;
    }
}

function phaseOf(host) {
    return host && typeof host.phase === 'string' ? host.phase : null;
}

/** Snapshot runtime hanya dianggap terbaca bila bentuknya benar-benar utuh. */
function readSnapshot(host) {
    if (!host || typeof host.status !== 'function') return null;
    let raw;
    try {
        raw = host.status();
    } catch {
        return null;
    }
    if (raw === null || typeof raw !== 'object') return null;
    const presence = raw.presence;
    const lifecycle = raw.presenceLifecycle;
    if (!presence || typeof presence !== 'object') return null;
    if (!lifecycle || typeof lifecycle !== 'object') return null;
    if (typeof presence.lifecycleState !== 'string') return null;
    if (typeof lifecycle.instanceId !== 'string') return null;
    return { presence, lifecycle };
}

function presentationFor(presence) {
    const state = presence.lifecycleState;
    if (state === LIFECYCLE.ACTIVE) {
        return ACTIVITY_TO_PRESENTATION[presence.activityPresentation] ?? PRESENTATION.UNKNOWN;
    }
    return LIFECYCLE_TO_PRESENTATION[state] ?? PRESENTATION.UNKNOWN;
}

function frozenReasons(raw) {
    if (!Array.isArray(raw)) return Object.freeze([]);
    return Object.freeze(raw.slice(0, 32).map((entry) => Object.freeze({
        kind: typeof entry?.kind === 'string' ? entry.kind : null,
        detail: typeof entry?.detail === 'string' ? entry.detail : null,
        sinceMs: Number.isFinite(entry?.sinceMs) ? entry.sinceMs : null
    })));
}

function boundedCount(value) {
    return Number.isFinite(value) ? value : null;
}

function buildUnavailable({ nowMs, freshness, runtimePhase }) {
    const missing = Object.freeze([Object.freeze({
        domain: 'presenceLifecycle',
        status: DOMAIN_STATUS.UNAVAILABLE,
        reason: freshness === FRESHNESS.UNREADABLE
            ? 'CANONICAL_RUNTIME_STATUS_UNREADABLE'
            : 'NO_CANONICAL_RUNTIME_HOST'
    })]);
    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        source: 'canonical_runtime_presence',
        isCanonical: true,
        asOfMs: nowMs,
        freshness,
        // Tidak ada runtime kanonik yang bisa dipercaya -> UNKNOWN, tidak
        // pernah "siap". OFFLINE pun tidak diklaim: itu pun sebuah
        // pernyataan tentang runtime yang tidak kita punya.
        presentationState: PRESENTATION.UNKNOWN,
        availability: AVAILABILITY.UNKNOWN,
        available: false,
        runtimePhase,
        instanceId: null,
        generation: null,
        lifecycleState: null,
        activityPresentation: null,
        readiness: null,
        health: null,
        held: null,
        summoned: null,
        activeActivityCount: null,
        waitingOwnerCount: null,
        degradedReasons: Object.freeze([]),
        uptimeMs: null,
        unavailableDomains: Object.freeze([...missing, ...NOT_IMPLEMENTED_DOMAINS])
    });
}

/**
 * Baca status Presence kanonik sebagai read model presentasi UIX.
 *
 * @param {object}  [options]
 * @param {object}  [options.host]   Host kanonik; default host kanonik proses.
 * @param {number}  [options.nowMs]  Stempel waktu baca (jam terinjeksi).
 */
function readPresenceReadModel(options = {}) {
    const nowMs = Number.isFinite(options?.nowMs) ? options.nowMs : Date.now();
    const host = options?.host === undefined ? canonicalHost() : options.host;
    const runtimePhase = phaseOf(host);
    const snapshot = readSnapshot(host);

    if (snapshot === null) {
        return buildUnavailable({
            nowMs,
            freshness: host ? FRESHNESS.UNREADABLE : FRESHNESS.UNAVAILABLE,
            runtimePhase
        });
    }

    const { presence, lifecycle } = snapshot;
    const readiness = typeof lifecycle.readiness === 'string' ? lifecycle.readiness : null;
    const availability = AVAILABILITY_BY_READINESS[readiness] ?? AVAILABILITY.UNKNOWN;

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        source: 'canonical_runtime_presence',
        isCanonical: true,
        asOfMs: nowMs,
        freshness: FRESHNESS.LIVE,
        presentationState: presentationFor(presence),
        availability,
        available: availability === AVAILABILITY.AVAILABLE,
        runtimePhase,
        instanceId: lifecycle.instanceId,
        generation: typeof presence.generation === 'string' ? presence.generation : null,
        lifecycleState: presence.lifecycleState,
        activityPresentation: typeof presence.activityPresentation === 'string'
            ? presence.activityPresentation
            : null,
        readiness,
        health: typeof presence.health === 'string' ? presence.health : null,
        held: lifecycle.held === true,
        summoned: presence.summoned === true,
        activeActivityCount: boundedCount(presence.activeActivityCount),
        waitingOwnerCount: boundedCount(presence.waitingOwnerCount),
        degradedReasons: frozenReasons(presence.degradedReasons),
        uptimeMs: Number.isFinite(presence.uptimeMs) ? presence.uptimeMs : null,
        unavailableDomains: NOT_IMPLEMENTED_DOMAINS
    });
}

module.exports = Object.freeze({
    SCHEMA_VERSION,
    PRESENTATION,
    AVAILABILITY,
    FRESHNESS,
    DOMAIN_STATUS,
    ACTIVITY_TO_PRESENTATION,
    LIFECYCLE_TO_PRESENTATION,
    NOT_IMPLEMENTED_DOMAINS,
    readPresenceReadModel
});
