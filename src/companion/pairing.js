/**
 * Pairing — alur izin device baru (kode 6 digit + TTL).
 *
 * Alur pairing: PEMILIK menekan "Mulai pairing" di
 * Console → dapat kode 6 digit → DEVICE memasukkan kode itu (lewat halaman
 * web /companion) → device dibuat + dapat token. Device TIDAK butuh token
 * owner untuk join — cukup kode yang dibuat pemilik.
 *
 * Pairing disimpan di MEMORI (bukan JsonStore): ia sementara dan TTL
 * pendek; tidak perlu persisten lintas restart.
 */

const { newPairingCode } = require("./deviceRegistry");

const TTL_MS = 10 * 60 * 1000; // kode berlaku 10 menit

const MAX_PENDING = 5;          // maks permintaan pairing menggantung

class Pairing {

    constructor({ ttlMs = TTL_MS, maxPending = MAX_PENDING } = {}) {

        this.ttlMs = ttlMs;
        this.maxPending = maxPending;

        /** Map code → { id, createdAt, expiresAt } */
        this.pending = new Map();

    }

    /**
     * Pemilik membuat kode pairing baru. Nama device diisi nanti oleh
     * device saat join — di sini cukup kode.
     *
     * @returns {object} { code, expiresAt }
     */
    request() {

        // Buang yang kedaluwarsa dulu.
        this._prune();

        if (this.pending.size >= this.maxPending) {
            const error = new Error("Terlalu banyak permintaan pairing yang menggantung.");
            error.code = "PAIRING_BUSY";
            throw error;
        }

        const id = require("node:crypto").randomUUID();
        const code = newPairingCode();
        const now = Date.now();

        this.pending.set(code, {
            id,
            createdAt: now,
            expiresAt: now + this.ttlMs
        });

        return { code, expiresAt: now + this.ttlMs };

    }

    /**
     * Device "join" dengan kode + nama. Bila kode cocok & belum kedaluwarsa,
     * kembalikan data untuk dibuatkan device dan hapus dari pending.
     *
     * @param {string} code kode 6 digit
     * @param {string} name nama device (dari device)
     * @param {string} kind jenis device
     * @returns {object|null} { id, name, kind } atau null bila kode salah/expired.
     */
    join(code, { name = "device", kind = "device" } = {}) {

        this._prune();

        const entry = this.pending.get(String(code ?? "").trim());

        if (!entry) return null;

        this.pending.delete(code);

        return {
            id: entry.id,
            name: String(name ?? "device").slice(0, 60),
            kind: String(kind ?? "device")
        };

    }

    /** Batalkan satu permintaan (kode). */
    cancel(code) {

        return this.pending.delete(String(code ?? "").trim());

    }

    _prune() {

        const now = Date.now();

        for (const [code, entry] of this.pending) {
            if (now >= entry.expiresAt) this.pending.delete(code);
        }

    }

    /** Daftar permintaan menggantung (untuk UI owner) — tanpa kode. */
    pendingList() {

        this._prune();

        return [...this.pending.values()].map(e => ({
            id: e.id,
            createdAt: new Date(e.createdAt).toISOString(),
            expiresAt: new Date(e.expiresAt).toISOString()
        }));

    }

    count() {
        this._prune();
        return this.pending.size;
    }

}

module.exports = { Pairing, TTL_MS, MAX_PENDING };
