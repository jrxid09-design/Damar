const { make, CODES } = require("./ArgumentValidator");

/**
 * TURN CONTROLLER — batas satu giliran, di ATAS LoopGuard yang ada.
 *
 * Bukan sistem pengaman kedua: loopGuard tetap pemilik rem
 * pengulangan (panggilan identik / error identik per jendela waktu).
 * Yang ditambahkan di sini hanyalah anggaran PER GILIRAN yang belum
 * ada sebelumnya:
 *
 *   maxToolCallsPerTurn   total panggilan tool (default 12)
 *   maxRetriesPerTool     percobaan ulang tool yang sama dgn error sama
 *   maxWallClockMs        langit-langit waktu seluruh giliran
 *   cancellation          AbortSignal dari kanal (pengguna batal)
 */

function envInt(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

class TurnController {

    constructor({ signal = null } = {}) {

        this.signal = signal;

        this.startedAt = Date.now();

        this.maxToolCalls = envInt("DAMAR_MAX_TOOL_CALLS_PER_TURN", 12);

        this.maxRetriesPerTool = envInt("DAMAR_MAX_RETRIES_PER_TOOL", 2);

        this.maxWallClockMs = envInt("DAMAR_TURN_WALLCLOCK_MS", 300_000);

        this.totalCalls = 0;

        this.perTool = new Map();   // name → {calls, sameError, lastError}

        // Deteksi siklus (H12): urutan fingerprint panggilan giliran ini.
        // A-A-A tertangkap sameError/sameCall; A-B-A-B butuh urutan.
        this.sequence = [];

        this.errorSequence = [];

        this.MAX_SEQUENCE = 16;

    }

    /** Lempar error terstruktur bila giliran tidak boleh lanjut. */
    assertCanContinue() {

        if (this.signal?.aborted) {
            throw make(CODES.CANCELLED,
                "Permintaan dibatalkan oleh pengguna/kanal.");
        }

        const elapsed = Date.now() - this.startedAt;

        if (elapsed > this.maxWallClockMs) {
            throw make(CODES.TIMEOUT,
                `[TURN_WALLCLOCK] Giliran melebihi ${Math.round(this.maxWallClockMs / 1000)} detik ` +
                `(${this.totalCalls} panggilan tool). Dihentikan agar tidak menggantung.`);
        }

    }

    /** Catat awal panggilan; lempar bila anggaran habis. */
    beginTool(name, args = null) {

        this.assertCanContinue();

        if (this.totalCalls >= this.maxToolCalls) {
            throw make(CODES.POLICY_DENIED,
                `[MAX_TOOL_CALLS] Batas ${this.maxToolCalls} panggilan tool per giliran tercapai. ` +
                "Sampaikan hasil sejauh ini atau tanya pengguna.",
                { code2: "MAX_TOOL_CALLS" });
        }

        this.totalCalls += 1;

        const fingerprint = `${name}:${JSON.stringify(args ?? {})}`;

        const m = this.perTool.get(name) ??
            { calls: 0, sameError: 0, lastError: null, lastFingerprint: null };

        m.calls += 1;
        m.lastFingerprint = fingerprint;

        this.perTool.set(name, m);

    }

    /** Catat akhir panggilan (error = kategori machine-readable). */
    endTool(name, errorCode = null) {

        const m = this.perTool.get(name);

        // Rekam urutan untuk deteksi siklus (fingerprint = nama + argumen
        // disimpan beginTool; error sequence terpisah).
        if (m && m.lastFingerprint) {
            this.sequence.push(m.lastFingerprint);
            if (this.sequence.length > this.MAX_SEQUENCE) this.sequence.shift();
            this._assertNoCycle(this.sequence, "panggilan");
        }

        if (errorCode) {
            this.errorSequence.push(`${name}:${errorCode}`);
            if (this.errorSequence.length > this.MAX_SEQUENCE) this.errorSequence.shift();
            this._assertNoCycle(this.errorSequence, "error");
        }

        if (!m) return;

        if (errorCode && errorCode === m.lastError) {
            m.sameError += 1;
        } else {
            m.sameError = 0;
        }

        m.lastError = errorCode;

        if (m.sameError >= this.maxRetriesPerTool) {
            this.perTool.delete(name);
            throw make(CODES.POLICY_DENIED,
                `[MAX_SAME_ERROR] Tool "${name}" gagal ${m.sameError}× dengan error "${errorCode}" ` +
                "dalam giliran ini. Coba pendekatan lain atau laporkan ke pengguna.",
                { code2: "MAX_SAME_ERROR" });
        }

    }

    /**
     * Siklus = pola periode p (2..4) yang berulang 2× berturut-turut
     * di EKOR urutan. Periode 1 tertangkap mekanisme same-error/call;
     * di sini untuk A-B-A-B dan kawan-kawan. Paginated reads sah tidak
     * membentuk siklus eksak karena fingerprint argumennya berubah.
     */
    _assertNoCycle(seq, label) {

        if (seq.length < 4) return;

        for (let period = 2; period <= 4; period++) {

            const repeats = 2;

            const tail = seq.slice(-(period * repeats));

            if (tail.length < period * repeats) continue;

            let cyclic = true;

            for (let i = period; i < tail.length; i++) {
                if (tail[i] !== tail[i - period]) {
                    cyclic = false;
                    break;
                }
            }

            if (cyclic) {

                // Hentikan giliran dengan alasan jelas (stopRequested).
                this.stopRequested = true;
                this.stopReason =
                    `[LOOP_CYCLE] Terdeteksi siklus ${label} berulang ` +
                    `(${tail.slice(0, period).join(" → ")} → …). Dihentikan — ` +
                    "ganti strategi, bukan mengulang pola yang sama.";

                throw make(CODES.POLICY_DENIED, this.stopReason,
                    { code2: "LOOP_CYCLE", seq: [...seq] });

            }

        }

    }

}

module.exports = { TurnController };

