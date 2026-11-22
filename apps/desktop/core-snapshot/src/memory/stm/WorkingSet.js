/**
 * Short-Term Memory (STM) — working set dalam-proses milik Damar Core.
 *
 * Per "scope" (mis. chat/jid, tugas, sesi) menyimpan lima buffer:
 *   conversation — giliran percakapan bergulir
 *   scratchpad   — catatan sementara Damar saat berpikir
 *   active       — konteks/entitas yang sedang difokuskan
 *   reasoning    — rencana, sub-tujuan, hasil antara
 *   tool         — pemanggilan tool + hasil (mis. ekor output terminal)
 *
 * Bounded (ring per buffer) + TTL sweep supaya tak membengkak. STM
 * bebas ditulis (tak butuh persetujuan); ringkasannya menjadi bahan
 * proposal LTM di subsistem Consolidation/Governance. Semua di memori
 * (hilang saat daemon restart) — memang sifat STM.
 */

const MAX_PER_BUFFER = 50;
const TTL_MS = 60 * 60 * 1000;   // scope idle 1 jam → dibersihkan

const BUFFERS = ["conversation", "scratchpad", "active", "reasoning", "tool"];

class WorkingSet {

    constructor() {
        this.scopes = new Map();   // scopeId → { buffers, touchedAt }
        this._sweep = setInterval(() => this.sweep(), 10 * 60 * 1000);
        this._sweep.unref?.();
    }

    _scope(id) {
        const key = String(id || "default");
        if (!this.scopes.has(key)) {
            const buffers = {};
            for (const b of BUFFERS) buffers[b] = [];
            this.scopes.set(key, { buffers, touchedAt: Date.now() });
        }
        const s = this.scopes.get(key);
        s.touchedAt = Date.now();
        return s;
    }

    /** Catat kejadian ke sebuah buffer STM. */
    observe(scopeId, { buffer = "conversation", role = null, text = "", meta = {} } = {}) {
        const s = this._scope(scopeId);
        const arr = s.buffers[buffer] || (s.buffers[buffer] = []);
        arr.push({ role, text: String(text ?? ""), meta, at: Date.now() });
        while (arr.length > MAX_PER_BUFFER) arr.shift();
        return true;
    }

    /** Isi satu buffer. */
    get(scopeId, buffer = "conversation") {
        return this._scope(scopeId).buffers[buffer] || [];
    }

    /** Seluruh working set sebuah scope. */
    snapshot(scopeId) {
        const s = this._scope(scopeId);
        const out = {};
        for (const b of BUFFERS) out[b] = s.buffers[b] || [];
        return out;
    }

    /** Teks datar untuk diringkas (bahan konsolidasi → proposal LTM). */
    summarizeInput(scopeId) {
        const s = this._scope(scopeId);
        const lines = [];
        for (const b of BUFFERS) {
            for (const e of s.buffers[b] || []) {
                if (e.text.trim()) lines.push(`[${b}${e.role ? "/" + e.role : ""}] ${e.text}`);
            }
        }
        return lines.join("\n");
    }

    clear(scopeId, buffer = null) {
        const s = this._scope(scopeId);
        if (buffer) s.buffers[buffer] = [];
        else for (const b of BUFFERS) s.buffers[b] = [];
        return true;
    }

    /** Buang scope yang idle melewati TTL. */
    sweep() {
        const now = Date.now();
        for (const [k, s] of this.scopes) if (now - s.touchedAt > TTL_MS) this.scopes.delete(k);
    }

    stats() {
        return { scopes: this.scopes.size, buffers: BUFFERS };
    }

}

module.exports = new WorkingSet();
module.exports.BUFFERS = BUFFERS;
