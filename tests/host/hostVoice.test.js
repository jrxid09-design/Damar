"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");
const {
    createVoiceTurnController,
    CANONICAL_VOICE_IDENTITY,
    VOICE_TURN_PHASE
} = require("../../src/runtime/host/voice/voiceContract");

// ---------------------------------------------------------------- helpers

async function makeVoiceHost() {
    const host = await createRuntimeHost({ coreOptions: {} });
    const controller = createVoiceTurnController({ host });
    return { host, controller };
}

// ----------------------------------------------------------------- tests

test("IDENTITAS: voice kanonik Damar (Ardi) terkunci", () => {
    assert.deepEqual(CANONICAL_VOICE_IDENTITY, {
        persona: "Damar (Ardi)",
        voice: "id-ID-ArdiNeural",
        rate: "-8%",
        pitch: "-12Hz"
    });
});

test("ALUR: wake → LISTENING → ASR → THINKING → SPEAKING → settle", async () => {
    const { host, controller } = await makeVoiceHost();
    try {
        // Wake trigger dari DORMANT harus summon.
        const wake = controller.beginWakeTrigger({});
        assert.equal(wake.ok, true);
        assert.equal(host.health().presenceState, "AWAKE");

        assert.equal(controller.beginListening().ok, true);
        assert.equal(controller.phase, VOICE_TURN_PHASE.LISTENING);
        assert.equal(host.health().presenceState, "ACTIVE",
            "LISTENING mempromosikan AWAKE ke ACTIVE via Presence kanonik");

        const asr = await controller.asrInput({ text: "jam berapa sekarang" });
        assert.equal(asr.ok, true);
        assert.equal(asr.interactionRequest.payload.text, "jam berapa sekarang");
        assert.equal(controller.phase, VOICE_TURN_PHASE.ASR_INPUT);

        const speak = controller.beginSpeaking();
        assert.equal(speak.ok, true);
        assert.equal(controller.phase, VOICE_TURN_PHASE.SPEAKING);

        const settle = controller.settle({ dismissAfter: true });
        assert.equal(settle.ok, true);
        assert.equal(settle.dismissed.state ?? settle.dismissed.to, "DORMANT",
            "settle dengan dismiss kembali ke DORMANT");
        assert.equal(controller.phase, VOICE_TURN_PHASE.SETTLED);
    } finally {
        host.shutdown("test-end");
    }
});

test("BARGE-IN: hanya rekomendasi (INTERRUPTION_RECOMMENDED), bukan cancellation", async () => {
    const { host, controller } = await makeVoiceHost();
    try {
        controller.beginWakeTrigger({});
        await controller.beginListening();
        await controller.asrInput({ text: "ceritakan dongeng panjang" });
        controller.beginSpeaking();

        const barge = controller.recommendBargeIn({ by: "user-voice" });
        assert.equal(barge.ok, true);

        // Aktivitas SPEAKING tetap hidup — rekomendasi tidak membunuh.
        const status = host.core.presence.getPresenceStatus();
        assert.equal(status.activeActivityCount >= 1, true,
            "speaking masih live setelah rekomendasi barge-in");
        assert.notEqual(controller.phase, undefined);

        // Pemilik aktivitas yang mengakhiri dengan token asli.
        const snap = controller.snapshot();
        assert.equal(snap.hasSpeakingToken, true);
        controller.settle({});
        assert.equal(controller.snapshot().hasSpeakingToken, false);
    } finally {
        host.shutdown("test-end");
    }
});

test("VOICE != authority: input suara hanya interaksi; tanpa adapter TTS/ASR tetap jalan", async () => {
    const { host, controller } = await makeVoiceHost();
    try {
        assert.equal(controller.snapshot().adapters.tts, false);
        assert.equal(controller.snapshot().adapters.asr, false);

        controller.beginWakeTrigger({});
        await controller.beginListening();

        // Tanpa ASR adapter dan tanpa teks → gagal bersih, tidak ada eksekusi.
        const r = await controller.asrInput({ audio: Buffer.alloc(4) });
        assert.equal(r.ok, false);
        assert.equal(r.code, "VOICE_TRANSCRIPT_EMPTY");
    } finally {
        host.shutdown("test-end");
    }
});

test("ADAPTER TTS menerima identitas kanonik saat speakChunk", async () => {
    const spoken = [];
    const ttsAdapter = {
        async speak(input) { spoken.push(input); }
    };
    const asrAdapter = {
        async transcribe() { return "halo dari mic"; }
    };
    const host = await createRuntimeHost({ coreOptions: {} });
    try {
        const controller = createVoiceTurnController({ host, ttsAdapter, asrAdapter });
        controller.beginWakeTrigger({});
        await controller.beginListening();
        const asr = await controller.asrInput({ audio: null }); // via adapter
        assert.equal(asr.ok, true);
        assert.equal(asr.interactionRequest.payload.text, "halo dari mic");

        controller.beginSpeaking();
        await controller.speakChunk({ text: "Halo juga." });
        assert.equal(spoken.length, 1);
        assert.equal(spoken[0].identity.voice, "id-ID-ArdiNeural");
        assert.equal(spoken[0].identity.rate, "-8%");
        assert.equal(spoken[0].identity.pitch, "-12Hz");
    } finally {
        host.shutdown("test-end");
    }
});

test("GUARD: fase ilegal ditolak tertutup (speakChunk di luar SPEAKING)", async () => {
    const { host, controller } = await makeVoiceHost();
    try {
        const r = await controller.speakChunk({ text: "x" });
        assert.equal(r.ok, false);
        assert.equal(r.code, "VOICE_PHASE_ILLEGAL");
    } finally {
        host.shutdown("test-end");
    }
});
