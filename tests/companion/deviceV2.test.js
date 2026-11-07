const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CompanionGateway } = require("../../src/companion/companionGateway");
const { gateway, deviceRegistry } = require("../../src/companion/index");

/**
 * Endpoint device v2: streaming, STT/TTS auth, upload/media.
 * Fokus: auth wajib, upload tersimpan & tersaji, chatStream memakai
 * aiRuntime yang di-inject (jalur sama, tanpa loop kedua).
 */

// ---- chatStream ----

test("gateway.chatStream: delta mengalir via onDelta, giliran dipersist", async () => {

    // Fake runtime: stream() = async generator 3 delta.
    const fakeRuntime = {
        stream: async function* () {
            yield { delta: "Suhu " };
            yield { delta: "27 " };
            yield { delta: "derajat." };
        }
    };

    const registry = deviceRegistry; // singleton (token tak dipakai di sini)
    const g = new CompanionGateway({ registry, aiRuntime: fakeRuntime });

    const device = { id: "dev-stream-test" };
    const deltas = [];

    const { answer } = await g.chatStream(device, "berapa suhu?", (d) => deltas.push(d));

    assert.equal(answer, "Suhu 27 derajat.");
    assert.deepEqual(deltas, ["Suhu ", "27 ", "derajat."]);

    // Riwayat sesi tercatat utuh.
    const { manager } = require("../../src/channels");
    const history = await manager.history("device", device.id, "dm");
    assert.equal(history.length, 2);
    assert.equal(history[1].content, "Suhu 27 derajat.");
});

// ---- upload + media (via controller, isolasi dir) ----

test("upload: tersimpan, tersaji via readUpload, nama berkas dari server", async () => {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-comp-up-"));
    process.env.DAMAR_COMPANION_UPLOAD_DIR = dir;

    try {

        const out = gateway.saveUpload({
            name: "../../evil.png",                 // coba path traversal
            data: Buffer.from("PNGDATA").toString("base64"),
            mimeType: "image/png"
        });

        // Nama berkas HARUS dari server (UUID), bukan dari klien.
        assert.match(out.file, /^[a-f0-9-]{12}\.png$/);
        assert.ok(!out.file.includes("evil"));
        assert.equal(out.url, `/api/v1/companion/media/${out.file}`);

        // Berkas benar-benar ada di disk.
        assert.ok(fs.existsSync(out.path));

        // Terbaca kembali via readUpload.
        const read = gateway.readUpload(out.file);
        assert.equal(read.buffer.toString(), "PNGDATA");

        // Path traversal ditolak → null.
        assert.equal(gateway.readUpload("..%2F..%2Fevil"), null);
        assert.equal(gateway.readUpload("sub/dir.png"), null);

    }
    finally {
        delete process.env.DAMAR_COMPANION_UPLOAD_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
    }

});

// ---- contentTypeOf ----

test("contentTypeOf: ekstensi umum dipetakan benar", () => {
    const { CompanionGateway } = require("../../src/companion/companionGateway");
    assert.equal(CompanionGateway.contentTypeOf("a.PNG"), "image/png");
    assert.equal(CompanionGateway.contentTypeOf("b.jpg"), "image/jpeg");
    assert.equal(CompanionGateway.contentTypeOf("c.pdf"), "application/pdf");
    assert.equal(CompanionGateway.contentTypeOf("d.xyz"), "application/octet-stream");
});
