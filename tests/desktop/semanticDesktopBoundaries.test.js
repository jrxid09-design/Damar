const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
    DesktopContextCore,
    createCognitionProjection,
    ContextSnapshot,
    AUTHORITY_NOTE,
    DESKTOP_EVENT,
    ENTITY_TYPE
} = require("../../src/desktop");
const { FakeDesktopAdapter } = require("../../src/desktop/adapters/FakeDesktopAdapter");
const { FORBIDDEN_VERBS } = require("../../src/desktop/CognitionProjection");
const { makeHarness, rawObservation, E } = require("./helpers");

/**
 * SUITE BATAS (BOUNDARIES) — model boundary, nol otoritas,
 * minimisasi konten, kemandirian dari Console.
 *
 * Pemeriksaan mekanis anti-tangkapan-layar ada di
 * semanticDesktopRedteam.test.js (B11).
 */

// ---- 29. tidak ada jalur mutasi oleh model ---------------------------------------------

test("proyeksi kognisi tidak punya metode mutasi apa pun", () => {
    const { core } = makeHarness();
    const projection = createCognitionProjection(core);

    const keys = Object.keys(projection);
    assert.ok(keys.length > 0);
    for (const key of keys) {
        assert.doesNotMatch(key, FORBIDDEN_VERBS, `metode terlarang: ${key}`);
        assert.equal(typeof projection[key], "function", `${key} harus metode query`);
    }

    // Core hanya menerima ingest dari adapter terdaftar + tepercaya.
    const result = core.ingest(rawObservation({
        type: DESKTOP_EVENT.WINDOW_ACTIVATED,
        observationId: "model-fake-1",
        subject: "win-halusinasi",
        entities: [E("win-halusinasi", ENTITY_TYPE.WINDOW, "jendela khayalan")],
        adapterId: "llm-output"
    }));
    assert.equal(result.accepted, false);
    assert.equal(result.reasonCode, "REJECTED_UNTRUSTED_SOURCE");
    assert.equal(core.getActiveWindow(), null);
});

test("interpret() model tidak mengubah keadaan kanonik sedikit pun", () => {
    const { core, adapter } = makeHarness();
    adapter.selectText({ selectionId: "s1", text: "abc", length: 3, windowId: "w" });

    // Identitas snapshot kini diturunkan dari konten → perbandingan
    // penuh byte-per-byte sah tanpa pengecualian apa pun.
    const before = ContextSnapshot.serialize(core.snapshot());
    const versionBefore = core.version;

    const projection = createCognitionProjection(core);
    const ann = projection.interpret("pengguna memilih paragraf pertama");

    assert.equal(ann.interpretation, "pengguna memilih paragraf pertama");
    assert.equal(ann.contextUnchanged, true);
    assert.equal(core.version, versionBefore);
    assert.equal(ContextSnapshot.serialize(core.snapshot()), before);
});

// ---- 30. konteks memberi NOL otoritas ----------------------------------------------------

test("observasi tidak pernah menyertakan otoritas actuation", () => {
    const { core } = makeHarness();
    const projection = createCognitionProjection(core);

    for (const obj of [core, projection]) {
        for (const verb of ["execute", "actuate", "sendInput", "typeInto", "clickAt", "writeTo"]) {
            assert.equal(typeof obj[verb], "undefined", `${verb} tidak boleh ada`);
        }
    }

    const ann = projection.interpret("apa pun");
    assert.equal(ann.grantsAuthority, false);
    assert.match(AUTHORITY_NOTE, /Observation != authority/);
    assert.match(projection.describe().authorityNote, /read-only/i);
});

// ---- 31. minimisasi konten ------------------------------------------------------------------

test("snapshot penuh bebas konten berat: metadata saja", () => {
    const { core, adapter } = makeHarness();
    adapter.activateWindow({ windowId: "w1", appId: "a1", documentId: "d1" });
    adapter.selectText({
        selectionId: "s1",
        text: "kalimat ".repeat(500),   // 4000 char
        length: 4000,
        windowId: "w1"
    });
    adapter.setClipboardItem({ itemId: "clip-1", contentType: "text/plain", length: 99999 });
    adapter.showVisualReference({ imageId: "img-1", sourceRef: "x.png" });

    const json = ContextSnapshot.serialize(core.snapshot());

    assert.ok(!json.includes("base64"));
    assert.ok(json.length < 8000, `snapshot bocor konten (${json.length} char)`);
    // Panjang seleksi dicatat; isinya tidak.
    const snap = JSON.parse(json);
    const sel = snap.entities.find((e) => e.id === "s1");
    assert.equal(sel.attributes.length, 4000);
    assert.ok(sel.attributes.excerpt.length <= 120);
    const clip = snap.entities.find((e) => e.id === "clip-1");
    assert.equal(clip.attributes.length, 99999);
    // Metadata-only: hanya contentType + length, tanpa isi.
    assert.deepEqual(Object.keys(clip.attributes).sort(), ["contentType", "length"]);
});

// ---- 33. referensi visual tanpa byte ----------------------------------------------------------

test("VisualContext valid meski byte gambar tidak pernah ada", () => {
    const { core, adapter } = makeHarness();
    adapter.showVisualReference({
        imageId: "img-ref-only",
        source: "active_window",
        mimeType: "image/png",
        width: null,
        height: null
    });

    const vis = core.getActiveVisualContext();
    assert.ok(vis); // referensi sah tanpa dimensi maupun byte
    assert.equal(vis.attributes.mimeType, "image/png");
    assert.equal(Object.values(vis.attributes).some((v) =>
        typeof v === "string" && v.length > 256), false);
});

// ---- 34. operasi mandiri tanpa Console ------------------------------------------------------------

test("substrate mandiri: tidak ada require ke Console/server/app di src/desktop", () => {
    const desktopDir = path.join(__dirname, "..", "..", "src", "desktop");
    const files = fs.readdirSync(desktopDir, { recursive: true })
        .filter((f) => String(f).endsWith(".js"));

    assert.ok(files.length >= 8, `modul substrate kurang: ${files.length}`);

    for (const file of files) {
        const src = fs.readFileSync(path.join(desktopDir, file), "utf8");
        const requires = [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
        for (const req of requires) {
            const okPath = req.startsWith("node:") ||
                req.startsWith("./") || req.startsWith("../");
            assert.ok(okPath, `${file} me-require dependensi luar: ${req}`);
        }
    }

    // Dan lifecycle lengkap berjalan tanpa server/console sama sekali.
    const { core, adapter } = makeHarness();
    adapter.changeWorkspace({ workspaceId: "ws", label: "mandiri" });
    assert.equal(core.getCurrentWorkspace()?.label, "mandiri");
});
