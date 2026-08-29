/**
 * Mesin status sesi suara — lifecycle eksplisit.
 *
 *   IDLE → WAKE_DETECTED → LISTENING → TRANSCRIBING → THINKING
 *        → EXECUTING → SPEAKING → IDLE
 *
 * Sifatnya adalah otoritas tunggal atas "di mana Damar sekarang".
 * Semua transisi lewat `transit()`, yang memvalidasi agar tidak ada
 * lompatan ilegal (mis. dari IDLE langsung ke SPEAKING) dan mencatat
 * waktu masuk tiap status — dasar timeout & cancellation.
 */

const STATES = Object.freeze({
    IDLE: "idle",
    WAKE_DETECTED: "wake_detected",
    LISTENING: "listening",
    TRANSCRIBING: "transcribing",
    THINKING: "thinking",
    EXECUTING: "executing",
    SPEAKING: "speaking"
});

// Peta transisi sah. Kunci = asal, nilai = himpunan tujuan.
const TRANSISI = Object.freeze({
    [STATES.IDLE]: new Set([STATES.WAKE_DETECTED]),
    [STATES.WAKE_DETECTED]: new Set([STATES.LISTENING, STATES.SPEAKING, STATES.IDLE]),
    [STATES.LISTENING]: new Set([STATES.TRANSCRIBING, STATES.IDLE]),
    [STATES.TRANSCRIBING]: new Set([STATES.THINKING, STATES.IDLE]),
    [STATES.THINKING]: new Set([STATES.EXECUTING, STATES.SPEAKING, STATES.IDLE]),
    [STATES.EXECUTING]: new Set([STATES.SPEAKING, STATES.IDLE]),
    [STATES.SPEAKING]: new Set([STATES.IDLE, STATES.LISTENING]) // barge-in: kembali dengar
});

class StateMachine {

    constructor(onTransition = null) {

        this.state = STATES.IDLE;
        this.enteredAt = Date.now();
        this.onTransition = onTransition; // dipanggil (from, to)

    }

    get current() {
        return this.state;
    }

    /** Berapa ms sejak masuk status sekarang. */
    elapsed(now = Date.now()) {
        return now - this.enteredAt;
    }

    /**
     * Pindah status bila sah.
     * @returns {boolean} true bila pindah, false bila transisi ditolak.
     */
    transit(ke) {

        const from = this.state;

        if (ke === from) return true; // no-op legal

        const sah = TRANSISI[from]?.has(ke);

        if (!sah) return false;

        const lama = this.state;

        this.state = ke;
        this.enteredAt = Date.now();

        if (this.onTransition) {
            try { this.onTransition(lama, ke); }
            catch { /* observer tidak boleh merusak mesin */ }
        }

        return true;

    }

    /** Paksa kembali ke IDLE (reset paksa, mis. cancellation). */
    reset() {
        const lama = this.state;
        this.state = STATES.IDLE;
        this.enteredAt = Date.now();
        if (this.onTransition) {
            try { this.onTransition(lama, STATES.IDLE); }
            catch { /* abaikan */ }
        }
        return this;
    }

    potret() {
        return {
            state: this.state,
            enteredAt: new Date(this.enteredAt).toISOString(),
            elapsedMs: this.elapsed()
        };
    }

}

module.exports = { StateMachine, STATES, TRANSISI };
