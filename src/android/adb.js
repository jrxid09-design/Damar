const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const pexec = promisify(execFile);
const OPTS = { timeout: 30000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };

/**
 * adb — kendali perangkat Android untuk Aether, lewat Android Debug
 * Bridge yang sudah terpasang.
 *
 * Semua perintah butuh perangkat terhubung (USB dengan USB-debugging,
 * atau `adb connect ip:port` untuk nirkabel) — milik pemilik. Aksi yang
 * mengetuk/mengetik/menjalankan shell diperlakukan DESTRUKTIF (lewat
 * gerbang konfirmasi), seperti kendali desktop.
 */

const ADB = process.env.AETHER_ADB_BIN || "adb";

async function adb(args, { timeout } = {}) {
    const { stdout, stderr } = await pexec(ADB, args, { ...OPTS, ...(timeout ? { timeout } : {}) });
    return (stdout || stderr || "").toString();
}

/** Perangkat terhubung: [{ serial, state, model? }]. */
async function devices() {
    let out;
    try { out = await adb(["devices", "-l"]); }
    catch (e) { return { ok: false, error: (e.stderr || e.message || "").toString().slice(-500) }; }

    const list = out.split(/\r?\n/).slice(1)
        .map(l => l.trim()).filter(Boolean)
        .map(l => {
            const m = l.match(/^(\S+)\s+(\S+)(.*)$/);
            if (!m) return null;
            const model = (m[3].match(/model:(\S+)/) || [])[1];
            return { serial: m[1], state: m[2], model: model || null };
        })
        .filter(Boolean);

    return { ok: true, devices: list, count: list.length };
}

/** Serial efektif: eksplisit → satu-satunya perangkat siap → error. */
async function resolveSerial(serial) {
    if (serial) return serial;
    const d = await devices();
    if (!d.ok) throw new Error(d.error);
    const ready = d.devices.filter(x => x.state === "device");
    if (ready.length === 1) return ready[0].serial;
    if (ready.length === 0) throw new Error("Tak ada perangkat Android siap. Hubungkan HP (USB-debugging) atau `adb connect ip:port`.");
    throw new Error(`Ada ${ready.length} perangkat — sebutkan serial: ${ready.map(x => x.serial).join(", ")}`);
}

function argsFor(serial, rest) { return serial ? ["-s", serial, ...rest] : rest; }

/** Jalankan perintah shell mentah di perangkat. */
async function shell(cmd, { serial, timeout } = {}) {
    let s;
    try { s = await resolveSerial(serial); }
    catch (e) { return { ok: false, error: e.message }; }
    try {
        const out = await adb(argsFor(s, ["shell", cmd]), { timeout });
        return { ok: true, serial: s, output: out.slice(-8000) };
    } catch (e) {
        return { ok: false, serial: s, error: [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").slice(-4000) };
    }
}

const tap = (x, y, o = {}) => shell(`input tap ${Number(x)} ${Number(y)}`, o);
const swipe = (x1, y1, x2, y2, ms = 300, o = {}) => shell(`input swipe ${+x1} ${+y1} ${+x2} ${+y2} ${+ms}`, o);
const key = (keycode, o = {}) => shell(`input keyevent ${String(keycode).replace(/[^A-Z0-9_]/gi, "")}`, o);

/** Ketik teks (spasi → %s, karakter shell dilepas aman). */
function text(str, o = {}) {
    const safe = String(str).replace(/(["\\$`'()&|;<>* ])/g, m => (m === " " ? "%s" : "\\" + m));
    return shell(`input text "${safe}"`, o);
}

/** Buka aplikasi via nama paket (launcher intent). */
const openApp = (pkg, o = {}) =>
    shell(`monkey -p ${String(pkg).replace(/[^\w.]/g, "")} -c android.intent.category.LAUNCHER 1`, o);

/** Daftar paket aplikasi terpasang (opsional filter). */
async function listApps(filter, o = {}) {
    const r = await shell("pm list packages" + (filter ? ` | grep -i ${String(filter).replace(/[^\w.]/g, "")}` : ""), o);
    if (!r.ok) return r;
    const pkgs = r.output.split(/\r?\n/).map(l => l.replace(/^package:/, "").trim()).filter(Boolean);
    return { ok: true, serial: r.serial, count: pkgs.length, packages: pkgs.slice(0, 200) };
}

/** Ambil tangkapan layar ke berkas PNG lokal (default scratch). */
async function screenshot({ serial, out } = {}) {
    let s;
    try { s = await resolveSerial(serial); }
    catch (e) { return { ok: false, error: e.message }; }
    const file = out || path.join(process.env.TEMP || ".", `android-${Date.now()}.png`);
    try {
        // exec-out screencap: PNG mentah langsung ke stdout (buffer besar).
        const { stdout } = await pexec(ADB, argsFor(s, ["exec-out", "screencap", "-p"]),
            { ...OPTS, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
        require("node:fs").writeFileSync(file, stdout);
        return { ok: true, serial: s, file };
    } catch (e) {
        return { ok: false, serial: s, error: (e.stderr || e.message || "").toString().slice(-2000) };
    }
}

/** Ringkas notifikasi aktif (dumpsys). */
async function notifications(o = {}) {
    const r = await shell("dumpsys notification --noredact | grep -E 'tickerText|android.title|android.text' | head -40", o);
    return r;
}

/** Hubungkan perangkat nirkabel (adb over TCP). */
async function connect(ipPort) {
    try {
        const out = await adb(["connect", String(ipPort).replace(/[^\d.:]/g, "")]);
        return { ok: /connected|already/i.test(out), output: out.trim() };
    } catch (e) {
        return { ok: false, error: (e.stderr || e.message || "").toString().slice(-500) };
    }
}

/** Info perangkat: model, versi Android, resolusi layar. */
async function info(o = {}) {
    const r = await shell("getprop ro.product.model; getprop ro.build.version.release; wm size; wm density", o);
    return r;
}

module.exports = { devices, shell, tap, swipe, key, text, openApp, listApps, screenshot, notifications, connect, info, resolveSerial };
