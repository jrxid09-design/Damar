/**
 * Presence Runtime V0 — ledger dedupe fakta berbatas (P29).
 *
 * ID fakta sama + konten kanonik sama  -> DUPLICATE (abaikan, tanpa mutasi).
 * ID fakta sama + konten kanonik beda  -> CONFLICT (catat diagnostik,
 *                                         tanpa overwrite senyap).
 * Ledger punya batas; saat penuh, entri tertua dikeluarkan (FIFO).
 */

function canonicalize(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const body = keys
        .filter((key) => typeof value[key] !== "function")
        .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
        .join(",");
    return `{${body}}`;
}

class DedupeLedger {
    constructor(maxEntries) {
        this._max = maxEntries;
        this._seen = new Map();
        this.duplicateCount = 0;
        this.conflictCount = 0;
    }

    get size() {
        return this._seen.size;
    }

    /**
     * @returns {"FIRST_SEEN"|"DUPLICATE"|"CONFLICT"}
     */
    classify(id, content) {
        const fingerprint = `${id}\u0000${canonicalize(content)}`;
        const existing = this._seen.get(id);
        if (existing === undefined) {
            if (this._seen.size >= this._max) {
                const oldest = this._seen.keys().next().value;
                this._seen.delete(oldest);
            }
            this._seen.set(id, fingerprint);
            return "FIRST_SEEN";
        }
        if (existing === fingerprint) {
            this.duplicateCount += 1;
            return "DUPLICATE";
        }
        this.conflictCount += 1;
        return "CONFLICT";
    }
}

module.exports = { DedupeLedger, canonicalize };
