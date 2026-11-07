const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { evaluate } = require("../../src/autonomy/pulse");
const { decide } = require("../../src/autonomy/watchdog");
const { hourTrigger } = require("../../src/autonomy/dream");
const configStore = require("../../src/mcp/configStore");

/**
 * Modul otonomi — Pulse, Watchdog, Dream, dan MCP configStore.
 * Fungsi keputusan diuji sebagai fungsi murni.
 */

// ---- Pulse ----

test("pulse.evaluate: normal saat sehat", () => {
    const v = evaluate({ errorsSinceLast: 1, uptimeSec: 99999, memoryUsedPercent: 40 });
    assert.equal(v.anomaly, false);
});

test("pulse.evaluate: anomali saat lonjakan error", () => {
    const v = evaluate({ errorsSinceLast: 7, uptimeSec: 99999, memoryUsedPercent: 40 });
    assert.equal(v.anomaly, true);
    assert.ok(v.reasons.some(r => /error/.test(r)));
});

test("pulse.evaluate: anomali saat memori >92%", () => {
    const v = evaluate({ errorsSinceLast: 0, uptimeSec: 99999, memoryUsedPercent: 95 });
    assert.equal(v.anomaly, true);
});

test("pulse.evaluate: daemon baru bangun diabaikan pada firstPulse", () => {
    const v = evaluate({ errorsSinceLast: 0, uptimeSec: 30, memoryUsedPercent: 30, firstPulse: true });
    assert.equal(v.anomaly, false);
});

// ---- Watchdog ----

test("watchdog.decide: restart voice setelah streak gagal >=3", () => {
    const a = decide({ voiceFailStreak: 1 }, { voiceFailStreak: 3, mcpOffline: 0, loopLagMs: 50 });
    assert.ok(a.includes("restart_voice"));
});

test("watchdog.decide: restart mcp bila offline bertambah", () => {
    const a = decide({ mcpOffline: 0 }, { voiceFailStreak: 0, mcpOffline: 2, loopLagMs: 10 });
    assert.ok(a.includes("restart_mcp"));
});

test("watchdog.decide: lag ekstrem → peringatan", () => {
    const a = decide({}, { voiceFailStreak: 0, mcpOffline: 0, loopLagMs: 2500 });
    assert.ok(a.includes("warn_lag"));
});

test("watchdog.decide: sehat → tanpa aksi", () => {
    const a = decide({ voiceFailStreak: 0, mcpOffline: 0 }, { voiceFailStreak: 0, mcpOffline: 0, loopLagMs: 20 });
    assert.equal(a.length, 0);
});

// ---- Dream ----

test("dream.hourTrigger: hanya jam 02 dan sekali per hari", () => {

    // HERMETIS: `now` disuntikkan lewat parameter yang MEMANG sudah ada
    // di produksi (dream.js: hourTrigger(hour, doneKey, now = new Date())).
    // Sebelumnya tes memakai jam dinding nyata sambil mematok tanggal
    // 2026-08-21/22, sehingga ia hanya lulus pada satu hari kalender.
    const now = new Date("2026-08-22T02:00:00.000Z");

    // Belum bermimpi hari ini (doneKey = kemarin) -> boleh.
    assert.equal(hourTrigger(2, "2026-08-21", now), true);
    // Sudah bermimpi hari ini (doneKey = hari yang sama) -> tidak boleh.
    assert.equal(hourTrigger(2, "2026-08-22", now), false);
    // Di luar jam 02 -> tidak pernah, apa pun doneKey-nya.
    assert.equal(hourTrigger(3, null, now), false);
    assert.equal(hourTrigger(0, null, now), false);
});

// ---- MCP configStore ----

function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "damar-mcp-")), "mcp.json");
}

test("mcpStore: upsert + remove + normalize args string", () => {

    const f = tmpFile();

    configStore.upsert({
        id: "fs",
        command: "npx",
        args: "-y @modelcontextprotocol/server-filesystem C:/tmp"
    }, f);

    const all = configStore.read(f);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].args,
        ["-y", "@modelcontextprotocol/server-filesystem", "C:/tmp"]);

    // update entri yang sama (bukan duplikat)
    configStore.upsert({ id: "fs", command: "node" }, f);
    assert.equal(configStore.read(f).length, 1);
    assert.equal(configStore.read(f)[0].command, "node");

    // remove
    assert.equal(configStore.remove("fs", f), true);
    assert.equal(configStore.remove("tidak-ada", f), false);
    assert.equal(configStore.read(f).length, 0);
});

test("mcpStore.normalize: id ilegal ditolak", () => {
    assert.throws(() => configStore.normalize({ id: "x", command: "y" }), /id wajib/);
    assert.throws(() => configStore.normalize({ id: "ok", command: "" }), /command/);
});
