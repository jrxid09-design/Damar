"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEmbodiedCore } = require("../../src/integration/embodiedCore");
const emb = require("../../src/embodiment");
const desktop = require("../../src/desktop");
const reintel = require("../../src/reintel");
const authority = require("../../src/authority");
const cognition = require("../../src/cognition");
const { createDamarSelfService } = require("../../src/services/damarSelfService");

/**
 * KOMPOSISI WAVE 1 — kepemilikan state kanonik, injeksi eksplisit,
 * dan audit struktural perekat integrasi.
 */

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-w1comp-"));
}

// =====================================================================
// CANONICAL STATE OWNERSHIP — tidak ada salinan shadow
// =====================================================================

test("komposisi memakai instance kanonik yang di-inject, bukan salinan", async () => {

    const registry = new authority.registry.AuthorityRegistry({
        store: authority.store.createMemoryAuthorityStore(),
        clock: { nowMs: () => 0, nowIso: () => "1970-01-01T00:00:00.000Z" }
    });
    const body = emb.createBodySchema({ clock: emb.manualClock(1) });
    const context = new desktop.DesktopContextCore({ clock: () => 1 });
    const re = await reintel.createReIntel();
    const acc = await cognition.createAccCore({ overrides: { mode: "shadow" } });
    const selfDir = makeTmpDir();
    const selfSvc = createDamarSelfService({ canonicalDir: selfDir });

    const core = await createEmbodiedCore({
        authorityRegistry: registry,
        bodySchema: body,
        desktopCore: context,
        reintelInstance: re,
        accCore: acc,
        damarSelfService: selfSvc
    });

    assert.equal(core.authority.registry, registry,
        "Authority tetap SATU pemilik kanonik");
    assert.equal(core.body, body, "Body Schema tetap satu pemilik");
    assert.equal(core.desktop, context, "Desktop context tetap satu pemilik");
    assert.equal(core.reintel, re, "RE findings tetap satu pemilik");
    assert.equal(core.acc, acc, "Kontinuitas kognitif tetap satu pemilik");
    assert.equal(core.damarSelf, selfSvc,
        "Identitas autobiografis tetap satu pemilik");
});

test("facade beku — komposisi tidak bisa ditukar saat runtime", async () => {
    const core = await createEmbodiedCore({ damarSelfDir: makeTmpDir() });
    assert.equal(Object.isFrozen(core), true);
    assert.equal(Object.isFrozen(core.authority), true);
});

// =====================================================================
// PORT OBSERVASI INERT — perekat tidak mengubah authority
// =====================================================================

test("port observasi tidak pernah menyentuh registry otoritas", async () => {

    let grantWrites = 0;
    const store = authority.store.createMemoryAuthorityStore();
    const wrappedStore = new Proxy(store, {
        get(target, prop) {
            if (prop === "upsertCapability") {
                return (...a) => {
                    grantWrites += 1;
                    return target.upsertCapability(...a);
                };
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
        }
    });

    const registry = new authority.registry.AuthorityRegistry({
        store: wrappedStore,
        clock: { nowMs: () => 0, nowIso: () => "1970-01-01T00:00:00.000Z" }
    });

    const core = await createEmbodiedCore({
        authorityRegistry: registry,
        damarSelfDir: makeTmpDir()
    });

    core.body.registerProducer("fake.discovery");
    core.observeEmbodiment(emb.makeEvent({
        type: "DEVICE_ONLINE", source: "fake.discovery",
        provenance: "OBSERVATION", subject: "host.os:x",
        payload: { role: "owner", capabilities: ["*"] },
        clock: core.body.clock
    }));

    assert.equal(grantWrites, 0,
        "port observasi tidak boleh menulis capability apa pun");

    const attempt = await core.authority.registry.authorize({
        capabilityId: "*", action: "execute" });
    assert.equal(attempt.allowed, false);
});

// =====================================================================
// AUDIT STRUKTURAL — perekat tanpa aktuator tersembunyi
// =====================================================================

const FORBIDDEN_IN_GLUE = [
    "child_process", "node-pty", "ws\"", "http\"", "https\"",
    "express", "net\"", "dgram", "cluster",
    "keyboard", "mouse", "robotjs"
];

test("perekat integrasi tidak mengimpor jalur eksekusi/jaringan/UI", () => {

    const glueDir = path.join(__dirname, "..", "..", "src", "integration");
    const files = fs.readdirSync(glueDir).filter(f => f.endsWith(".js"));
    assert.ok(files.length > 0);

    for (const f of files) {
        const text = fs.readFileSync(path.join(glueDir, f), "utf8");
        const requires = [...text.matchAll(
            /require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
        for (const req of requires) {
            for (const bad of FORBIDDEN_IN_GLUE) {
                assert.ok(!req.includes(bad.replace(/"$/, "")),
                    `${f} mengimpor modul terlarang: ${req}`);
            }
        }
        // hanya subtree subsystem yang diizinkan:
        for (const req of requires) {
            if (!req.startsWith(".")) continue;
            assert.match(req, /^(\.\.|\.\/|)/);
            assert.ok(
                !req.includes("../utils/console") &&
                !req.includes("../routes") &&
                !req.includes("../controllers") &&
                !req.includes("apps/console"),
                `${f} tidak boleh menyentuh UI/route: ${req}`);
        }
    }
});

test("ACC di luar shadow ditolak oleh komposisi (Wave 1)", async () => {
    await assert.rejects(
        () => createEmbodiedCore({
            accCore: { mode: "active" },
            damarSelfDir: makeTmpDir()
        }),
        /INTEGRATION LAW/,
        "komposisi menolak ACC non-shadow"
    );
});
