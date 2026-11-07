"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("canonical local-only TTS never contacts configured remote or edge fallback", async () => {
    const oldUrl = process.env.DAMAR_TTS_URL;
    const oldVoice = process.env.DAMAR_TTS_VOICE;
    const oldFetch = global.fetch;
    process.env.DAMAR_TTS_URL = "https://paid.example/v1/audio/speech";
    process.env.DAMAR_TTS_VOICE = "af_heart";
    let fetches = 0;
    global.fetch = async () => { fetches += 1; throw new Error("network called"); };
    const voice = require("../../src/services/voiceService");
    try {
        await assert.rejects(voice.speak("hello", { localOnly: true }), (error) => error.code === "TTS_ALL_FAILED");
        assert.equal(fetches, 0);
    } finally {
        if (oldUrl === undefined) delete process.env.DAMAR_TTS_URL; else process.env.DAMAR_TTS_URL = oldUrl;
        if (oldVoice === undefined) delete process.env.DAMAR_TTS_VOICE; else process.env.DAMAR_TTS_VOICE = oldVoice;
        global.fetch = oldFetch;
    }
});

test("canonical local-only STT rejects remote endpoint before network", async () => {
    const oldUrl = process.env.DAMAR_STT_URL;
    const oldFetch = global.fetch;
    process.env.DAMAR_STT_URL = "https://paid.example/v1/audio/transcriptions";
    let fetches = 0;
    global.fetch = async () => { fetches += 1; throw new Error("network called"); };
    const voice = require("../../src/services/voiceService");
    try {
        await assert.rejects(voice.transcribe(Buffer.from("audio"), { localOnly: true }), (error) => error.code === "STT_LOCAL_REQUIRED");
        assert.equal(fetches, 0);
    } finally {
        if (oldUrl === undefined) delete process.env.DAMAR_STT_URL; else process.env.DAMAR_STT_URL = oldUrl;
        global.fetch = oldFetch;
    }
});

test("failed local TTS deterministically clears its request timeout", async () => {
    const voice = require("../../src/services/voiceService");
    const savedCfg = voice.cfg;
    const oldFetch = global.fetch;
    const oldSetTimeout = global.setTimeout;
    const oldClearTimeout = global.clearTimeout;
    const live = new Set();
    global.setTimeout = (fn, ms, ...args) => { const h = oldSetTimeout(fn, ms, ...args); live.add(h); return h; };
    global.clearTimeout = h => { live.delete(h); return oldClearTimeout(h); };
    voice.cfg = () => ({ stt: {}, tts: { url: "http://127.0.0.1:8880/v1/audio/speech", voice: "af_heart" } });
    global.fetch = async () => { throw new TypeError("local offline"); };
    try {
        await assert.rejects(voice.speak("hello", { localOnly: true }), (error) => error.code === "TTS_ALL_FAILED");
        assert.equal(live.size, 0);
    } finally {
        voice.cfg = savedCfg;
        global.fetch = oldFetch; global.setTimeout = oldSetTimeout; global.clearTimeout = oldClearTimeout;
        for (const handle of live) oldClearTimeout(handle);
    }
});

test("failed local STT deterministically clears its request timeout", async () => {
    const voice = require("../../src/services/voiceService");
    const savedCfg = voice.cfg;
    const oldFetch = global.fetch;
    const oldSetTimeout = global.setTimeout;
    const oldClearTimeout = global.clearTimeout;
    const live = new Set();
    global.setTimeout = (fn, ms, ...args) => { const h = oldSetTimeout(fn, ms, ...args); live.add(h); return h; };
    global.clearTimeout = h => { live.delete(h); return oldClearTimeout(h); };
    voice.cfg = () => ({ stt: { url: "http://127.0.0.1:8000/v1/audio/transcriptions" }, tts: {} });
    global.fetch = async () => { throw new TypeError("local offline"); };
    try {
        await assert.rejects(voice.transcribe(Buffer.from("audio"), { localOnly: true }));
        assert.equal(live.size, 0);
    } finally {
        voice.cfg = savedCfg;
        global.fetch = oldFetch; global.setTimeout = oldSetTimeout; global.clearTimeout = oldClearTimeout;
        for (const handle of live) oldClearTimeout(handle);
    }
});
