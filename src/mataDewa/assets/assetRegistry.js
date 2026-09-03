/**
 * SpatialAsset — aset yang diawasi secara generik (tower/BTS/substation/
 * warehouse/home/bridge/road segment/sensor/CCTV/facility...).
 *
 * HUKUM PRIVASI KERAS: data menara PLN UPT Bogor milik pengguna adalah DATA
 * PRIBADI. Tidak ada URL My Maps, koordinat nyata, nama situs, atau metadata
 * privat yang boleh masuk repo/git/source/tests/fixtures/docs/examples/
 * screenshots/logs/release artifacts. Implementasi hanya mengenali impor
 * generik lokal; repo memakai fixture SINTETIS; data privat tinggal di jalur
 * lokal yang di-ignore (private-data/, local-data/private/, *.private.*).
 *
 * Konsep:
 *   SpatialAsset { id, type, geometry, metadata, watchPolicy, accessClass }
 */

const { GridIndex } = require("../spatial/gridIndex");
const { isValidPoint, isFiniteNumber } = require("../spatial/geo");
const { ACCESS_CLASS, canonical: canonicalAccess } = require("../spatial/accessClass");

const ASSET_TYPE = Object.freeze({
    TOWER: "tower",
    BTS: "bts",
    SUBSTATION: "substation",
    WAREHOUSE: "warehouse",
    HOME: "home",
    BRIDGE: "bridge",
    ROAD_SEGMENT: "road_segment",
    SENSOR: "sensor",
    CCTV: "cctv",
    FACILITY: "facility",
    GENERIC: "generic"
});

/** Kebijakan watch per-aset (ring bahaya TIDAK di-hard-code sebagai kebenaran universal). */
const DEFAULT_WATCH_POLICY = Object.freeze({
    enabled: true,
    hazardTypes: ["lightning", "earthquake", "weather"],
    // Ring konseptual; nilai default hanya contoh — kebijakan per-asset menang.
    rings: Object.freeze([
        { name: "critical", radiusM: 5000 },
        { name: "warning", radiusM: 15000 },
        { name: "watch", radiusM: 40000 }
    ]),
    minSeverity: "watch",
    cooldownMs: 30 * 60 * 1000
});

let counter = 0;
function nextId() {
    counter = (counter + 1) % 0xffffff;
    return `asset_${Date.now().toString(36)}_${counter.toString(36).padStart(4, "0")}`;
}

function canonicalType(value) {
    return Object.values(ASSET_TYPE).includes(value) ? value : ASSET_TYPE.GENERIC;
}

/** Normalisasi kebijakan watch (ring disortir menurun, radius >= 0). */
function canonicalWatchPolicy(policy = {}) {
    const rings = Array.isArray(policy.rings) && policy.rings.length
        ? policy.rings
            .map(r => ({
                name: typeof r?.name === "string" ? r.name : "ring",
                radiusM: Math.max(0, Number(r?.radiusM) || 0)
            }))
            .sort((a, b) => b.radiusM - a.radiusM)
        : DEFAULT_WATCH_POLICY.rings.map(r => ({ ...r }));
    return {
        enabled: policy.enabled !== false,
        hazardTypes: Array.isArray(policy.hazardTypes)
            ? policy.hazardTypes.slice()
            : [...DEFAULT_WATCH_POLICY.hazardTypes],
        rings,
        minSeverity: typeof policy.minSeverity === "string" ? policy.minSeverity : DEFAULT_WATCH_POLICY.minSeverity,
        cooldownMs: isFiniteNumber(policy.cooldownMs) && policy.cooldownMs >= 0
            ? policy.cooldownMs : DEFAULT_WATCH_POLICY.cooldownMs
    };
}

function normalizeAsset(input = {}) {
    const geometry = input.geometry ??
        (isValidPoint(input.location) ? { type: "point", lat: input.location.lat, lon: input.location.lon } : null);
    if (!geometry) {
        return { ok: false, reason: "asset butuh geometry (point) yang valid" };
    }
    if (geometry.type === "point" && !isValidPoint(geometry)) {
        return { ok: false, reason: "koordinat aset tidak valid" };
    }
    const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : nextId();
    return {
        ok: true,
        asset: Object.freeze({
            id,
            type: canonicalType(input.type),
            geometry: Object.freeze({ ...geometry }),
            metadata: Object.freeze({ ...(input.metadata ?? {}) }),
            watchPolicy: Object.freeze(canonicalWatchPolicy(input.watchPolicy)),
            accessClass: canonicalAccess(input.accessClass, ACCESS_CLASS.AUTHORIZED_USER),
            registeredAt: isFiniteNumber(input.registeredAt) ? input.registeredAt : Date.now(),
            source: typeof input.source === "string" ? input.source : "local_import"
        })
    };
}

/**
 * Registry aset dengan spatial index (bukan O(N) scan per kejadian).
 * Kebijakan privat tetap lokal — registry tidak pernah mengeksport data
 * privat ke log/artefak.
 */
class AssetRegistry {

    constructor({ indexCellM = 10000 } = {}) {
        this.assets = new Map();
        this.index = new GridIndex(indexCellM);
    }

    /** Tambah/perbarui aset. Mengembalikan { ok, asset } atau { ok:false, reason }. */
    upsert(input) {
        const normalized = normalizeAsset(input);
        if (!normalized.ok) return normalized;
        const asset = normalized.asset;
        if (this.assets.has(asset.id)) {
            this.index.remove(asset.id);
        }
        this.assets.set(asset.id, asset);
        if (asset.geometry.type === "point") {
            this.index.insert(asset.id, asset.geometry, asset.type);
        }
        return { ok: true, asset };
    }

    remove(id) {
        if (!this.assets.has(id)) return false;
        this.assets.delete(id);
        this.index.remove(id);
        return true;
    }

    get(id) { return this.assets.get(id) ?? null; }

    list() { return [...this.assets.values()]; }

    /** Aset dalam radius titik — memakai indeks spasial. */
    near(point, radiusM) {
        return this.index.queryRadius(point, radiusM)
            .map(hit => ({ asset: this.assets.get(hit.id), distanceM: hit.distanceM }))
            .filter(x => x.asset);
    }

    get size() { return this.assets.size; }

    clear() {
        this.assets.clear();
        this.index.clear();
    }
}

module.exports = {
    ASSET_TYPE,
    DEFAULT_WATCH_POLICY,
    normalizeAsset,
    canonicalWatchPolicy,
    AssetRegistry
};
