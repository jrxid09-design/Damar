/**
 * AudioOutput — adapter speaker.
 *
 * INGRESS, NEVER AUTHORITY. Modul ini tidak memulai proses: ia tidak
 * me-require `child_process` dan tidak memanggil spawn. Probe dan playback
 * diteruskan sebagai capability `voice.audio` ke runtime milik Manager, yang
 * menolaknya sampai owner meratifikasi grant. Backend "none" tetap no-op.
 */

function runtime() {
    return require("../../manager/bootstrap").getVoiceCapabilityRuntime();
}

class AudioOutput {

    constructor({ backend = "none" } = {}) {
        this.backend = backend;
        this.available = false;
        this._player = null;
    }

    async probe() {
        if (this.backend === "none") { this.available = false; return false; }
        for (const player of ["ffplay", "aplay", "powershell"]) {
            const result = await runtime().execute({ operation: "probeOutput", parameters: { player } });
            if (result.outcome === "EXECUTED_VERIFIED") { this._player = player; break; }
        }
        this.available = this._player !== null;
        return this.available;
    }

    /** Putar buffer audio. Hanya EXECUTED_VERIFIED yang berarti suara keluar. */
    async play(audio) {
        if (!this.available || !audio?.length) return;
        const result = await runtime().execute({
            operation: "play",
            parameters: { player: this._player, audio: Buffer.from(audio) }
        });
        if (result.outcome !== "EXECUTED_VERIFIED") {
            throw new Error(result.reason || "voice playback not authorized");
        }
    }

    async stop() { /* playback selesai di dalam capability; tidak ada proses lokal */ }

    status() {
        return { backend: this.backend, available: this.available, playing: false };
    }
}

module.exports = { AudioOutput };
