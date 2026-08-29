#!/usr/bin/env node

// Alias env lama AETHER_* -> DAMAR_* (deprecated; kanonik = DAMAR_*).
require("../src/config/envCompat");

/**
 * Damar launcher — SATU perintah untuk menjalankan daemon (+ Console),
 * dengan tampilan senada CLI dan log rinci berstempel waktu di terminal
 * sekaligus tersimpan ke logs/ untuk investigasi.
 *
 *   npm run damar          → daemon + Console desktop
 *   npm run damar:daemon   → daemon saja
 *
 * Ctrl+C menghentikan semuanya dengan tertib.
 */

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const { c, symbols, banner, hr } = require("../src/cli/theme");

const ROOT = path.join(__dirname, "..");
const withConsole = process.argv.includes("--console");

// ---- Berkas log (riwayat rinci) ------------------------------------
const logDir = path.join(ROOT, "logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `damar-${new Date().toISOString().slice(0, 10)}.log`);
const logStream = fs.createWriteStream(logFile, { flags: "a" });

// Baris bising yang tak perlu tampil di terminal: daftar per-tool tiap plugin
// dan pengumuman "Loaded Plugin / Plugin Loaded" (tetap tersimpan di file log).
const NOISE = /^\s*(└──|├──|└─)|Loaded Plugin\s*:|Plugin Loaded\s*:|injected env|dotenvx?|DEP0190|DeprecationWarning|trace-deprecation/i;

const ts = () => new Date().toISOString();
const clock = () => c.dim(new Date().toTimeString().slice(0, 8));

/** Warnai baris berdasarkan kata kunci level. */
function tint(line) {
    if (/\[ERROR\]|error|gagal|Uncaught|Unhandled|✗/i.test(line)) return c.danger(line);
    if (/\[WARN\]|warn|peringatan|!/i.test(line)) return c.warn(line);
    if (/listening|siap|tersambung|✓|aktif|Loaded/i.test(line)) return c.ok(line);
    return c.text(line);
}

/** Pipa stdout/stderr anak → terminal (berwarna + tag) & berkas log. */
function pipe(child, tag, color) {
    const label = color(`[${tag}]`);
    for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        readline.createInterface({ input: stream }).on("line", line => {
            if (!line.trim()) return;
            // File log tetap lengkap untuk investigasi…
            logStream.write(`${ts()} [${tag}] ${line}\n`);
            // …tapi terminal disaring dari kebisingan (daftar per-tool plugin).
            if (NOISE.test(line)) return;
            process.stdout.write(`${clock()} ${label} ${tint(line)}\n`);
        });
    }
}

const children = [];

function launch(cmd, args, tag, color) {
    // shell hanya untuk npm (npm.cmd di Windows); `node` tak perlu → hindari DEP0190.
    const child = spawn(cmd, args, {
        cwd: ROOT,
        shell: cmd === "npm" && process.platform === "win32",
        // Launcher sudah punya banner sendiri → daemon jangan cetak banner lagi.
        env: { ...process.env, DAMAR_NO_BANNER: "1" }
    });
    pipe(child, tag, color);
    child.on("exit", (code) => {
        process.stdout.write(`${clock()} ${color(`[${tag}]`)} ${c.muted(`berhenti (kode ${code})`)}\n`);
        logStream.write(`${ts()} [${tag}] exited ${code}\n`);
        if (tag === "daemon") shutdown("daemon-exit");
    });
    children.push(child);
    return child;
}

let stopping = false;
function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${clock()} ${c.muted(`menghentikan Damar (${reason})…`)}\n`);
    for (const ch of children) { try { ch.kill(); } catch { /* sudah mati */ } }
    logStream.end();
    setTimeout(() => process.exit(0), 800);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---- Mulai ---------------------------------------------------------
let version = "";
try { version = "v" + require("../package.json").version; } catch { /* opsional */ }

console.log(banner(version).replace("Damar CLI", "Damar Launcher"));
console.log(hr(withConsole ? "daemon + console" : "daemon"));
console.log(`  ${symbols.dot} Log rinci     ${c.muted(path.relative(ROOT, logFile))}`);
console.log(`  ${symbols.dot} Hentikan      ${c.muted("Ctrl+C")}\n`);

launch("node", ["--use-system-ca", "src/server.js"], "daemon", c.accent);

if (withConsole) {
    // Beri daemon waktu listen dulu, lalu buka Console desktop.
    setTimeout(() => launch("npm", ["start", "--prefix", "apps/console"], "console", c.accent3), 2500);
}
