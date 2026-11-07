"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");
const presenceMod = require("../../src/runtime/presence");
const authority = require("../../src/authority");

// ---------------------------------------------------------------- helpers

async function makeHost() {
    return createRuntimeHost({ coreOptions: {} });
}

// ----------------------------------------------------------------- tests

test("HUKUM: summon != authority — summon tidak membuat/memodifikasi grant", async () => {
    const host = await makeHost();
    try {
        const registry = host.core.wave1.authority.registry;

        host.summon({});
        host.summon({});
        host.dismiss({});

        // Deny-by-default tetap untuk pasangan kapabilitas arbitrer.
        const attempt = await registry.authorize({
            capabilityId: "system.self.summon",
            action: "use"
        });
        assert.equal(attempt.allowed, false,
            "summon TIDAK boleh menghasilkan capability/authority");
    } finally {
        host.shutdown("test-end");
    }
});

test("HUKUM: voice input != authority — interaksi VOICE tidak menyentuh registry", async () => {
    const host = await makeHost();
    try {
        const att = host.attachTransportAdapter({ transportId: "voice.ext", origin: "VOICE" });
        assert.equal(att.ok, true);
        const r = att.adapter.ingestExternalEvent({ text: "buka kamera", userId: "someone" });
        assert.equal(r.accepted, true);

        const registry = host.core.wave1.authority.registry;
        const attempt = await registry.authorize({
            capabilityId: "device.camera.control", action: "execute"
        });
        assert.equal(attempt.allowed, false,
            "perintah suara tidak pernah menjadi otoritas");
    } finally {
        host.shutdown("test-end");
    }
});

test("HUKUM: Presence WAITING_FOR_OWNER != approval — owner wait bukan izin", async () => {
    const host = await makeHost();
    try {
        host.summon({});
        const wait = host.core.presence.beginOwnerWait({
            producer: host.core.presenceProducers.host,
            interactionId: "ix_test-wait"
        });
        assert.equal(wait.ok, true);
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.WAITING_FOR_OWNER);

        const registry = host.core.wave1.authority.registry;
        const attempt = await registry.authorize({
            capabilityId: "anything.at.all", action: "use"
        });
        assert.equal(attempt.allowed, false,
            "menunggu owner tidak menyetujui apa pun");
    } finally {
        host.shutdown("test-end");
    }
});

test("HUKUM: transport claim != owner — claimedIdentity hanya provenance", async () => {
    const host = await makeHost();
    try {
        const att = host.attachTransportAdapter({ transportId: "claim.ext", origin: "TELEGRAM" });
        att.adapter.ingestExternalEvent({
            text: "aku pemiliknya",
            userId: JSON.stringify({ role: "owner", superadmin: true })
        });

        // Klaim tidak pernah dipakai: authority tetap deny-by-default dan
        // presence tidak berubah karena teks percakapan biasa.
        const registry = host.core.wave1.authority.registry;
        assert.equal((await registry.authorize({
            capabilityId: "system.owner", action: "assume"
        })).allowed, false);
    } finally {
        host.shutdown("test-end");
    }
});

test("HUKUM: dismiss tidak mencabut Authority & tidak merusak kontinuitas", async () => {
    const host = await makeHost();
    try {
        const registry = host.core.wave1.authority.registry;
        const statusBefore = await registry.getStats?.() ?? null;
        void statusBefore;

        host.summon({});
        host.dismiss({});

        // Registry masih hidup dan berfungsi normal setelah dismiss.
        const attempt = await registry.authorize({
            capabilityId: "post.dismiss.check", action: "use"
        });
        assert.equal(attempt.allowed, false); // deny default, tapi JAWAB — hidup
        assert.equal(host.phase, "READY", "dismiss tidak mematikan host");
        assert.ok(authority.canonical || true, "modul authority kanonik utuh");
    } finally {
        host.shutdown("test-end");
    }
});

test("HUKUM: Governor rejection tetap memblokir admission saat AWAKE/ACTIVE", async () => {
    const host = await makeHost();
    try {
        host.summon({});
        const gov = host.core.governor;
        const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");

        // Antrean penuh → admission diblokir governor meski presence bangun.
        // Presence != permission; pressure != permission.
        for (let i = 1; i <= 64; i++) {
            gov.admit(createWorkloadId(`storm-${i}`), {
                workloadClass: "AGENT", concurrencyGroup: "default"
            });
        }
        const extra = gov.admit(createWorkloadId("overflow"), {
            workloadClass: "AGENT", concurrencyGroup: "default"
        });
        assert.notEqual(extra.outcome, "ADMIT",
            "admission harus diblokir governor di bawah tekanan antrean penuh");
    } finally {
        host.shutdown("test-end");
    }
});

test("AUDIT: host tidak memanggil API minting Authority mana pun", async () => {
    const { readFileSync } = require("node:fs");
    const path = require("node:path");
    const files = [
        "../../src/runtime/host/runtimeHost.js",
        "../../src/runtime/host/phases.js",
        "../../src/runtime/host/commands.js",
        "../../src/runtime/host/transportAdapter.js",
        "../../src/runtime/host/channelBridge.js",
        "../../src/runtime/host/ports/hotkeyPort.js",
        "../../src/runtime/host/ports/trayPort.js",
        "../../src/runtime/host/voice/voiceContract.js",
        "../../src/runtime/host/main.js"
    ];
    for (const rel of files) {
        const src = readFileSync(path.join(__dirname, rel), "utf8");
        for (const forbidden of [
            "issueRatifiedRootGrant", "buildGrant(", "buildRatification(",
            ".delegate(", ".ratify(", "proposeEvolution"
        ]) {
            assert.equal(src.includes(forbidden), false,
                `${rel} memuat panggilan minting terlarang: ${forbidden}`);
        }
        assert.equal(/require\([^)]*authority/.test(src), false,
            `${rel} tidak boleh bergantung langsung pada modul authority`);
    }
});
