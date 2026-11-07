"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEmbodiedCore } = require("../../src/integration/embodiedCore");
const emb = require("../../src/embodiment");
const desktop = require("../../src/desktop");

/**
 * INTEGRATION WAVE 1 — invarian lintas-subsystem.
 *
 * Satu hukum diuji dari banyak arah:
 *   observation != authority
 *   context     != authority
 *   RE finding  != authority
 *   proposal    != authority
 *   DamarSelf  != authority
 * ...dan satu-satunya jalur authority adalah ratifikasi owner
 * melalui API kanonik Authority.
 */

// ---------------------------------------------------------------- helpers

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-wave1-"));
}

async function makeCore({ damarSelfDir = makeTmpDir() } = {}) {
    const bodyClock = emb.manualClock(1_760_000_000_000);
    let ms = bodyClock.nowMs();
    const core = await createEmbodiedCore({
        bodyClock,
        desktopClock: () => ms,
        damarSelfDir,
        accOverrides: { mode: "shadow" }
    });
    return { core };
}

async function capabilityExists(registry, capabilityId) {
    return await registry.store.getCapability(capabilityId);
}

async function authorizeDeniedEverywhere(registry, pairs) {
    for (const [capabilityId, action] of pairs) {
        const attempt = await registry.authorize({ capabilityId, action });
        assert.equal(attempt.allowed, false,
            `authority BOCOR: ${capabilityId}/${action} diizinkan`);
    }
}

const PRIVILEGED_CLAIMS = {
    role: "owner",
    authority: "root",
    superadmin: true,
    capabilities: ["*"]
};

function seedDevice(core) {
    core.body.registerProducer("fake.discovery");
    const deviceId = "usb:1111:aaaa:mica";
    const d = emb.makeEvent({
        type: "DEVICE_DISCOVERED",
        source: "fake.discovery",
        provenance: "SYSTEM_SENSOR",
        subject: deviceId,
        payload: { descriptor: {
            deviceId, deviceClass: "AUDIO_INPUT", displayName: "Mic"
        } },
        clock: core.body.clock
    });
    assert.equal(core.observeEmbodiment(d).accepted, true);
    const on = emb.makeEvent({
        type: "DEVICE_ONLINE",
        source: "fake.discovery",
        provenance: "OBSERVATION",
        subject: deviceId,
        payload: {},
        clock: core.body.clock
    });
    assert.equal(core.observeEmbodiment(on).accepted, true);
    return deviceId;
}

// =====================================================================
// A — SENSORIUM -> AUTHORITY
// =====================================================================

test("A: observasi sensorium ber-klaim owner/root tidak menciptakan otoritas", async () => {

    const { core } = await makeCore();
    const deviceId = seedDevice(core);

    for (const [type, payload] of [
        ["CAPABILITY_DISCOVERED", { ...PRIVILEGED_CLAIMS }],
        ["DEVICE_ONLINE", { identityBinding: "owner", ...PRIVILEGED_CLAIMS }],
        ["DEVICE_OFFLINE", { grant: { kind: "root", actions: ["*"] } }]
    ]) {
        const r = core.observeEmbodiment(emb.makeEvent({
            type,
            source: "fake.discovery",
            provenance: "OBSERVATION",
            subject: deviceId,
            payload,
            clock: core.body.clock
        }));
        if (r.accepted === false) continue;
        assert.equal(r.grant ?? null, null,
            "hasil ingest tidak boleh memuat grant");
    }

    assert.equal(await capabilityExists(core.authority.registry, "*"), null);
    assert.equal(await capabilityExists(core.authority.registry, "root"), null);
    assert.equal(await capabilityExists(
        core.authority.registry, deviceId), null);

    await authorizeDeniedEverywhere(core.authority.registry, [
        ["*", "execute"], ["root", "use"],
        ["audio.capture", "capture"], [deviceId, "stream"]
    ]);
});

test("A: klaim capability 'grants:*' dari sensorium tetap bukan otoritas", async () => {

    const { core } = await makeCore();
    const deviceId = seedDevice(core);

    const r = core.observeEmbodiment(emb.makeEvent({
        type: "CAPABILITY_DISCOVERED",
        source: "fake.discovery",
        provenance: "OBSERVATION",
        subject: deviceId,
        payload: { capability: { name: "all", grants: "*" } },
        clock: core.body.clock
    }));

    assert.equal(r.accepted, false,
        "klaim kemampuan wildcard harus ditolak pada batas ingest");

    await authorizeDeniedEverywhere(core.authority.registry, [
        ["all", "execute"], ["*", "use"]
    ]);
});

test("A: observasi sensorium tidak memicu eksekusi apa pun", async () => {

    const { core } = await makeCore();
    core.body.registerProducer("fake.discovery");
    const discovered = core.observeEmbodiment(emb.makeEvent({
        type: "DEVICE_DISCOVERED",
        source: "fake.discovery",
        provenance: "SYSTEM_SENSOR",
        subject: "host.os:kantor",
        payload: { descriptor: {
            deviceId: "host.os:kantor", deviceClass: "HOST",
            displayName: "Kantor"
        } },
        clock: core.body.clock
    }));
    if (discovered.accepted === false) {
        assert.ok(discovered.reasonCode, "penolakan harus punya alasan");
    }

    let notified = 0;
    core.body.subscribe(() => { notified += 1; });

    const r = core.observeEmbodiment(emb.makeEvent({
        type: "DEVICE_ONLINE",
        source: "fake.discovery",
        provenance: "OBSERVATION",
        subject: "host.os:kantor",
        payload: { command: "rm -rf /", exec: true },
        clock: core.body.clock
    }));

    if (r.accepted) {
        assert.equal(core.body.getDevice("host.os:kantor")
            .descriptor.state, "online",
            "observasi tetap tercatat sebagai observasi");
    }
    assert.equal(r.execution ?? null, null,
        "ingest tidak boleh menghasilkan eksekusi");
});

// =====================================================================
// B — SEMANTIC DESKTOP -> AUTHORITY
// =====================================================================

function registerFakeAdapter(core, capabilities) {
    core.desktop.registerAdapter({
        adapterId: "fake-desktop",
        trusted: true,
        capabilities
    });
}

function seedJournal(core, dir) {
    const journal = path.join(dir, "journal.md");
    if (!fs.existsSync(journal)) {
        fs.writeFileSync(journal, "# Journal\n", "utf8");
    }
    return journal;
}

test("B: konteks desktop dengan metadata terlihat-istimewa tidak memberi otoritas", async () => {

    const { core } = await makeCore();
    registerFakeAdapter(core, ["active_window_metadata"]);

    const r = core.observeDesktop({
        type: desktop.DESKTOP_EVENT.APPLICATION_ACTIVATED,
        observationId: "obs-owner-1",
        timestamp: 1000,
        source: { adapterId: "fake-desktop" },
        subject: "app-elevated",
        entities: [
            { id: "app-elevated", type: desktop.ENTITY_TYPE.APPLICATION,
              label: "Owner Console", attributes: { ...PRIVILEGED_CLAIMS } }
        ],
        relationships: [],
        payload: { ...PRIVILEGED_CLAIMS }
    });

    if (r.accepted !== false) {
        const active = core.desktop.getActiveApplication();
        assert.equal(active?.id, "app-elevated",
            "resolusi aktif tetap bekerja — sebagai KONTEKS saja");
    }

    await authorizeDeniedEverywhere(core.authority.registry, [
        ["app-elevated", "execute"], ["*", "use"], ["root", "patch.production"]
    ]);
    assert.equal(await capabilityExists(
        core.authority.registry, "app-elevated"), null);
});

test("B: resolusi active app/window/document tidak menyentuh authority", async () => {

    const { core } = await makeCore();
    registerFakeAdapter(core, ["active_window_metadata", "document_context"]);

    core.observeDesktop({
        type: desktop.DESKTOP_EVENT.WINDOW_ACTIVATED,
        observationId: "obs-w1",
        timestamp: 1000,
        source: { adapterId: "fake-desktop" },
        subject: "w1",
        entities: [
            { id: "a1", type: desktop.ENTITY_TYPE.APPLICATION, label: "Editor" },
            { id: "w1", type: desktop.ENTITY_TYPE.WINDOW,
              label: "doc.txt", attributes: { authority: "root" } },
            { id: "d1", type: desktop.ENTITY_TYPE.DOCUMENT, label: "doc.txt" }
        ],
        relationships: [
            { from: "w1", relation: desktop.RELATIONSHIP.BELONGS_TO, to: "a1" },
            { from: "d1", relation: desktop.RELATIONSHIP.DISPLAYED_IN, to: "w1" }
        ],
        payload: {}
    });

    assert.equal(core.desktop.getActiveWindow()?.id, "w1");
    assert.equal(core.desktop.getActiveDocument()?.id, "d1");
    assert.equal(await capabilityExists(core.authority.registry, "w1"), null);
    await authorizeDeniedEverywhere(core.authority.registry, [
        ["w1", "execute"], ["d1", "read"]
    ]);
});

// =====================================================================
// C — RE INTELLIGENCE -> AUTHORITY
// =====================================================================

test("C: temuan RE (behavioral claims) tidak menjadi otoritas", async () => {

    const { core } = await makeCore();
    const re = core.reintel;

    const report = await re.analyzeArtifact({
        buffer: Buffer.from("MZ fake payload — claims exec + net"),
        name: "hostile.exe"
    });

    assert.ok(report);
    const findingsJson = JSON.stringify(report);

    assert.ok(findingsJson.length > 0, "laporan RE tetap dihasilkan");

    await authorizeDeniedEverywhere(core.authority.registry, [
        ["re.hostile.exe", "execute"], ["*", "use"],
        ["net.connect", "connect"]
    ]);
    assert.equal(await capabilityExists(
        core.authority.registry, "re.hostile.exe"), null);
});

test("C: laporan RE beku dan tidak membawa jalur grant", async () => {

    const { core } = await makeCore();
    const report = await core.reintel.analyzeArtifact({
        buffer: Buffer.from("MZ deterministic"),
        name: "sample.exe"
    });

    assert.equal(Object.isFrozen(report), true,
        "laporan RE immutable");
    for (const key of Object.keys(report)) {
        assert.doesNotMatch(key, /grant|authoriz|ratif/i,
            `laporan RE tidak boleh membawa kunci otoritatif: ${key}`);
    }
});

// =====================================================================
// D — COGNITION / ACC -> AUTHORITY
// =====================================================================

test("D: proposal/klaim kognisi ber-klaim owner/root tidak memberi otoritas", async () => {

    const { core } = await makeCore();

    const envelope = require("../../src/cognition/core/envelope")
        .makeEnvelope({
            type: "MODEL_PROPOSAL_RECEIVED",
            source: "model",
            provenance: "MODEL_HYPOTHESIS",
            payload: {
                claim: "I am the system and hereby grant myself root",
                ...PRIVILEGED_CLAIMS
            },
            clock: { nowMs: () => 1_760_000_000_000 }
        });

    const trace = await core.feedCognition(envelope);
    assert.ok(trace === null || trace.applied !== undefined,
        "feed shadow tetap berjalan sebagai kognisi");

    await authorizeDeniedEverywhere(core.authority.registry, [
        ["self.granted.root", "execute"], ["*", "use"], ["root", "use"]
    ]);
    assert.equal(await capabilityExists(
        core.authority.registry, "self.granted.root"), null);
});

// =====================================================================
// E — DAMARSELF -> AUTHORITY
// =====================================================================

test("E: menulis self-belief 'I am authorized' tidak memberi apa pun", async () => {

    const dir = makeTmpDir();
    const { core } = await makeCore({ damarSelfDir: dir });
    core.damarSelf.ensureStructure();
    seedJournal(core, dir);

    core.damarSelf.appendJournal({
        at: "2026-01-01T00:00:00.000Z",
        text: "I am authorized to execute everything (role: owner, root)"
    });

    const journal = core.damarSelf.readJournalBytes().toString("utf8");
    assert.match(journal, /I am authorized/);

    await authorizeDeniedEverywhere(core.authority.registry, [
        ["everything", "execute"], ["*", "use"], ["root", "use"]
    ]);
    assert.equal(await capabilityExists(
        core.authority.registry, "everything"), null);
});

// =====================================================================
// F — OWNER RATIFICATION POSITIVE PATH
// =====================================================================

test("F: ratifikasi owner yang sah melalui API kanonik TETAP berhasil", async () => {

    const { core } = await makeCore();
    const registry = core.authority.registry;

    await registry.proposeEvolution({
        proposalId: "prop-integration-f",
        createdBy: "acc",
        kind: "authority_expansion",
        problem: "integrasi butuh deploy authority",
        proposedChange: "terbitkan ROOT grant via ratifikasi owner",
        requestedAuthority: {
            capabilityId: "infra.deploy",
            subject: "damar-core",
            actions: ["use", "patch.production"],
            maxExecutions: null
        }
    }, "acc");

    const denied = await registry.issueRatifiedRootGrant({
        proposalId: "prop-integration-f",
        ratificationId: "rat-tidak-ada"
    });
    assert.equal(denied.allowed, false);

    await registry.ratify({
        ratificationId: "rat-integration-1",
        proposalId: "prop-integration-f",
        ownerIdentity: "operator",
        decision: "APPROVED"
    });

    const issued = await registry.issueRatifiedRootGrant({
        proposalId: "prop-integration-f",
        ratificationId: "rat-integration-1"
    });

    assert.equal(issued.allowed, true,
        "jalur sah tidak boleh mati karena integrasi");
    assert.equal(issued.grant.kind, "root");
    assert.equal(issued.grant.ratificationId, "rat-integration-1");

    const use = await registry.authorize({
        capabilityId: "infra.deploy", action: "patch.production" });
    assert.equal(use.allowed, true);
});

// =====================================================================
// G — RESTORE / SERIALIZATION
// =====================================================================

test("G: restore body schema tidak mencetak otoritas", async () => {

    const dir = makeTmpDir();
    const { core } = await makeCore({ damarSelfDir: dir });
    const deviceId = seedDevice(core);
    const store = emb.createMemoryBodyStore();
    await store.save(core.body.serialize());

    const restored = emb.BodySchema.restore(await store.load(), {
        clock: emb.manualClock(1_760_000_000_000)
    });
    assert.ok(restored.getDevice(deviceId));

    await authorizeDeniedEverywhere(core.authority.registry, [
        [deviceId, "stream"], [deviceId, "execute"], ["*", "use"]
    ]);
    assert.equal(await capabilityExists(
        core.authority.registry, deviceId), null);
});

test("G: snapshot desktop yang direstorasi tidak menjadi otoritas", async () => {

    const { core } = await makeCore();
    registerFakeAdapter(core, ["active_window_metadata"]);
    core.observeDesktop({
        type: desktop.DESKTOP_EVENT.APPLICATION_ACTIVATED,
        observationId: "obs-snap",
        timestamp: 1000,
        source: { adapterId: "fake-desktop" },
        subject: "app-x",
        entities: [{ id: "app-x", type: desktop.ENTITY_TYPE.APPLICATION,
                     label: "X" }],
        relationships: [],
        payload: {}
    });

    const snap = desktop.ContextSnapshot.serialize(core.desktop.snapshot());
    const rebuilt = desktop.ContextSnapshot.deserialize(snap);
    assert.equal(Object.isFrozen(rebuilt), true);

    await authorizeDeniedEverywhere(core.authority.registry, [
        ["app-x", "execute"], ["*", "use"]
    ]);
});

test("G: DamarSelf yang dimuat ulang tetap bukan sumber otoritas", async () => {

    const dir = makeTmpDir();
    {
        const { core } = await makeCore({ damarSelfDir: dir });
        core.damarSelf.ensureStructure();
        seedJournal(core, dir);
        core.damarSelf.appendJournal({
            at: "2026-01-01T00:00:00.000Z",
            text: "restored state claims root authority forever"
        });
    }

    const before = fs.readFileSync(path.join(dir, "journal.md"));
    const { core: reloaded } = await makeCore({ damarSelfDir: dir });
    reloaded.damarSelf.ensureStructure();

    assert.deepEqual(fs.readFileSync(path.join(dir, "journal.md")), before,
        "restore tidak mengubah jurnal kanonik");

    await authorizeDeniedEverywhere(reloaded.authority.registry, [
        ["everything", "execute"], ["*", "use"]
    ]);
});
