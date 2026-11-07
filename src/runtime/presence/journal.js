/**
 * Presence Runtime V0 — jurnal peristiwa berbatas (P19).
 *
 * Setiap entri: sequence, generation, from, to, activity, cause,
 * producerId, timestampMs (numerik), reason. Jurnal immutable: pembaca
 * menerima salinan terpisah (detached), tidak ada referensi internal.
 * Tidak ada konten percakapan mentah.
 */

class PresenceJournal {
    constructor(maxHistory) {
        this._max = maxHistory;
        this._entries = [];
        this._seq = 0;
    }

    get size() {
        return this._entries.length;
    }

    append(entry) {
        this._seq += 1;
        const record = Object.freeze({
            sequence: this._seq,
            generation: entry.generation,
            from: entry.from,
            to: entry.to,
            activity: entry.activity ?? null,
            cause: entry.cause,
            producerId: entry.producerId ?? null,
            timestampMs: entry.timestampMs,
            reason: entry.reason ? String(entry.reason).slice(0, 200) : null
        });
        this._entries.push(record);
        if (this._entries.length > this._max) {
            this._entries.splice(0, this._entries.length - this._max);
        }
        return record;
    }

    /** Salinan detached, terbaru terakhir. */
    snapshot() {
        return this._entries.map((entry) => ({ ...entry }));
    }
}

module.exports = { PresenceJournal };
