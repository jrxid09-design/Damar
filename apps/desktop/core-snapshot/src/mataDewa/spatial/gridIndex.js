/**
 * Spatial grid index — hash-grid sel tetap untuk lookup radius yang efisien.
 *
 * Dipakai agar "observasi → aset terdekat" dan "aset → observasi relevan"
 * TIDAK memindai seluruh himpunan (menghindari O(N) per kejadian untuk
 * ribuan menara / observasi). Murni in-memory, deterministik, tanpa I/O.
 *
 * Sel berukuran ~cellSizeM; sebuah entri ditempatkan di sel yang memuat
 * titiknya. Query radius memeriksa sel-sel dalam bounding box radius lalu
 * menyaring dengan jarak haversine sebenarnya.
 */

const { haversineMeters, boundingBox, inBoundingBox, isValidPoint } = require("./geo");

const DEFAULT_CELL_M = 25000; // ~25 km — seimbang untuk menara & bahaya region

function cellKey(ix, iy) { return ix + ":" + iy; }

class GridIndex {

    constructor(cellSizeM = DEFAULT_CELL_M) {
        this.cellSizeM = cellSizeM > 0 ? cellSizeM : DEFAULT_CELL_M;
        /** @type {Map<string, Set<string>>} sel → set id entri */
        this.cells = new Map();
        /** @type {Map<string, {lat:number, lon:number, key:string, data:*}>} */
        this.entries = new Map();
    }

    _cellFor(lat, lon) {
        // Proyeksi equirectangular kasar untuk pengindeksan saja.
        const x = (lon + 180) / 360;
        const y = (lat + 90) / 180;
        const cellsX = Math.max(1, Math.round(360 * 111320 / this.cellSizeM));
        const cellsY = Math.max(1, Math.round(180 * 110540 / this.cellSizeM));
        return {
            ix: Math.min(cellsX - 1, Math.floor(x * cellsX)),
            iy: Math.min(cellsY - 1, Math.floor(y * cellsY))
        };
    }

    /**
     * @param {string} id   id unik entri
     * @param {{lat:number, lon:number}} point
     * @param {*} data      payload bebas (referensi aset/observasi)
     */
    insert(id, point, data = null) {
        if (!id || !isValidPoint(point)) return false;
        this.remove(id);
        const { ix, iy } = this._cellFor(point.lat, point.lon);
        const key = cellKey(ix, iy);
        if (!this.cells.has(key)) this.cells.set(key, new Set());
        this.cells.get(key).add(id);
        this.entries.set(id, { lat: point.lat, lon: point.lon, key, data });
        return true;
    }

    remove(id) {
        const entry = this.entries.get(id);
        if (!entry) return false;
        const set = this.cells.get(entry.key);
        if (set) {
            set.delete(id);
            if (set.size === 0) this.cells.delete(entry.key);
        }
        this.entries.delete(id);
        return true;
    }

    /**
     * Semua entri dalam radiusM dari center, disaring jarak sebenarnya.
     * @returns {Array<{id:string, distanceM:number, data:*}>} diurutkan menaik.
     */
    queryRadius(center, radiusM) {
        const out = [];
        if (!isValidPoint(center) || !(radiusM >= 0)) return out;
        const box = boundingBox(center, radiusM);
        if (!box) return out;
        // Rentang sel yang menutupi bounding box.
        const a = this._cellFor(box.minLat, box.minLon);
        const b = this._cellFor(box.maxLat, box.maxLon);
        const seen = new Set();
        for (let ix = a.ix; ix <= b.ix; ix++) {
            for (let iy = a.iy; iy <= b.iy; iy++) {
                const set = this.cells.get(cellKey(ix, iy));
                if (!set) continue;
                for (const id of set) {
                    if (seen.has(id)) continue;
                    seen.add(id);
                    const entry = this.entries.get(id);
                    if (!entry) continue;
                    if (!inBoundingBox(entry, box)) continue;
                    const distanceM = haversineMeters(center, entry);
                    if (distanceM <= radiusM) out.push({ id, distanceM, data: entry.data });
                }
            }
        }
        out.sort((p, q) => p.distanceM - q.distanceM);
        return out;
    }

    /** Entri terdekat, atau null bila kosong. */
    nearest(center, maxRadiusM = Infinity) {
        if (this.entries.size === 0 || !isValidPoint(center)) return null;
        if (maxRadiusM === Infinity) {
            // Pindai linier satu kali hanya bila tanpa batas (jarang dipakai).
            let best = null;
            for (const [id, entry] of this.entries) {
                const distanceM = haversineMeters(center, entry);
                if (!best || distanceM < best.distanceM) best = { id, distanceM, data: entry.data };
            }
            return best;
        }
        const hits = this.queryRadius(center, maxRadiusM);
        return hits.length ? hits[0] : null;
    }

    get size() { return this.entries.size; }

    clear() {
        this.cells.clear();
        this.entries.clear();
    }
}

module.exports = { GridIndex, DEFAULT_CELL_M };
