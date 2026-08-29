const { spawn } = require("node:child_process");

const fs = require("node:fs");

const { AITool } = require("../ai/tools");

const telemetry = require("./telemetryService");

/**
 * Jembatan Damar → opencode.
 *
 * Agent coding (Nakula, dan damar lewat profil `coding`) mendelegasikan
 * pekerjaan menulis/mengubah kode ke opencode — agent coding yang sudah
 * terlatih, punya akses tool editor penuh (baca/tulis berkas, terminal,
 * git, LSP) dan konfigurasi proyek (.opencode/opencode.json: serena,
 * graphify). Damar cukup memberikan instruksi; opencode yang bekerja.
 *
 * Alur di mesh Damar:
 *   user → damar (orkestrator) → agent forge → opencode_run
 *
 * `opencode run` dipanggil tanpa TUI, output teks ditangkap penuh.
 * Sesi dipertahankan per-purpose supaya percakapan lanjutan (revisi,
 * lanjut pekerjaan) tidak kehilangan konteks.
 */

/**
 * Lokasi opencode berbeda menurut OS daemon:
 *
 *   - Daemon LINUX:  binary ELF di ~/.opencode/bin/opencode, PATH
 *     shell interaktif, atau /usr/local/bin.
 *   - Daemon WINDOWS (termasuk lewat interop WSL): opencode biasanya
 *     terpasang DI DALAM WSL sebagai binary ELF — tidak bisa di-spawn
 *     langsung. Jembatannya: `wsl.exe -d <distro> -- opencode ...`,
 *     dengan path proyek diterjemahkan C:\ → /mnt/c.
 *
 * Env DAMAR_OPENCODE_BIN menimpa semua deteksi (mis. full path ke
 * binary, atau "wsl:Ubuntu" untuk memilih distro).
 */

/** Nama distro WSL bila jembatan wsl.exe dipakai. */
function wslDistro() {
    return process.env.DAMAR_OPENCODE_WSL || null;
}

/** C:\Workspace\Aether → /mnt/c/Workspace/Aether (untuk opencode di WSL). */
function toWslPath(dir) {

    const s = String(dir ?? "");

    const match = s.match(/^([a-zA-Z]):[\\/](.*)$/);

    if (!match) return s;

    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;

}

/**
 * Bentuk perintah siap-spawn: { command, args, cwd, wsl }.
 *
 * Memutuskan SEKALI per panggilan bagaimana opencode dijalankan di
 * mesin ini — langsung, atau lewat wsl.exe.
 */
function resolveRunner(dir) {

    const envBin = process.env.DAMAR_OPENCODE_BIN;

    const isWindows = process.platform === "win32";

    const homeOpencode = require("node:path").join(
        process.env.HOME && !/^[a-zA-Z]:/.test(process.env.HOME)
            ? process.env.HOME
            : "",
        ".opencode", "bin", "opencode"
    );

    // --- Daemon Windows ------------------------------------------------

    if (isWindows) {

        // Binary opencode.exe natif Windows bila ada.
        if (envBin) {
            return { command: envBin, args: [], cwd: dir, wsl: false };
        }

        // Default: opencode di dalam WSL, dijembatani wsl.exe.
        // Non-login shell TIDAK memuat ~/.opencode/bin ke PATH, jadi
        // opencode dipanggil dengan full path via bash login-shell.
        // Path proyek juga diterjemahkan agar sesuai sudut pandang WSL.
        const wslDir = toWslPath(dir || process.cwd());

        const prefix = ["-e", "bash", "-lc"];

        if (wslDistro()) prefix.unshift("-d", wslDistro());

        return {
            command: "wsl.exe",
            args: prefix,
            bin: "$HOME/.opencode/bin/opencode",
            cwd: dir || process.cwd(),
            wsl: true,
            wslDir
        };

    }

    // --- Daemon linux ---------------------------------------------------

    if (envBin) {
        return { command: envBin, args: [], cwd: dir, wsl: false };
    }

    for (const kandidat of ["opencode", homeOpencode, "/usr/local/bin/opencode", "/usr/bin/opencode"]) {

        if (!kandidat || kandidat.includes("\\")) continue;

        if (!kandidat.includes("/")) {
            return { command: kandidat, args: [], cwd: dir, wsl: false };
        }

        try {
            fs.accessSync(kandidat, fs.constants.X_OK);
            return { command: kandidat, args: [], cwd: dir, wsl: false };
        }
        catch { /* lanjut */ }

    }

    return { command: "opencode", args: [], cwd: dir, wsl: false };

}

/** Quote aman satu argumen untuk string perintah bash. */
function shellQuote(s) {
    return "'" + String(s ?? "").replace(/'/g, "'\\''") + "'";
}

/** Timeout default satu tugas (menit opencode bisa panjang). */
function timeoutMs() {
    return Number(process.env.DAMAR_OPENCODE_TIMEOUT_MS || 900000);
}

/** Batas output yang dibawa balik ke model (karakter). */
const MAX_OUTPUT = 16000;

const tail = (text, n = MAX_OUTPUT) =>
    String(text ?? "").length > n
        ? `…(terpotong, bagian akhir)\n${String(text).slice(-n)}`
        : String(text ?? "");

/** Sesi berjalan per-purpose: lanjut pekerjaan = konteks lanjut. */
const sessions = new Map();

function sessionKey({ purpose, dir }) {
    // Normalisasi Windows ↔ WSL: satu purpose = satu sesi, apa pun
    // bentuk penulisan path-nya.
    const d = String(dir ?? process.cwd()).replace(/\\/g, "/").replace(/^([a-zA-Z]):/i, (m) => `/mnt/${m[0].toLowerCase()}`);
    return `${purpose}@${d}`;
}

function rememberSession(key, id) {
    sessions.set(key, id);
    // Jaga peta kecil — 50 konteks terakhir cukup.
    if (sessions.size > 50) sessions.delete(sessions.keys().next().value);
}

/**
 * Jalankan `opencode run`.
 *
 * Di Windows, opencode dijembatani lewat `wsl.exe -e bash -lc "<perintah>"`
 * sebagai SATU string perintah (supaya $HOME dan quoting dievaluasi oleh
 * bash). Di linux, spawn langsung dengan array argumen.
 */
function runOpenCode({ instruction, dir, purpose, agent, model, fresh }) {

    const key = sessionKey({ purpose, dir });

    const prevSession = fresh ? null : sessions.get(key) ?? null;

    const runner = resolveRunner(dir);

    // --dir diterjemahkan ke sudut pandang runner: opencode di WSL
    // butuh /mnt/c/... meski daemon Windows memberi C:\...
    const effectiveDir = runner.wsl ? runner.wslDir : (dir || process.cwd());

    const opencodeArgs = ["run", "--format", "json"];

    if (prevSession) opencodeArgs.push("--session", prevSession);

    if (agent) opencodeArgs.push("--agent", agent);

    if (model) opencodeArgs.push("--model", model);

    opencodeArgs.push("--dir", effectiveDir, "--", String(instruction));

    let command = runner.command;
    let args = opencodeArgs;
    let cwd = runner.wsl ? undefined : runner.cwd;

    if (runner.wsl) {

        // Rangkai SATU string perintah bash: $HOME dievaluasi bash,
        // instruksi & path di-quote aman (tidak ada injeksi shell —
        // instruksi adalah data, dibungkus single-quote dengan escape).
        const sh = opencodeArgs.map(shellQuote).join(" ");

        args = [...runner.args, `${runner.bin} ${sh}`];

        cwd = undefined;

    }

    return new Promise((resolve) => {

        const started = Date.now();

        const child = spawn(command, args, {

            cwd,

            env: { ...process.env, NO_COLOR: "1", CI: "1" },

            stdio: ["ignore", "pipe", "pipe"],

            windowsHide: true

        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });

        const batas = setTimeout(() => {

            child.kill("SIGKILL");

            resolve({
                ok: false,
                error: `opencode timeout setelah ${Math.round(timeoutMs() / 1000)}s`,
                output: tail(stdout)
            });

        }, timeoutMs());

        child.on("error", (error) => {

            clearTimeout(batas);

            resolve({
                ok: false,
                error:
                    `opencode tidak bisa dijalankan via "${runner.command}" (${error.message}). ` +
                    "Pastikan opencode terpasang (opencode.ai). Di Windows, opencode " +
                    "dijalankan lewat WSL — atau set DAMAR_OPENCODE_BIN ke binary " +
                    "opencode yang bisa dieksekusi daemon.",
                output: null
            });

        });
        child.on("close", (code) => {

            clearTimeout(batas);

            const parsed = parseJsonStream(stdout);

            if (parsed.sessionId) rememberSession(key, parsed.sessionId);

            telemetry.publish("opencode:run", {
                purpose: purpose ?? null,
                dir: dir ?? null,
                code,
                ms: Date.now() - started
            });

            if (code === 0 && parsed.text) {
                resolve({ ok: true, output: tail(parsed.text), sessionId: parsed.sessionId });
                return;
            }

            resolve({
                ok: code === 0,
                error: code !== 0
                    ? `opencode keluar dengan kode ${code}`
                    : "opencode selesai tanpa jawaban",
                output: tail(parsed.text || clean(stderr || stdout))
            });

        });

    });

}

/**
 * Baca aliran NDJSON `opencode run --format json`.
 *
 * Teks jawaban = gabungan semua part "text"; sessionId diambil dari
 * event pertama yang membawanya.
 */
function parseJsonStream(stdout) {

    const text = [];
    let sessionId = null;

    for (const line of String(stdout ?? "").split(/\r?\n/)) {

        const trimmed = line.trim();

        if (!trimmed.startsWith("{")) continue;

        let event;

        try { event = JSON.parse(trimmed); }
        catch { continue; }

        if (!sessionId && event.sessionID) sessionId = event.sessionID;

        if (event.type === "text" && event.part?.text) {
            text.push(event.part.text);
        }

    }

    return { text: text.join("\n").trim(), sessionId };

}

/** Buang baris status/branding opencode — sisakan jawaban saja. */
function clean(text) {

    return String(text ?? "")

        .split(/\r?\n/)

        .filter(line => !/^\s*$/)                          // baris kosong ganda

        .filter(line => !/branding|^\s*▄|^█|^\s*▀/i.test(line))

        .filter(line => !/^\s*(>|\$)\s*(build|plan|primary|general)\b/i.test(line))

        .join("\n")

        .trim();

}

function opencodeTools() {

    return [

        new AITool({

            name: "opencode_run",

            description:
                "Delegasikan tugas CODING ke opencode — agent coding dengan akses " +
                "editor penuh (baca/tulis berkas, terminal, git, LSP) dan konfigurasi " +
                "proyek ini (serena + graphify). WAJIB dipakai untuk mengubah kode, " +
                "memperbaiki bug, refactoring, menjalankan test, atau commit — jangan " +
                "tulis patch manual lewat filesystem. Berikan instruksi lengkap dan " +
                "spesifik (bahasa Indonesia boleh); opencode yang mengeksekusinya. " +
                "Sesi dipertahankan per purpose: tugas lanjutan (revisi/iterasi) " +
                "otomatis melanjutkan konteks sebelumnya.",

            parameters: {

                type: "object",

                properties: {

                    instruction: {
                        type: "string",
                        description:
                            "Instruksi lengkap untuk opencode: apa yang harus dilakukan, " +
                            "file/scope mana, kriteria selesai. Mis. 'perbaiki bug di " +
                            "src/services/x.js baris 40 lalu jalankan test'."
                    },

                    purpose: {
                        type: "string",
                        description:
                            "Kunci sesi stabil (mis. 'forge', 'refactor-auth', 'fix-login'). " +
                            "Tugas lanjutan dengan purpose sama melanjutkan konteks."
                    },

                    dir: {
                        type: "string",
                        description: "Direktori proyek (default: root Damar)."
                    },

                    agent: {
                        type: "string",
                        description: "Agent opencode yang dipakai (mis. 'build', 'plan'). Opsional."
                    },

                    model: {
                        type: "string",
                        description: "Override model, format 'provider/model'. Opsional."
                    },

                    fresh: {
                        type: "boolean",
                        description: "Mulai sesi baru, abaikan konteks purpose sebelumnya."
                    }

                },

                required: ["instruction"]

            },

            execute: async ({ instruction, purpose = "forge", dir, agent, model, fresh }) =>

                runOpenCode({ instruction, purpose, dir, agent, model, fresh })

        })

    ];

}

module.exports = { opencodeTools, runOpenCode };

