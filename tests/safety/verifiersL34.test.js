const test = require("node:test");
const assert = require("node:assert");

const engine = require("../../src/core/verify/VerificationEngine");

/**
 * Tes verifier tool destruktif (§46, §196).
 *
 * Home Assistant tidak ada di jaringan ini (lihat audit §6), jadi
 * jalur perangkat diuji pada perilaku yang PALING penting: saat
 * backend tak terjangkau, hasilnya harus "belum terverifikasi",
 * BUKAN "gagal". Menuduh perintah yang mungkin berhasil sama
 * merusaknya dengan mengklaim sukses palsu.
 */

test("perangkat tak terjangkau → belum terverifikasi, bukan gagal", async () => {

    const r = await engine.verify(
        "damarSkills.device_on",
        { entity_id: "light.tidak_ada" },
        { success: true }
    );

    assert.notEqual(r.state, "failed", "tak terjangkau tidak boleh dituduh gagal");
    assert.notEqual(r.state, "verified", "tak terjangkau juga tidak boleh diklaim berhasil");
    assert.equal(r.state, "unverified");

});

test("entitas tidak disebut → ditandai gagal dibaca", async () => {

    const r = await engine.verify("damarSkills.device_on", {}, { success: true });

    assert.equal(r.state, "failed");
    assert.ok(r.checks.some(c => c.name === "entitas terbaca" && !c.passed));

});

test("pesan tanpa id tidak diklaim terkirim", async () => {

    const r = await engine.verify(
        "damarSkills.wa_send",
        { to: "628xxx", text: "halo" },
        { success: true }                    // ← tool mengaku berhasil
    );

    assert.notEqual(r.state, "verified", "tanpa id pesan, keberhasilan tak dapat dibuktikan");

});

test("pesan dengan id terverifikasi", async () => {

    const r = await engine.verify(
        "damarSkills.wa_send",
        { to: "628xxx" },
        { messageIds: ["3EB0A1B2C3"], errors: [] }
    );

    assert.equal(r.state, "verified");
    assert.ok(r.checks.some(c => c.name === "WhatsApp mengembalikan id pesan" && c.passed));

});

test("pesan dengan error terdeteksi gagal", async () => {

    const r = await engine.verify(
        "damarSkills.wa_send",
        { to: "628xxx" },
        { messageIds: [], errors: ["connection closed"] }
    );

    assert.equal(r.state, "failed");

});

test("tool destruktif kini punya verifier — tidak lagi diam-diam unverified", () => {

    const { verifierFor } = require("../../src/core/verify/verifiers");

    for (const t of [
        "damarSkills.device_on",
        "damarSkills.device_off",
        "damarSkills.device_toggle",
        "damarSkills.set_temperature",
        "damarSkills.home_control",
        "damarSkills.wa_send"
    ]) {
        assert.ok(verifierFor(t), `verifier untuk ${t} harus ada`);
    }

});
