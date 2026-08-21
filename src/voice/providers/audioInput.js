/**
 * AudioInput — abstraksi mikrofon/input.
 *
 * Aether harus bisa mendengar dari: mic PC, USB, headset, Raspberry Pi,
 * Aether-USB, dsb — tanpa mengubah VoiceRuntime. Backend default "none"
 * (graceful: tidak crash bila alat audio tak ada). Backend "cli" merekam
 * lewat CLI lokal:
 *
 *   - ffmpeg (lintas-platform, disarankan) — Windows: -f dshow; Linux: -f alsa/pulse
 *   - arecord (Linux ALSA) sebagai fallback
 *
 * Yang TIDAK dilakukan di sini: tidak ada dependency native audio Node.
 * PowerShell TIDAK dipakai untuk rekam — System.Speech adalah RECOGNIZER,
 * bukan perekam; tidak menghasilkan berkas audio.
 */

const SAMPLE_RATE = 16000; // 16 kHz mono — cocok untuk faster-whisper STT

class AudioInput {

    /** @param {string} backend "none" | "cli" */
    constructor({ backend = "none" } = {}) {
        this.backend = backend;
        this.available = false;
        this._recorder = null; // perintah rekam yang terdeteksi
        this._child = null;
    }

    /**
     * Deteksi perintah rekam yang tersedia (tanpa melempar).
     * @returns {Promise<string|null>} nama perintah ("ffmpeg"|"arecord"|null)
     */
    async _detectRecorder() {

        const { execFile } = require("node:child_process");
        const { promisify } = require("node:util");
        const pexec = promisify(execFile);

        // ffmpeg lebih disukai (lintas-platform, dshow di Windows).
        try {
            await pexec("ffmpeg", ["-version"], { timeout: 3000 });
            return "ffmpeg";
        }
        catch { /* lanjut fallback */ }

        // arecord (Linux ALSA).
        if (process.platform !== "win32") {
            try {
                await pexec("arecord", ["--version"], { timeout: 3000 });
                return "arecord";
            }
            catch { /* lanjut */ }
        }

        return null;

    }

    /**
     * Cek ketersediaan input. Tidak melempar — hanya melaporkan.
     * @returns {Promise<boolean>}
     */
    async probe() {

        if (this.backend === "none") {
            this.available = false;
            return false;
        }

        this._recorder = await this._detectRecorder();

        this.available = this._recorder !== null;

        return this.available;

    }

    /**
     * Mulai rekam ke berkas WAV sementara.
     *
     * @returns {Promise<{stop: Function, file?: string} | null>}
     */
    async startCapture({ durationMs = 8000 } = {}) {

        if (this.backend !== "cli") return null;

        if (!this._recorder) {
            await this.probe();
        }

        if (!this._recorder) return null;

        const os = require("node:os");
        const path = require("node:path");
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-mic-"));
        const file = path.join(dir, "rec.wav");

        const seconds = Math.max(1, Math.ceil(durationMs / 1000));

        const { args, cmd } = this._recorder === "ffmpeg"
            ? this._ffmpegArgs(file, seconds)
            : this._arecordArgs(file, seconds);

        const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });

        this._child = child;

        return {
            file,
            recorder: this._recorder,
            stop: async () => {

                // Hentikan perekam, tunggu sebentar agar berkas ter-flush.
                try { child.kill("SIGKILL"); } catch { /* abaikan */ }
                this._child = null;

                await new Promise(r => setTimeout(r, 250));

                try {
                    return fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
                }
                catch {
                    return Buffer.alloc(0);
                }
                finally {
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* abaikan */ }
                }

            }
        };

    }

    /**
     * Argumen ffmpeg: rekam 16 kHz mono WAV selama `seconds` detik.
     * Windows pakai dshow (mic default); Linux pakai alsa default.
     */
    _ffmpegArgs(file, seconds) {

        const input = process.platform === "win32"
            ? ["-f", "dshow", "-i", "audio=default"]
            : ["-f", "alsa", "-i", "default"];

        return {
            cmd: "ffmpeg",
            args: [
                ...input,
                "-t", String(seconds),
                "-ar", String(SAMPLE_RATE),
                "-ac", "1",
                "-c:a", "pcm_s16le",
                "-y",
                file
            ]
        };

    }

    _arecordArgs(file, seconds) {

        return {
            cmd: "arecord",
            args: [
                "-f", "S16_LE",
                "-r", String(SAMPLE_RATE),
                "-c", "1",
                "-d", String(seconds),
                file
            ]
        };

    }

    status() {
        return { backend: this.backend, available: this.available, recorder: this._recorder };
    }

}

module.exports = { AudioInput, SAMPLE_RATE };
