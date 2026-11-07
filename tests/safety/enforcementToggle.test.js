const test = require("node:test");
const assert = require("node:assert");

const riskPolicy = require("../../src/core/safety/riskPolicy");
const killSwitch = require("../../src/core/safety/killSwitch");
const toolGuard = require("../../src/core/safety/toolGuard");
const loopGuard = require("../../src/core/safety/loopGuard");

/**
 * Guard selalu mengizinkan.
 *
 * Gerbang izin sudah dihapus sepenuhnya atas keputusan pemilik.
 * Yang diuji di sini: guard tidak pernah menahan, sementara rem
 * yang tetap berjalan — kill switch, sandbox jalur, rem kebuntuan —
 * tidak ikut hilang.
 */

test("guard tidak pernah menahan tool destruktif", () => {

    // Tidak ada lagi gerbang yang bisa dinyalakan/dimatikan;
    // semua eksekusi diizinkan tanpa kecuali.
    assert.doesNotThrow(() => riskPolicy.assertAllowed("terminal_run"));
    assert.doesNotThrow(() => riskPolicy.assertAllowed("filesystem.deleteFile"));

});

test("keadaan kebijakan selalu tanpa gerbang", () => {

    const s = riskPolicy.state();

    assert.equal(s.enforcement.enabled, false);
    assert.equal(s.enforcement.until, null);
    assert.equal(s.enforcement.actor, null);

});

// ---- Yang TETAP berjalan --------------------------------------------

test("STOP tetap menghentikan segalanya walau gerbang sudah dihapus", () => {

    // Pasal 2.1: pemilik harus selalu dapat menghentikan Damar.
    loopGuard.resetAll();

    killSwitch.engage({ reason: "uji", actor: "uji" });

    try {
        assert.throws(
            () => toolGuard.before("terminal_run", { command: "echo x" }),
            e => e.code === "SAFETY_STOP_ENGAGED"
        );
    }
    finally {
        killSwitch.release({ actor: "uji" });
    }

});

test("sandbox jalur tetap berlaku walau gerbang sudah dihapus", () => {

    loopGuard.resetAll();

    assert.throws(
        () => toolGuard.before("filesystem.writeFile", {
            path: "C:/Windows/System32/uji.dll",
            content: "x"
        }),
        e => e.code === "SAFETY_PATH_DENIED" || /jalur|path/i.test(e.message)
    );

});

test("rem kebuntuan tetap berlaku walau gerbang sudah dihapus", () => {

    loopGuard.resetAll();

    for (let i = 0; i < 4; i++) {
        toolGuard.before("memory_recall", { query: "identik" });
    }

    assert.throws(
        () => toolGuard.before("memory_recall", { query: "identik" }),
        e => e.code === "LOOP_DETECTED"
    );

});
