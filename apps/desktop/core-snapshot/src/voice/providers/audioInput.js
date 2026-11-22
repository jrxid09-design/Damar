/**
 * AudioInput — adapter mikrofon.
 *
 * INGRESS, NEVER AUTHORITY. Modul ini tidak memulai proses: ia tidak
 * me-require `child_process` dan tidak memanggil spawn. Probe, rekam, dan
 * level diteruskan sebagai capability `voice.audio` ke runtime milik Manager,
 * yang menolaknya sampai owner meratifikasi grant. Backend "none" tetap no-op.
 */

const SAMPLE_RATE = 16000;

function runtime() {
    return require("../../manager/bootstrap").getVoiceCapabilityRuntime();
}

class AudioInput {

    constructor({ backend = "none" } = {}) {
        this.backend = backend;
        this.available = false;
        this._recorder = null;
    }

    async probe() {
        if (this.backend === "none") { this.available = false; return false; }
        for (const recorder of ["ffmpeg", "arecord"]) {
            const result = await runtime().execute({ operation: "probeInput", parameters: { recorder } });
            if (result.outcome === "EXECUTED_VERIFIED") { this._recorder = recorder; break; }
        }
        this.available = this._recorder !== null;
        return this.available;
    }

    /** Rekam. Mengembalikan null bila tak terotorisasi — bukan audio kosong
     *  yang bisa dikira hasil. */
    async startCapture({ durationMs = 8000 } = {}) {
        if (this.backend !== "cli" || !this._recorder) return null;
        const result = await runtime().execute({
            operation: "capture",
            parameters: { recorder: this._recorder, durationMs }
        });
        if (result.outcome !== "EXECUTED_VERIFIED") return null;
        return { recorder: this._recorder, digest: result.result.sha256, bytes: result.result.bytes, stop: async () => result.result };
    }

    /** Level audio. onLevel hanya dipanggil dengan angka dari hasil terverifikasi. */
    async startLevelStream(onLevel) {
        if (this.backend !== "cli" || !this._recorder || typeof onLevel !== "function") return null;
        const result = await runtime().execute({
            operation: "level",
            parameters: { recorder: this._recorder, frames: SAMPLE_RATE }
        });
        if (result.outcome !== "EXECUTED_VERIFIED") return null;
        onLevel(result.result.rms);
        return { stop: () => {} };
    }

    status() {
        return { backend: this.backend, available: this.available, recorder: this._recorder };
    }
}

module.exports = { AudioInput, SAMPLE_RATE };
