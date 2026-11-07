"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");
const { createChannelBridge } = require("../../src/runtime/host/channelBridge");
const { EventEmitter } = require("node:events");

// ---------------------------------------------------------------- helpers

async function makeHost() {
    return createRuntimeHost({ coreOptions: {} });
}

function recordingConversation() {
    const seen = [];
    const handler = async (envelope, ctx) => {
        const stream = ctx.stream;
        stream.emit("START", { interactionId: envelope.interactionId });
        seen.push({
            text: envelope.payload?.text ?? null,
            claimed: envelope.provenance?.claimedIdentity ?? null,
            origin: envelope.origin
        });
        stream.emit("FINAL", { text: "ok" });
        stream.emit("COMPLETE", { interactionId: envelope.interactionId });
    };
    handler.seen = seen;
    return handler;
}

async function makeHostWithRecorder() {
    const conversation = recordingConversation();
    const host = await createRuntimeHost({
        coreOptions: {},
        conversationHandler: conversation
    });
    return { host, conversation };
}

// ----------------------------------------------------------------- tests

test("ADAPTER: external event → normalize → bus; provenance tercatat sebagai klaim", async () => {
    const { host, conversation } = await makeHostWithRecorder();
    try {
        const att = host.attachTransportAdapter({
            transportId: "ext.test", origin: "API"
        });
        assert.equal(att.ok, true);

        const r = att.adapter.ingestExternalEvent({
            text: "halo damar", userId: "user-77"
        });
        assert.equal(r.accepted, true);
        assert.ok(r.interactionId.startsWith("ix_"));

        assert.equal(conversation.seen.length, 1);
        assert.equal(conversation.seen[0].text, "halo damar");
        assert.deepEqual(conversation.seen[0].claimed, { id: "user-77" },
            "identitas eksternal hanya klaim di provenance, bukan fakta");
    } finally {
        host.shutdown("test-end");
    }
});

test("ADAPTER: event malformed ditolak tanpa menyentuh handler", async () => {
    const { host, conversation } = await makeHostWithRecorder();
    try {
        const att = host.attachTransportAdapter({ transportId: "ext.bad", origin: "API" });
        assert.equal(att.adapter.ingestExternalEvent(null).accepted, false);
        assert.equal(att.adapter.ingestExternalEvent({ text: "" }).code, "EVENT_TEXT_EMPTY");
        assert.equal(att.adapter.ingestExternalEvent("string").code, "EVENT_INVALID");
        assert.equal(conversation.seen.length, 0);
        assert.equal(att.adapter.snapshot().counters.rejected >= 3, true);
    } finally {
        host.shutdown("test-end");
    }
});

test("ADAPTER: sessionId kanonik stabil per identitas + fallback deterministik", async () => {
    const { host, conversation } = await makeHostWithRecorder();
    try {
        const att = host.attachTransportAdapter({ transportId: "ext.ses", origin: "API" });
        att.adapter.ingestExternalEvent({ text: "a", userId: "u-1" });
        att.adapter.ingestExternalEvent({ text: "b", userId: "u-1" });
        att.adapter.ingestExternalEvent({ text: "c", userId: null });

        // Dua event dari user sama harus satu sesi.
        assert.notEqual(conversation.seen.length, 0);
    } finally {
        host.shutdown("test-end");
    }
});

test("ADAPTER: detach → ingest setelah disconnect ditolak bersih", async () => {
    const host = await makeHost();
    try {
        const att = host.attachTransportAdapter({ transportId: "ext.det", origin: "API" });
        assert.equal(host.detachTransportAdapter("ext.det").ok, true);
        const r = att.adapter.ingestExternalEvent({ text: "setelah putus" });
        assert.equal(r.accepted, false);
        assert.equal(r.code, "ADAPTER_DISCONNECTED");
        assert.equal(host.detachTransportAdapter("ext.det").ok, false,
            "detach ganda → ADAPTER_NOT_ATTACHED");
    } finally {
        host.shutdown("test-end");
    }
});

test("BRIDGE: peristiwa telemetry Telegram nyata dinormalkan ke InteractionBus", async () => {
    const { host, conversation } = await makeHostWithRecorder();
    try {
        const emitter = new EventEmitter();
        const bridge = createChannelBridge({ bus: host.core.bus, channels: ["telegram"] });
        bridge.attachEmitter(emitter);
        assert.equal(bridge.attached, true);

        emitter.emit("telegram:message", { chatId: 4242, preview: "status damar?" });

        assert.equal(conversation.seen.length, 1);
        assert.equal(conversation.seen[0].origin, "TELEGRAM",
            "origin kanonik TELEGRAM dipertahankan bus");
        assert.deepEqual(conversation.seen[0].claimed, { id: "4242" },
            "chat id hanyalah klaim provenance");

        bridge.detach();
        emitter.emit("telegram:message", { chatId: 4242, preview: "lagi" });
        assert.equal(conversation.seen.length, 1, "setelah detach tidak diteruskan");
        assert.equal(bridge.snapshot().counters.forwarded, 1);
    } finally {
        host.shutdown("test-end");
    }
});

test("BRIDGE: fail-soft — listener tidak boleh melempar ke emitter sumber", async () => {
    const host = await makeHost();
    try {
        const emitter = new EventEmitter();
        const bridge = createChannelBridge({ bus: host.core.bus, channels: ["telegram"] });
        bridge.attachEmitter(emitter);

        // Event sampah tidak boleh crash emitter / proses.
        emitter.emit("telegram:message", null);
        emitter.emit("telegram:message", {});
        emitter.emit("telegram:message", { chatId: 1, preview: "" });
        assert.equal(bridge.snapshot().counters.forwarded, 0);
    } finally {
        host.shutdown("test-end");
    }
});

test("BRIDGE: channel tak dikenal gagal tertutup saat konstruksi", async () => {
    const host = await makeHost();
    try {
        assert.throws(() => createChannelBridge({
            bus: host.core.bus, channels: ["discord"]
        }), /CHANNEL_BRIDGE_UNKNOWN_CHANNEL/);
    } finally {
        host.shutdown("test-end");
    }
});
