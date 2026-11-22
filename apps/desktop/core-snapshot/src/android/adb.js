/**
 * adb — adapter Android untuk Damar.
 *
 * INGRESS, NEVER AUTHORITY. Modul ini tidak memulai proses: ia tidak
 * me-require `child_process` dan tidak memanggil execFile/spawn. Setiap
 * operasi diteruskan sebagai capability `android.adb` ke runtime milik
 * Manager (`src/manager/internal/adbCapabilities.js`), yang menolaknya
 * sampai owner meratifikasi grant. Registrasi capability bukan otoritas.
 *
 * Hasil canonical dikembalikan apa adanya: hanya `EXECUTED_VERIFIED` yang
 * membawa data driver di `result`. Penelepon lama membaca `result.result`.
 */

function runtime() {
    return require("../manager/bootstrap").getAdbCapabilityRuntime();
}

const devices = (o = {}) => runtime().execute({ operation: "devices", parameters: {}, ...bind(o) });
const connect = (address, o = {}) => runtime().execute({ operation: "connect", parameters: { address }, ...bind(o) });
const shell = (command, o = {}) => runtime().execute({ operation: "shell", parameters: { command, serial: o.serial ?? null, timeout: o.timeout ?? null }, ...bind(o) });
const tap = (x, y, o = {}) => runtime().execute({ operation: "tap", parameters: { x, y, serial: o.serial ?? null }, ...bind(o) });
const swipe = (x1, y1, x2, y2, ms = 300, o = {}) => runtime().execute({ operation: "swipe", parameters: { x1, y1, x2, y2, ms, serial: o.serial ?? null }, ...bind(o) });
const key = (keycode, o = {}) => runtime().execute({ operation: "key", parameters: { keycode, serial: o.serial ?? null }, ...bind(o) });
const text = (str, o = {}) => runtime().execute({ operation: "text", parameters: { text: str, serial: o.serial ?? null }, ...bind(o) });
const openApp = (pkg, o = {}) => runtime().execute({ operation: "openApp", parameters: { package: pkg, serial: o.serial ?? null }, ...bind(o) });
const listApps = (filter, o = {}) => runtime().execute({ operation: "listApps", parameters: { filter: filter ?? null, serial: o.serial ?? null }, ...bind(o) });
const screenshot = (o = {}) => runtime().execute({ operation: "screenshot", parameters: { serial: o.serial ?? null, out: o.out ?? null }, ...bind(o) });
const notifications = (o = {}) => runtime().execute({ operation: "notifications", parameters: { serial: o.serial ?? null }, ...bind(o) });
const info = (o = {}) => runtime().execute({ operation: "info", parameters: { serial: o.serial ?? null }, ...bind(o) });

function bind(o) {
    return {
        requestId: o.requestId,
        identity: o.identity,
        scope: o.scope,
        signal: o.signal
    };
}

module.exports = { devices, shell, tap, swipe, key, text, openApp, listApps, screenshot, notifications, connect, info };
