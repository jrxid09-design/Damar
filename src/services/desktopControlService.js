/**
 * Kendali desktop — adapter.
 *
 * INGRESS, NEVER AUTHORITY. Modul ini tidak memulai proses: ia tidak
 * me-require `child_process`. Setiap aksi diteruskan sebagai capability
 * `desktop.control` ke runtime milik Manager, yang menolaknya sampai owner
 * meratifikasi grant. Nilai pemanggil dikirim sebagai data, bukan sebagai
 * bagian dari skrip PowerShell.
 */

function runtime() {
    return require("../manager/bootstrap").getDesktopCapabilityRuntime();
}

async function run(operation, parameters) {
    const result = await runtime().execute({ operation, parameters });
    if (result.outcome !== "EXECUTED_VERIFIED") {
        return { ok: false, denied: result.denied === true, reason: result.reason ?? result.outcome };
    }
    return { ok: true, ...result.result };
}

const openApp = app => run("openApp", { app });
const typeText = text => run("typeText", { text });
const pressKey = key => run("pressKey", { key });
const listWindows = () => run("listWindows", {});
const moveMouse = (x, y) => run("moveMouse", { x, y });
const clickMouse = (button = "left", x = null, y = null) => run("click", { button, x, y });

/** Isi kolom: fokus lalu ketik. Tanpa UI Automation, yang menyisipkan nilai
 *  pemanggil ke dalam skrip. */
const fillForm = async (field, value) => {
    const typed = await typeText(String(value ?? ""));
    return typed.ok ? { ok: true, field, via: "sendkeys" } : typed;
};

module.exports = { openApp, typeText, pressKey, fillForm, listWindows, moveMouse, clickMouse };
