const nas = require("./nasService");
const notify = require("./notifyService");
const telemetry = require("./telemetryService");

/**
 * nasMonitorService — pemantau kuota & kesehatan disk.
 *
 * Cek berkala: volume yang melewati ambang kuota, dan disk SMART yang
 * tidak "PASSED". Peringatan dikirim lewat notifyService (WhatsApp),
 * di-debounce 24 jam per masalah agar tak spam.
 */

const DEBOUNCE_MS = 24 * 3600 * 1000;
const seen = new Map();   // key → timestamp terakhir dikirim

const gb = n => `${Math.round((Number(n) || 0) / 1e9)} GB`;

async function check() {
    let s;
    try { s = await nas.status(); }
    catch { return { checked: false }; }

    const q = nas.quotaPercent();
    const issues = [];

    for (const v of s.volumes || []) {
        if (v.usedPercent >= q) {
            issues.push([`quota:${v.mount}`,
                `⚠️ Disk ${v.mount} hampir penuh: ${v.usedPercent}% (ambang ${q}%). Sisa ${gb(v.free)}.`]);
        }
    }
    if (s.smart?.available) {
        for (const d of s.smart.devices || []) {
            if (d.health && d.health !== "PASSED") {
                issues.push([`smart:${d.device}`,
                    `⛔ Kesehatan disk ${d.model || d.device}: ${d.health}. Segera backup & periksa.`]);
            }
        }
    }

    const now = Date.now();
    let sent = 0;
    for (const [key, msg] of issues) {
        if (now - (seen.get(key) || 0) >= DEBOUNCE_MS) {
            seen.set(key, now);
            await notify.send(msg);
            telemetry.warn(`[nas-monitor] ${msg}`);
            sent++;
        }
    }
    return { checked: true, issues: issues.length, alerted: sent };
}

let timer = null;
function start() {
    if (timer) return;
    timer = setInterval(() => check().catch(() => {}), 30 * 60 * 1000);
    timer.unref?.();
}
start();

module.exports = { check, start };
