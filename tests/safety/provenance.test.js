const test = require("node:test");
const assert = require("node:assert");

const MemoryService = require("../../src/memory/services/MemoryService");
const { asalUsul } = MemoryService;

/**
 * Membedakan fakta dari inferensi (§13, §276).
 *
 * `source`, `confidence`, dan `lastVerified` sudah lama tersimpan di
 * basis data, tetapi tak satu pun sampai ke model. Akibatnya sesuatu
 * yang DISIMPULKAN Damar terbaca sama meyakinkannya dengan sesuatu
 * yang DIKATAKAN pengguna.
 */

test("yang berasal dari pengguna tidak diberi penanda", () => {

    // Keadaan normal, dan setiap token tambahan dibayar dengan waktu.
    for (const sumber of ["user", "owner", "pengguna", "", null, undefined]) {
        assert.equal(
            asalUsul({ source: sumber, confidence: 1 }),
            "",
            `sumber "${sumber}" seharusnya tanpa penanda`
        );
    }

});

test("catatan buatan Damar sendiri ditandai", () => {

    const p = asalUsul({ source: "coding-brain", confidence: 1 });

    assert.match(p, /catatan Damar/);

});

test("keyakinan di bawah penuh ditandai sebagai perkiraan", () => {

    const p = asalUsul({ source: "user", confidence: 0.6 });

    assert.match(p, /perkiraan 0\.6/);

});

test("keyakinan penuh tidak ditandai perkiraan", () => {

    assert.equal(asalUsul({ source: "user", confidence: 1 }), "");
    assert.equal(asalUsul({ source: "user", confidence: 0.95 }), "");

});

test("sumber dan keyakinan dapat muncul bersamaan", () => {

    const p = asalUsul({ source: "build-journal", confidence: 0.5 });

    assert.match(p, /build-journal/);
    assert.match(p, /perkiraan 0\.5/);

});

test("penanda tidak pernah melempar pada data cacat", () => {

    for (const item of [{}, { source: 123 }, { confidence: "bukan angka" }, { confidence: NaN }]) {
        assert.doesNotThrow(() => asalUsul(item));
        assert.equal(typeof asalUsul(item), "string");
    }

});

test("asal-usul benar-benar sampai ke konteks yang disuntikkan", async () => {

    // Yang penting bukan fungsinya ada, melainkan penandanya ikut
    // sampai ke prompt yang dibaca model.
    const engine = require("../../src/memory/core/MemoryEngine");
    const tanda = `PROV${Date.now()}`;

    await engine.remember(
        `Kesimpulan Damar tentang ${tanda} yang belum dipastikan.`,
        { type: "skills", metadata: { kind: "observation" } },
        engine.context({ writer: "coding-brain" })
    );

    const ctx = await MemoryService.buildContext(tanda, { limit: 8, maxChars: 1800 });

    assert.ok(String(ctx.text ?? "").includes(tanda), "catatan uji harus ikut terpanggil");
    assert.match(
        String(ctx.text),
        /catatan Damar/,
        "penanda asal-usul harus sampai ke konteks, bukan berhenti di basis data"
    );

});
