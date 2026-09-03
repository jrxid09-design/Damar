/**
 * Spatial Timeline — riwayat observasi/event yang TERBATAS.
 *
 * Cukup untuk menjawab: "apa yang berubah di sini?", "apakah ini sudah ada
 * sebelumnya?", "apa yang terjadi di sekitar lokasi ini?".
 * BUKAN Digital Twin penuh — buffer dibatasi (maxEntries, retentionMs) dan
 * di-indeks spasial agar query lokasi efisien.
 */

const { GridIndex } = require("../spatial/gridIndex");
const { isValidPoint, isFiniteNumber } = require("../spatial/geo");

class SpatialTimeline {

    /**
     * @param {{ maxEntries?: number, retentionMs?: number, indexCellM?: number, clock?: {nowMs():number} }} options
     */
    constructor({ maxEntries = 10000, retentionMs = 24 * 60 * 60 * 1000, indexCellM = 25000, clock = { nowMs: () => Date.now() } } = {}) {
        this.maxEntries = maxEntries;
        this.retentionMs = retentionMs;
        this.clock = clock;
        /** @type {Map<string, object>} id → record (observasi atau event) */
        this.records = new Map();
        this.index = new GridIndex(indexCellM);
        this._insertionOrder = [];
    }

    /**
     * Rekam observasi/event ke timeline.
     * @param {object} record SpatialObservation | SpatialEvent
     * @param {{ kind?: "observation"|"event" }} meta
     */
    record(record, { kind = "observation" } = {}) {
        if (!record || !record.id) return false;
        const geometry = record.geometry ?? (record.location ? { type: "point", ...record.location } : null);
        const entry = {
            id: record.id,
            kind,
            type: record.type ?? "generic",
            geometry,
            atMs: record.observedAt ?? record.lastObservedAt ?? this.clock.nowMs(),
            recordedAt: this.clock.nowMs(),
            record
        };
        // Ganti bila id sudah ada (update event yang sama).
        if (this.records.has(record.id)) this._remove(record.id);
        this.records.set(record.id, entry);
        if (geometry?.type === "point") this.index.insert(record.id, geometry, kind);
        this._insertionOrder.push(record.id);
        this._enforceBounds();
        return true;
    }

    _remove(id) {
        this.records.delete(id);
        this.index.remove(id);
    }

    _enforceBounds() {
        const nowMs = this.clock.nowMs();
        // Retensi waktu.
        for (const [id, entry] of this.records) {
            if (nowMs - entry.recordedAt > this.retentionMs) this._remove(id);
        }
        // Batas jumlah (buang yang paling lama direkam).
        while (this.records.size > this.maxEntries) {
            const oldest = this._insertionOrder.shift();
            if (oldest === undefined) break;
            this._remove(oldest);
        }
        // Bersihkan id basi di antrean.
        if (this._insertionOrder.length > this.maxEntries * 2) {
            this._insertionOrder = this._insertionOrder.filter(id => this.records.has(id));
        }
    }

    /** Semua record dalam radius dari titik, diurutkan terbaru dulu. */
    near(point, radiusM, { type = null, kind = null, sinceMs = null } = {}) {
        if (!isValidPoint(point) || !(radiusM >= 0)) return [];
        return this.index.queryRadius(point, radiusM)
            .map(hit => ({ entry: this.records.get(hit.id), distanceM: hit.distanceM }))
            .filter(x => x.entry)
            .filter(x => !type || x.entry.type === type)
            .filter(x => !kind || x.entry.kind === kind)
            .filter(x => !isFiniteNumber(sinceMs) || x.entry.atMs >= sinceMs)
            .map(x => ({ record: x.entry.record, distanceM: x.distanceM, atMs: x.entry.atMs }))
            .sort((a, b) => b.atMs - a.atMs);
    }

    /** Record dalam rentang waktu (semua lokasi), terbaru dulu. */
    between(fromMs, toMs, { type = null, kind = null } = {}) {
        const out = [];
        for (const entry of this.records.values()) {
            if (entry.atMs < fromMs || entry.atMs > toMs) continue;
            if (type && entry.type !== type) continue;
            if (kind && entry.kind !== kind) continue;
            out.push({ record: entry.record, atMs: entry.atMs });
        }
        out.sort((a, b) => b.atMs - a.atMs);
        return out;
    }

    /** Apakah sebuah tipe sudah terlihat di titik ini sebelumnya (untuk change detection). */
    seenBefore(point, radiusM, type, beforeMs) {
        return this.near(point, radiusM, { type })
            .some(hit => hit.atMs < beforeMs);
    }

    get size() { return this.records.size; }

    clear() {
        this.records.clear();
        this.index.clear();
        this._insertionOrder = [];
    }
}

module.exports = { SpatialTimeline };
