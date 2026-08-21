/**
 * AudioOutput — abstraksi speaker/output.
 *
 * Aether harus bisa bicara lewat: speaker PC, headset, HDMI, Raspberry Pi,
 * Aether-USB, dsb. Backend default "none" (graceful). Backend "cli" memutar
 * audio lewat CLI lokal sebagai PROSES (spawn) — sehingga bisa di-interrupt
 * (barge-in) lewat this._child.
 *
 *   - Windows : ffplay (ffmpeg) atau PowerShell SoundPlayer (fallback)
 *   - Linux   : ffplay / aplay
 *
 * Yang TIDAK dilakukan: tidak ada dependency native audio Node. TTS tetap
 * lewat voiceService; modul ini hanya MEMUTAR hasilnya.
 */

class AudioOutput {

    constructor({ backend = "none" } = {}) {
        this.backend = backend;
        this.available = false;
        this._child = null; // proses pemutar aktif — bisa di-interrupt
        this._player = null; // perintah pemutar yang terdeteksi ("ffplay"|"aplay"|"powershell")
    }

    async probe() {

        if (this.backend === "none") {
            this.available = false;
            return false;
        }

        const { execFile } = require("node:child_process");
        const { promisify } = require("node:util");
        const pexec = promisify(execFile);

        const has = async (cmd, args) => {
            try { await pexec(cmd, args, { timeout: 3000 }); return true; }
            catch { return false; }
        };

        // ffplay lintas-platform lebih disukai.
        if (await has("ffplay", ["-version"])) {
            this._player = "ffplay";
        }
        else if (process.platform === "win32" && await has("powershell", ["-NoProfile", "-Command", "exit 0"])) {
            this._player = "powershell";
        }
        else if (process.platform !== "win32" && await has("aplay", ["--version"])) {
            this._player = "aplay";
        }
        else {
            this._player = null;
        }

        this.available = this._player !== null;

        return this.available;

    }

    /**
     * Putar buffer audio sebagai proses yang bisa di-interrupt.
     *
     * Backend "none" = no-op (diam, tidak error).
     *
     * @param {Buffer} audio
     * @returns {Promise<void>} resolve saat selesai ATAU saat di-stop.
     */
    async play(audio) {

        if (!this.available || !audio?.length) return;

        const os = require("node:os");
        const path = require("node:path");
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-spk-"));
        const file = path.join(dir, "out.mp3");

        try {

            fs.writeFileSync(file, audio);

            const { cmd, args } = this._playerArgs(file);

            const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });

            this._child = child;

            // Resolve saat proses selesai (termasuk bila dibunuh oleh stop()).
            await new Promise((resolve, reject) => {

                let settled = false;

                const done = (err) => {
                    if (settled) return;
                    settled = true;
                    if (this._child === child) this._child = null;
                    err ? reject(err) : resolve();
                };

                child.once("error", done);
                child.once("exit", (code) => {
                    // kode null = dibunuh sinyal (barge-in) → bukan error.
                    done(code && code !== 0 ? new Error(`pemutar keluar kode ${code}`) : null);
                });

            });

        }
        finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* abaikan */ }
        }

    }

    /** Susun perintah pemutar sesuai platform & yang terdeteksi. */
    _playerArgs(file) {

        if (this._player === "powershell") {
            // Fallback Windows: SoundPlayer (blocking, tapi bisa di-kill).
            return {
                cmd: "powershell",
                args: ["-NoProfile", "-Command",
                    `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]
            };
        }

        if (this._player === "aplay") {
            return { cmd: "aplay", args: ["-q", file] };
        }

        // default: ffplay
        return {
            cmd: "ffplay",
            args: ["-nodisp", "-autoexit", "-loglevel", "quiet", file]
        };

    }

    /** Berhenti bicara (barge-in). Membunuh proses pemutar aktif. */
    async stop() {

        const child = this._child;

        if (!child) return;

        this._child = null;

        try { child.kill("SIGKILL"); } catch { /* abaikan */ }

        // Pastikan promise play() yang sedang menunggu diakhiri.
        // child.once("exit") akan terpicu oleh kill di atas.

    }

    status() {
        return { backend: this.backend, available: this.available, playing: Boolean(this._child) };
    }

}

module.exports = { AudioOutput };
