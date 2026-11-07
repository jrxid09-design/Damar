const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const JsonStore = require("../../src/core/config/JsonStore");

const { DeviceRegistry, newToken, newPairingCode } = require("../../src/companion/deviceRegistry");
const { Pairing } = require("../../src/companion/pairing");
const { CompanionGateway } = require("../../src/companion/companionGateway");

/**
 * Companion (device tertaut) — device di jaringan sama bisa pakai tools
 * & skill Damar. Test menguji registry, pairing, auth, dan gateway.
 */

function makeRegistry() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-comp-"));
    const store = new JsonStore(path.join(dir, "companions.json"), { devices: [] });
    return new DeviceRegistry(store);
}

// ---- DeviceRegistry ----

test("registry: create device + token, authenticate, revoke", () => {
    const r = makeRegistry();

    const d = r.create({ name: "HP Ronny", kind: "phone" });
    assert.ok(d.id);
    assert.ok(d.token);
    assert.equal(d.name, "HP Ronny");

    // authenticate dengan token benar
    const auth = r.authenticate(d.token);
    assert.equal(auth.id, d.id);

    // authenticate dengan token salah → null
    assert.equal(r.authenticate("salah"), null);

    // touch update lastSeenAt
    r.touch(d.id);
    assert.ok(r.get(d.id).lastSeenAt);

    // revoke → authenticate null
    r.revoke(d.id);
    assert.equal(r.authenticate(d.token), null);
    assert.equal(r.publicList().find(x => x.id === d.id).revoked, true);
});

test("registry: publicList TIDAK membocorkan token", () => {
    const r = makeRegistry();
    const d = r.create({ name: "x" });
    const pub = r.publicList().find(x => x.id === d.id);
    assert.equal(pub.token, undefined, "token tak boleh muncul di publicList");
});

test("registry: setAllowedTools membatasi izin", () => {
    const r = makeRegistry();
    const d = r.create({ name: "x" });
    r.setAllowedTools(d.id, ["filesystem.readFile", "http.get"]);
    assert.deepEqual(r.get(d.id).allowedTools, ["filesystem.readFile", "http.get"]);
    r.setAllowedTools(d.id, null);
    assert.equal(r.get(d.id).allowedTools, null);
});

test("newToken/newPairingCode: format benar", () => {
    assert.ok(newToken().length > 20);
    assert.match(newPairingCode(), /^[2-9]{6}$/, "kode 6 digit tanpa 0/1");
});

// ---- Pairing ----

test("pairing: request (owner) → join (device) dengan kode benar", () => {
    const p = new Pairing({ ttlMs: 60000 });
    const req = p.request();
    assert.match(req.code, /^[2-9]{6}$/);

    const joined = p.join(req.code, { name: "HP" });
    assert.equal(joined.name, "HP");
    assert.equal(p.count(), 0, "pending harus kosong setelah join");
});

test("pairing: kode salah → null", () => {
    const p = new Pairing({ ttlMs: 60000 });
    p.request();
    assert.equal(p.join("000000"), null);
    assert.equal(p.count(), 1, "pending tetap ada setelah kode salah");
});

test("pairing: kedaluwarsa (TTL) → join null", () => {
    const p = new Pairing({ ttlMs: 10 });
    const req = p.request();
    // ttl 10ms → tunggu melebihi TTL
    return new Promise(resolve => {
        setTimeout(() => {
            assert.equal(p.join(req.code), null);
            assert.equal(p.count(), 0, "pending expired harus dibersihkan");
            resolve();
        }, 50);
    });
});

test("pairing: maxPending menolak saat penuh", () => {
    const p = new Pairing({ ttlMs: 60000, maxPending: 2 });
    p.request();
    p.request();
    assert.throws(() => p.request(), /PAIRING_BUSY|menggantung/);
});

// ---- CompanionGateway ----

test("gateway.chat memakai aiRuntime inject (channel 'device', tools undefined)", async () => {
    let captured = null;
    const fakeRuntime = {
        chat: async (req) => { captured = req; return { content: "oke" }; }
    };

    const registry = makeRegistry();
    const g = new CompanionGateway({ registry, aiRuntime: fakeRuntime });

    const device = registry.create({ name: "HP" });
    const { answer } = await g.chat(device, "nyalakan lampu");

    assert.equal(answer, "oke");
    assert.equal(captured.channel, "device");
    assert.equal(captured.tools, undefined, "tools undefined → ToolSelector otomatis");
});

test("gateway.authenticate memvalidasi token device", () => {
    const registry = makeRegistry();
    const g = new CompanionGateway({ registry });

    const d = registry.create({ name: "HP" });
    assert.equal(g.authenticate(d.token).id, d.id);
    assert.equal(g.authenticate("salah"), null);
});

test("gateway.tools delegasi ke ToolRegistry (tanpa throw)", () => {
    const registry = makeRegistry();
    const g = new CompanionGateway({ registry });
    const tools = g.tools(); // mungkin kosong di tes, tapi tak boleh throw
    assert.ok(Array.isArray(tools));
});

test("gateway.status mengembalikan daftar device", () => {
    const registry = makeRegistry();
    const g = new CompanionGateway({ registry });
    registry.create({ name: "HP" });
    const s = g.status();
    assert.equal(s.deviceCount, 1);
    assert.equal(s.devices.length, 1);
});
