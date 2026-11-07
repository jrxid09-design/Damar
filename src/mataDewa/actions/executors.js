/**
 * Executor aksi Mata Dewa — jembatan kemampuan → efek nyata.
 *
 * HUKUM OTORITAS:
 *  - Visualisasi/query read-only boleh dijalankan ter-scope (fly_to, zoom,
 *    layer set, inspect, query).
 *  - Aksi di luar observasi murni (watch create/remove, asset import)
 *    TIDAK dieksekusi di sini — executor menandai mereka untuk jalur
 *    Action Intent → Authority → Actuation → Verification kanonik. Mata Dewa
 *    TIDAK menjadi bypass aksi.
 *
 * Executor berjalan di sisi renderer (efek kamera/UI) melalui jahitan
 * window.MataDewaActions, dan di sisi daemon (query/inspect) secara langsung.
 */

const { CAPABILITY_FAMILIES: CAP } = require("../capabilities/index");

/** Aksi read-only yang boleh dieksekusi langsung (masih ter-scope). */
const READONLY_ACTIONS = new Set([
    CAP.VIEW_FLY_TO, CAP.VIEW_ZOOM, CAP.VIEW_GLOBE, CAP.ENTITY_INSPECT,
    CAP.HAZARD_QUERY, CAP.ROUTE_INSPECT, CAP.TIMELINE_QUERY, CAP.CCTV_INSPECT,
    CAP.RF_OBSERVE
]);

/** Aksi visual yang mengubah state UI saja (bukan dunia nyata). */
const UI_STATE_ACTIONS = new Set([
    CAP.MODE_ACTIVATE, CAP.MODE_DEACTIVATE, CAP.LAYER_SET, CAP.ENTITY_TRACK,
    CAP.ENTITY_UNTRACK, CAP.MAP_STACK_SET, CAP.STYLE_SET, CAP.SCENE_CONTROL,
    CAP.ANNOTATION_DRAW, CAP.ANNOTATION_CLEAR
]);

/** Aksi yang WAJIB lewat Action Fabric kanonik (menulis state/inti). */
const GOVERNED_ACTIONS = new Set([
    CAP.WATCH_CREATE, CAP.WATCH_REMOVE, CAP.ASSET_IMPORT
]);

/**
 * Kelaskan sebuah aksi (untuk Manager/pemanggil memutuskan jalurnya).
 */
function classifyAction(capabilityId) {
    if (READONLY_ACTIONS.has(capabilityId)) return "readonly";
    if (UI_STATE_ACTIONS.has(capabilityId)) return "ui_state";
    if (GOVERNED_ACTIONS.has(capabilityId)) return "governed";
    return "unknown";
}

/**
 * Jalankan aksi UI-state / read-only pada permukaan renderer.
 * `surface` adalah jahitan renderer (window.MataDewaActions).
 * Mengembalikan { ok, via, result?|reason? }.
 */
function executeUiAction(capabilityId, args = {}, surface = null) {
    const kind = classifyAction(capabilityId);
    if (kind === "governed") {
        // Fail-closed: aksi governed menolak dieksekusi langsung di sini.
        return {
            ok: false,
            via: "governed_required",
            reason: `${capabilityId} wajib melalui Action Intent → Authority → Actuation → Verification`
        };
    }
    if (kind === "unknown") {
        return { ok: false, via: "unknown", reason: `kemampuan tidak dikenal: ${capabilityId}` };
    }
    if (!surface || typeof surface.dispatch !== "function") {
        return { ok: false, via: kind, reason: "permukaan renderer tidak tersedia" };
    }
    try {
        const result = surface.dispatch(capabilityId, args);
        return { ok: true, via: kind, result };
    }
    catch (error) {
        return { ok: false, via: kind, reason: error.message };
    }
}

/**
 * Resolver sisi daemon untuk aksi read-only (query/inspect).
 * service: instance MataDewaService.
 */
async function executeDaemonAction(capabilityId, args = {}, service = null) {
    if (!service) return { ok: false, reason: "service tidak tersedia" };
    const kind = classifyAction(capabilityId);
    if (kind !== "readonly") {
        return { ok: false, reason: `aksi ${kind} tidak dieksekusi di daemon via jalur ini` };
    }
    switch (capabilityId) {
        case CAP.HAZARD_QUERY: {
            const lat = Number(args.lat), lon = Number(args.lon);
            const radiusM = Number(args.radiusM ?? 25000);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return { ok: false, reason: "butuh lat/lon" };
            }
            const { interpretAbsence } = require("../coverage/coverage");
            const hits = service.observationsNear({ lat, lon }, radiusM);
            const absence = interpretAbsence(service.registry, {
                type: args.type ?? null,
                point: { lat, lon }
            });
            return {
                ok: true,
                result: {
                    hits: hits.map(h => ({ observation: h.observation, distanceM: Math.round(h.distanceM) })),
                    absence: { status: absence.status, meaning: absence.meaning },
                    fresh: hits.filter(h => nowLive(h.observation)).length
                }
            };
        }
        case CAP.TIMELINE_QUERY: {
            const lat = Number(args.lat), lon = Number(args.lon);
            const radiusM = Number(args.radiusM ?? 25000);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return { ok: false, reason: "butuh lat/lon" };
            }
            const hits = service.timeline.near({ lat, lon }, radiusM, {
                type: args.type ?? null,
                sinceMs: args.sinceMs ?? null
            });
            return { ok: true, result: { hits: hits.slice(0, 100) } };
        }
        case CAP.ROUTE_INSPECT: {
            const { analyzeCorridor } = require("../routes/corridor");
            if (!args.route?.geometry) return { ok: false, reason: "butuh route.geometry" };
            return { ok: true, result: analyzeCorridor(args.route, [], service.assetRegistry) };
        }
        case CAP.CCTV_INSPECT: {
            const { frameMediaDescriptor } = require("../media/cctv");
            const camera = service.cameraRegistry?.get?.(args.cameraId);
            if (!camera) return { ok: false, reason: "kamera tidak terdaftar" };
            const canFetch = service.cameraRegistry.canFetch(args.cameraId);
            if (!canFetch.ok) return { ok: false, reason: canFetch.reason };
            return { ok: true, result: frameMediaDescriptor(camera) };
        }
        case CAP.ENTITY_INSPECT: {
            const obs = service.observations.get(args.observationId);
            if (!obs) return { ok: false, reason: "observasi tidak ditemukan" };
            return { ok: true, result: { observation: obs } };
        }
        case CAP.RF_OBSERVE: {
            // Read-only: status RF + estimasi terbaru per sesi. TIDAK ada
            // klaim identitas/pose — hanya presence/motion INFERRED.
            if (!service.rfManager) return { ok: false, reason: "RF sensing tidak terkomposisi" };
            return { ok: true, result: service.rfManager.status() };
        }
        default:
            return { ok: false, reason: `aksi daemon tidak didukung: ${capabilityId}` };
    }
}

function nowLive(observation) {
    if (!Number.isFinite(observation?.observedAt)) return false;
    return Date.now() - observation.observedAt <= 5 * 60 * 1000;
}

module.exports = { READONLY_ACTIONS, UI_STATE_ACTIONS, GOVERNED_ACTIONS, classifyAction, executeUiAction, executeDaemonAction };
