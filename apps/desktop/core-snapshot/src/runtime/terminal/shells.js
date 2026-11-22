const fs = require("node:fs");

/**
 * Registry shell lintas-OS untuk Terminal Runtime.
 *
 * Hanya mendeteksi & menormalkan shell — TIDAK menyentuh node-pty,
 * jadi aman di-require kapan pun. TerminalRuntime yang memilih shell
 * lewat resolve().
 */

const WIN = process.platform === "win32";

const exists = p => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };

/** Daftar shell yang tersedia di mesin ini. */
function detect() {

    if (!WIN) {
        return [
            { id: "bash", name: "bash", path: process.env.SHELL || "/bin/bash", args: [] }
        ].filter(s => exists(s.path));
    }

    const sys = process.env.SystemRoot || "C:\\Windows";
    const candidates = [
        { id: "powershell", name: "PowerShell", path: `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ["-NoLogo"] },
        { id: "pwsh", name: "PowerShell 7", path: `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`, args: ["-NoLogo"] },
        { id: "cmd", name: "Command Prompt", path: `${sys}\\System32\\cmd.exe`, args: [] },
        { id: "wsl", name: "WSL", path: `${sys}\\System32\\wsl.exe`, args: [] },
        { id: "gitbash", name: "Git Bash", path: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-i", "-l"] },
        { id: "gitbash", name: "Git Bash", path: "C:\\Program Files (x86)\\Git\\bin\\bash.exe", args: ["-i", "-l"] }
    ];

    const out = [];
    const seen = new Set();
    for (const s of candidates) {
        if (seen.has(s.id) || !exists(s.path)) continue;
        seen.add(s.id);
        out.push(s);
    }
    return out;
}

/** Shell default (PowerShell di Windows, bash di lainnya) — atau apa pun yang ada. */
function resolve(shellId) {
    const all = detect();
    if (shellId) {
        const hit = all.find(s => s.id === shellId);
        if (hit) return hit;
    }
    return all[0] || (WIN
        ? { id: "cmd", name: "Command Prompt", path: "cmd.exe", args: [] }
        : { id: "bash", name: "bash", path: "/bin/bash", args: [] });
}

/** Cari executable di PATH (untuk mendeteksi gsudo/sudo). */
function findOnPath(exe) {
    const dirs = String(process.env.PATH || "").split(WIN ? ";" : ":");
    const names = WIN ? [exe, exe + ".exe", exe + ".cmd"] : [exe];
    for (const dir of dirs) {
        for (const n of names) {
            const p = `${dir}${WIN ? "\\" : "/"}${n}`;
            if (exists(p)) return p;
        }
    }
    return null;
}

/**
 * Bungkus shell agar berjalan elevated bila memungkinkan.
 * Windows: gsudo (bila terpasang). POSIX: sudo (prompt password tampil
 * di pty). Kembalikan { path, args } terbungkus, atau null bila tak bisa
 * (mis. Windows tanpa gsudo → daemon harus dijalankan sebagai Admin).
 */
function firstExisting(paths) {
    for (const p of paths) if (exists(p)) return p;
    return null;
}

function elevate(shellPath, args = []) {
    if (WIN) {
        // PATH daemon sering basi setelah `winget install` (gsudo belum
        // terlihat sampai proses direstart), jadi cek juga lokasi bakunya.
        const gsudo = findOnPath("gsudo") || firstExisting([
            `${process.env.ProgramFiles || "C:\\Program Files"}\\gsudo\\current\\gsudo.exe`,
            `${process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"}\\gsudo\\current\\gsudo.exe`,
            `${process.env.LOCALAPPDATA || ""}\\Microsoft\\WinGet\\Links\\gsudo.exe`
        ]);
        return gsudo ? { path: gsudo, args: [shellPath, ...args] } : null;
    }
    const sudo = findOnPath("sudo");
    return sudo ? { path: sudo, args: [shellPath, ...args] } : null;
}

module.exports = { detect, resolve, elevate, isWindows: WIN };
