const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

/**
 * A — HOME_BRIEF / FULL_CONTEXT / DESCRIBE_IMAGE melalui ToolExecutor ASLI.
 *
 * Invariant: giliran LLM yang dihasilkan tool ini mewarisi otoritas
 * pemanggil — user TIDAK pernah menghasilkan giliran ber-authority
 * system. Sumber peran satu-satunya: Authorization.resolveDelegator.
 */

// ---- Stub otak AI: alat ukur peran giliran -----------------------------
const seen = [];
const svcPath = require.resolve("../../src/services/aiRuntimeService.js");
const aiStub = {
    chat: async opts => {
        // H1/CLOSURE: identitas kanonik kini menyeberang sebagai SATU
        // objek `exec`; bentuk legacy role/capabilitySet tetap dibaca.
        seen.push({
            role: opts.exec?.role ?? opts.role ?? null,
            sessionId: opts.exec?.sessionId ?? opts.sessionId ?? null,
            capabilitySet: opts.exec?.capabilitySet ?? opts.capabilitySet ?? null
        });
        return { content: "narasi uji" };
    },
    ensure() { return this; },
    stream: async function* () { yield { delta: "x", done: true }; },
    providers: async () => ({ active: "stub", providers: [] }),
    tools: () => [],
    activePlatform: { id: "stub", label: "stub" }
};
require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: aiStub };

// ---- Kamera fixture + stub deviceService untuk jalur visi --------------
const IMG = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0xFF, 0xD9                                    // JPEG minimal yang sah
]);

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(IMG);
});

const devPath = require.resolve("../../src/services/deviceService.js");
const FIXTURE_CAM = { id: "uji", label: "Kamera Uji", snapshotUrl: "", headers: {} };
let camUrl = "";
require.cache[devPath] = {
    id: devPath, filename: devPath, loaded: true,
    exports: {
        cameras: () => [{ ...FIXTURE_CAM, snapshotUrl: camUrl }],
        getCamera: id => ({ ...FIXTURE_CAM, snapshotUrl: camUrl }),
        readiness: () => ({ configured: true, online: true, on: 0, total: 0 })
    }
};

// ---- Registry dengan tool ASLI -----------------------------------------
const ToolExecutor = require("../../src/ai/tools/ToolExecutor");
const { AIToolRegistry } = require("../../src/ai/tools");

const skills = require("../../src/plugins/damarSkills/tools.js");

// FIXTURE HERMETIK (packaging): model vision tidak boleh bergantung pada
// configs/vision.json ambient milik pemilik. Tes hanya butuh SEBUAH model
// vision terkonfigurasi - bukan model tertentu - agar jalur see_camera/
// describe_image dapat menguji SSRF + pewarisan otoritas deterministik.
process.env.DAMAR_VISION_MODEL =
    process.env.DAMAR_VISION_MODEL ?? "vision-fixture-model";

function buildExecutor() {
    const reg = new AIToolRegistry();
    for (const t of [
        skills.find(t => t.name === "home_brief"),
        skills.find(t => t.name === "full_context"),
        skills.find(t => t.name === "see_camera"),      // registry camera → trusted-lan
        skills.find(t => t.name === "describe_image")   // url user → policy public
    ]) {
        if (t) reg.register(t);
    }
    return new ToolExecutor(reg);
}

test.before(async () => {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    camUrl = `http://127.0.0.1:${server.address().port}/snapshot.jpg`;
});

test.after(() => new Promise(resolve => server.close(resolve)));

test("A home_brief: user → giliran 'user', BUKAN system", async () => {

    seen.length = 0;
    const exec = buildExecutor();

    const r = await exec.execute(
        { id: "hb1", name: "home_brief", arguments: {} },
        { role: "user", channel: "console", sessionId: "u-user" });

    assert.ok(r.result?.brief !== undefined, "hasil brief harus ada");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].role, "user",
        `giliran narasi harus 'user', dapat '${seen[0].role}'`);

});

test("A home_brief: superadmin mewarisi superadmin (bukan diam-diam system)", async () => {

    seen.length = 0;
    const exec = buildExecutor();

    await exec.execute(
        { id: "hb2", name: "home_brief", arguments: {} },
        { role: "superadmin", channel: "console", sessionId: "u-owner" });

    assert.equal(seen[0].role, "superadmin");

});

test("A home_brief: tanpa identitas → fail-closed 'user'", async () => {

    seen.length = 0;
    const exec = buildExecutor();

    await exec.execute({ id: "hb3", name: "home_brief", arguments: {} }, null);

    assert.equal(seen[0].role, "user",
        "identitas hilang harus jatuh ke least privilege");

});

test("A describe_image: URL privat user DITOLAK (SSRF), dan giliran visi registry tetap 'user'", async () => {

    // D-FINAL: describe_image menerima URL dari argumen model/user —
    // target loopback WAJIB ditolak oleh kebijakan SSRF sebelum fetch.
    seen.length = 0;
    const exec = buildExecutor();

    await assert.rejects(
        () => exec.execute(
            { id: "di0", name: "describe_image",
              arguments: { url: camUrl, question: "ada apa?" } },
            { role: "user", channel: "console", sessionId: "u-ssrf" }),
        /privat|loopback/i,
        "URL privat dari argumen user harus ditolak kebijakan SSRF");
    assert.equal(seen.length, 0, "tidak ada giliran model yang lahir");

    // Jalur sah: kamera REGISTRY milik pemilik (fixture deviceService)
    // memakai policy trusted-lan. Pemanggil superadmin → giliran visi
    // wajib 'superadmin' (bukannya system implisit) — inilah invariant
    // pewarisan peran giliran visi.
    const r = await exec.execute(
        { id: "di1", name: "see_camera",
          arguments: { camera: "uji", question: "ada apa?" } },
        { role: "superadmin", channel: "console", sessionId: "u-visi" });

    assert.equal(r.result?.text ?? r.result?.seen, "narasi uji",
        "jalur visi harus sampai ke model");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].role, "superadmin",
        `giliran visi harus mewarisi pemanggil, dapat '${seen[0].role}'`);

});

test("A full_context: tanpa giliran ber-authority system", async () => {

    seen.length = 0;
    const exec = buildExecutor();

    const r = await exec.execute(
        { id: "fc1", name: "full_context", arguments: {} },
        { role: "user", channel: "console", sessionId: "u-fc" });

    assert.ok(r.result, "snapshot harus kembali");
    for (const s of seen) {
        assert.notEqual(s.role, "system", "tidak boleh ada giliran system");
    }

});
