const test = require("node:test");
const assert = require("node:assert");

const { StateMachine, STATES } = require("../../src/voice/stateMachine");
const { WakeWordProvider } = require("../../src/voice/providers/wakeWord");
const { ClapDetector } = require("../../src/voice/providers/clapDetector");
const { VadDetector } = require("../../src/voice/providers/vad");
const { AudioInput } = require("../../src/voice/providers/audioInput");
const { AudioOutput } = require("../../src/voice/providers/audioOutput");
const { VoiceRuntime } = require("../../src/voice/voiceRuntime");
const { VoiceSession } = require("../../src/voice/voiceSession");

/**
 * Voice Runtime — always-on assistant. Semua test menguji PERILAKU
 * fungsional: state machine, wake word, VAD, graceful degradation.
 * Tidak ada yang menguji hardware audio sungguhan (backend default none).
 */

// ---- StateMachine ----

test("state machine: transisi sah mengikuti lifecycle", () => {
    const sm = new StateMachine();
    assert.equal(sm.current, STATES.IDLE);

    assert.equal(sm.transit(STATES.WAKE_DETECTED), true);
    assert.equal(sm.transit(STATES.LISTENING), true);
    assert.equal(sm.transit(STATES.TRANSCRIBING), true);
    assert.equal(sm.transit(STATES.THINKING), true);
    assert.equal(sm.transit(STATES.SPEAKING), true);
    assert.equal(sm.transit(STATES.IDLE), true);
});

test("state machine: lompatan ilegal ditolak (IDLE → SPEAKING)", () => {
    const sm = new StateMachine();
    assert.equal(sm.transit(STATES.SPEAKING), false, "IDLE tidak boleh langsung SPEAKING");
    assert.equal(sm.current, STATES.IDLE);
});

test("state machine: barge-in SPEAKING → LISTENING sah", () => {
    const sm = new StateMachine();
    sm.transit(STATES.WAKE_DETECTED);
    sm.transit(STATES.LISTENING);
    sm.transit(STATES.TRANSCRIBING);
    sm.transit(STATES.THINKING);
    sm.transit(STATES.SPEAKING);
    assert.equal(sm.transit(STATES.LISTENING), true, "barge-in harus sah");
});

test("state machine: reset paksa kembali ke IDLE", () => {
    const sm = new StateMachine();
    sm.transit(STATES.WAKE_DETECTED);
    sm.transit(STATES.LISTENING);
    sm.reset();
    assert.equal(sm.current, STATES.IDLE);
});

test("state machine: elapsed melacak waktu masuk state", async () => {
    const sm = new StateMachine();
    sm.transit(STATES.WAKE_DETECTED);
    await new Promise(r => setTimeout(r, 20));
    assert.ok(sm.elapsed() >= 20);
});

// ---- WakeWordProvider ----

test("wake word: mendeteksi kata panggil utuh", () => {
    const w = new WakeWordProvider({ wakeWord: "damar" });
    assert.equal(w.detect("Damar").detected, true);
    assert.equal(w.detect("hej damar buka cctv").detected, true);
});

test("wake word: TIDAK mendeteksi substring (ethereum)", () => {
    const w = new WakeWordProvider({ wakeWord: "damar" });
    assert.equal(w.detect("ethereum").detected, false, "jangan salah deteksi substring");
});

test("wake word: kosong → tidak terdeteksi", () => {
    const w = new WakeWordProvider({ wakeWord: "damar" });
    assert.equal(w.detect("").detected, false);
});

// ---- ClapDetector (trigger tepuk tangan 2x) ----

test("clap: dua tepukan dalam jendela → terdeteksi", () => {
    const c = new ClapDetector({ threshold: 0.6, windowMs: 800, minGapMs: 100, minClapMs: 30 });
    const t0 = 1000;

    // Tepukan 1: naik di t0, turun di t0+50 (durasi 50ms = clap valid).
    c.feedLevel(0.9, t0);
    c.feedLevel(0.1, t0 + 50);

    // Tepukan 2: naik di t0+300, turun di t0+350 (gap 300ms, dalam jendela).
    c.feedLevel(0.9, t0 + 300);
    c.feedLevel(0.1, t0 + 350);

    const r = c.detect(t0 + 350);
    assert.equal(r.detected, true);
    assert.equal(r.claps, 2);
    assert.ok(r.gapMs >= 100 && r.gapMs <= 800);
});

test("clap: SATU tepukan saja → tidak terdeteksi", () => {
    const c = new ClapDetector({ threshold: 0.6, windowMs: 800, minGapMs: 100, minClapMs: 30 });
    const t0 = 1000;
    c.feedLevel(0.9, t0);
    c.feedLevel(0.1, t0 + 50);

    const r = c.detect(t0 + 50);
    assert.equal(r.detected, false);
});

test("clap: dua tepukan TERLALU jauh (di luar jendela) → tidak terdeteksi", () => {
    const c = new ClapDetector({ threshold: 0.6, windowMs: 800, minGapMs: 100, minClapMs: 30 });
    const t0 = 1000;

    c.feedLevel(0.9, t0);
    c.feedLevel(0.1, t0 + 50);

    c.feedLevel(0.9, t0 + 2000); // gap 2000ms > window 800ms
    c.feedLevel(0.1, t0 + 2050);

    const r = c.detect(t0 + 2050);
    assert.equal(r.detected, false);
});

test("clap: bunyi panjang (bukan dua clap) → tidak terdeteksi", () => {
    const c = new ClapDetector({ threshold: 0.6, windowMs: 800, minGapMs: 100, minClapMs: 30 });
    const t0 = 1000;

    // Satu bunyi keras panjang (naik t0, turun t0+500) = 1 clap, bukan 2.
    c.feedLevel(0.9, t0);
    c.feedLevel(0.1, t0 + 500);

    const r = c.detect(t0 + 500);
    assert.equal(r.detected, false);
});

test("clap: level di bawah threshold → diabaikan (noise)", () => {
    const c = new ClapDetector({ threshold: 0.6, windowMs: 800, minGapMs: 100, minClapMs: 30 });
    const t0 = 1000;

    c.feedLevel(0.2, t0);       // di bawah threshold
    c.feedLevel(0.1, t0 + 50);
    c.feedLevel(0.3, t0 + 300); // masih di bawah threshold
    c.feedLevel(0.1, t0 + 350);

    const r = c.detect(t0 + 350);
    assert.equal(r.detected, false);
});

// ---- VadDetector ----

test("VAD: selesai setelah diam melewati timeout", () => {
    const v = new VadDetector({ vadTimeoutMs: 50 });
    const now = Date.now();
    v.start(now);
    assert.equal(v.selesai(now), false);
    assert.equal(v.selesai(now + 60), true, "diam 60ms > timeout 50ms harus selesai");
});

test("VAD: touch memperpanjang (masih bicara)", () => {
    const v = new VadDetector({ vadTimeoutMs: 50 });
    const now = Date.now();
    v.start(now);
    v.touch(now + 40);
    assert.equal(v.selesai(now + 80), false, "baru 40ms sejak touch");
    assert.equal(v.selesai(now + 100), true);
});

// ---- AudioInput / AudioOutput (graceful default none) ----

test("AudioInput backend none: probe false, startCapture null (tanpa error)", async () => {
    const a = new AudioInput({ backend: "none" });
    assert.equal(await a.probe(), false);
    assert.equal(await a.startCapture({ durationMs: 100 }), null);
});

test("AudioOutput backend none: play no-op (tanpa error), status false", async () => {
    const o = new AudioOutput({ backend: "none" });
    assert.equal(await o.probe(), false);
    await o.play(Buffer.from([1, 2, 3])); // harus no-op tanpa throw
    assert.equal(o.status().available, false);
});

test("AudioOutput CLI: probe + play tidak melempar (graceful)", async () => {
    const o = new AudioOutput({ backend: "cli" });
    const ok = await o.probe(); // true bila ffplay/aplay/powershell ada

    // play() dengan buffer kecil: bila player ada, ia memutar (dan bisa
    // di-interrupt); bila tidak, no-op. Keduanya tak boleh melempar.
    await o.play(Buffer.from([1, 2, 3, 4]));

    assert.ok(ok === true || ok === false);
});

test("AudioOutput.stop: membunuh _child dan mengosongkannya (barge-in)", async () => {
    const o = new AudioOutput({ backend: "cli" });

    // Simulasikan proses pemutar aktif.
    const fake = {
        killed: false,
        kill(sig) { this.killed = true; }
    };
    o._child = fake;

    await o.stop();

    assert.equal(fake.killed, true);
    assert.equal(o._child, null);
    assert.equal(o.status().playing, false);
});

test("AudioInput CLI: probe + startCapture tidak melempar (graceful)", async () => {
    const a = new AudioInput({ backend: "cli" });
    const ok = await a.probe(); // true bila ffmpeg/arecord ada, false bila tidak

    const cap = await a.startCapture({ durationMs: 100 });

    if (ok) {
        // Recorder tersedia → harus mengembalikan objek capture valid.
        assert.ok(cap, "bila recorder ada, startCapture harus mengembalikan objek");
        assert.equal(typeof cap.stop, "function");
        const buf = await cap.stop();
        assert.ok(Buffer.isBuffer(buf), "stop harus mengembalikan Buffer");
    }
    else {
        // Tanpa recorder → null, tidak melempar.
        assert.equal(cap, null);
    }
});

test("AudioInput: argumen ffmpeg/arecord benar (16kHz mono WAV)", () => {
    const a = new AudioInput({ backend: "cli" });

    const ff = a._ffmpegArgs("/tmp/x.wav", 3);
    assert.equal(ff.cmd, "ffmpeg");
    assert.ok(ff.args.includes("-ar"));
    assert.ok(ff.args.includes("16000"));
    assert.ok(ff.args.includes("-ac"));
    assert.ok(ff.args.includes("1"));

    const ar = a._arecordArgs("/tmp/x.wav", 3);
    assert.equal(ar.cmd, "arecord");
    assert.ok(ar.args.includes("16000"));
});

test("AudioInput._rms: menghitung RMS 0..1 dari PCM s16le", () => {
    const a = new AudioInput({ backend: "cli" });

    // Amplitudo penuh (32767) → RMS ~1
    const penuh = Buffer.alloc(4);
    penuh.writeInt16LE(32767, 0);
    penuh.writeInt16LE(32767, 2);
    assert.ok(a._rms(penuh) > 0.99);

    // Setengah amplitudo (16384) → RMS ~0.5
    const setengah = Buffer.alloc(4);
    setengah.writeInt16LE(16384, 0);
    setengah.writeInt16LE(16384, 2);
    assert.ok(Math.abs(a._rms(setengah) - 0.5) < 0.01);

    // Diam → RMS 0
    assert.equal(a._rms(Buffer.alloc(4)), 0);

    // Buffer kosong → 0
    assert.equal(a._rms(Buffer.alloc(0)), 0);
});

test("AudioInput._levelArgs: ffmpeg stream PCM ke pipe:1", () => {
    const a = new AudioInput({ backend: "cli" });
    a._recorder = "ffmpeg";
    const { cmd, args } = a._levelArgs();
    assert.equal(cmd, "ffmpeg");
    assert.ok(args.includes("s16le"), "harus PCM s16le");
    assert.ok(args.includes("pipe:1"), "harus stream ke stdout");
    assert.ok(args.includes("16000"));
});

test("AudioInput._levelArgs: arecord stream raw ke stdout", () => {
    const a = new AudioInput({ backend: "cli" });
    a._recorder = "arecord";
    const { cmd, args } = a._levelArgs();
    assert.equal(cmd, "arecord");
    assert.ok(args.includes("raw"));
    assert.ok(args.includes("16000"));
});

// ---- VoiceRuntime (graceful degradation + wake + ack) ----

function makeRuntime(overrides = {}) {
    return new VoiceRuntime({
        interactionIngress: { request: async () => ({ detail: "jawaban lokal", outcomeLabel: "selesai" }) },
        config: () => ({
            enabled: true,
            wakeWord: "damar",
            wakeProvider: "local",
            sttProvider: "local",
            ttsProvider: "local",
            maxSessionMs: 60000,
            vadTimeoutMs: 100,
            maxListenMs: 1000,
            acknowledgement: "Ya?",
            language: "id",
            clapEnabled: false,
            clapThreshold: 0.6,
            clapWindowMs: 800,
            clapMinClapMs: 30,
            clapMinGapMs: 100,
            ...overrides
        })
    });
}

test("VoiceRuntime: wakeDetect memicu WAKE_DETECTED + ack (tanpa LLM)", async () => {
    const rt = makeRuntime();
    let acked = null;
    rt.on("ack", a => { acked = a; });

    const r = rt.wakeDetect("Damar");
    assert.equal(r.detected, true);
    assert.equal(rt.machine.current, STATES.WAKE_DETECTED);
    assert.equal(acked, "Ya?");

    await rt.stop();
});

test("VoiceRuntime: clapDetect (2 tepukan) memicu WAKE_DETECTED + ack", async () => {
    const rt = makeRuntime({ clapEnabled: true });
    let wakeSource = null;
    let acked = null;
    rt.on("wake", w => { wakeSource = w.source; });
    rt.on("ack", a => { acked = a; });

    const t0 = 5000;
    // Tepukan 1
    rt.clapDetect(0.9, t0);
    rt.clapDetect(0.1, t0 + 50);
    // Tepukan 2
    rt.clapDetect(0.9, t0 + 300);
    const r = rt.clapDetect(0.1, t0 + 350);

    assert.equal(r.detected, true);
    assert.equal(wakeSource, "clap");
    assert.equal(rt.machine.current, STATES.WAKE_DETECTED);
    assert.equal(acked, "Ya?");

    await rt.stop();
});

test("VoiceRuntime._startStandbyStream: alirkan RMS mic → clapDetect (wiring)", async () => {
    const rt = makeRuntime({ clapEnabled: true });

    // Mock input: backend cli + startLevelStream yang menangkap onLevel.
    let fed = null;
    rt.input.available = true;
    rt.input.startLevelStream = async (onLevel) => {
        fed = onLevel;
        return { stop() { rt.input.stopped = true; } };
    };

    // Spy pada clapDetect untuk memastikan stream meneruskannya.
    const calls = [];
    const orig = rt.clapDetect.bind(rt);
    rt.clapDetect = (rms, t) => {
        calls.push(rms);
        return orig(rms, t);
    };

    await rt._startStandbyStream();

    assert.ok(rt._levelStream, "level stream harus aktif");
    assert.equal(typeof fed, "function");

    // Alirkan sampel RMS — callback stream harus memanggil clapDetect.
    fed(0.9);
    fed(0.1);

    assert.ok(calls.length >= 2, "callback stream harus meneruskan RMS ke clapDetect");

    await rt.stop();
    assert.equal(rt._levelStream, null, "stop harus menutup stream");
    assert.equal(rt.input.stopped, true, "stop harus memanggil stream.stop()");
});

test("VoiceRuntime: nonaktif default — start tidak mengaktifkan loop", async () => {
    const rt = new VoiceRuntime({
        config: () => ({ enabled: false, wakeWord: "damar", acknowledgement: "Ya?" })
    });
    await rt.start();
    assert.equal(rt.enabled, false);
    assert.equal(rt.running, false);
    await rt.stop();
});

test("VoiceRuntime: interrupt (barge-in) menghentikan TTS dan kembali", async () => {
    const rt = makeRuntime();
    let interrupted = false;
    rt.on("interrupt", () => { interrupted = true; });

    // Simulasikan sedang SPEAKING lalu interupsi.
    rt.machine.transit(STATES.WAKE_DETECTED);
    rt.machine.transit(STATES.LISTENING);
    rt.machine.transit(STATES.TRANSCRIBING);
    rt.machine.transit(STATES.THINKING);
    rt.machine.transit(STATES.SPEAKING);

    await rt.interrupt();

    assert.equal(interrupted, true);
    assert.equal(rt.machine.current, STATES.LISTENING);

    await rt.stop();
});

test("VoiceRuntime: TTS/speaker gagal TIDAK melempar (daemon tetap hidup)", async () => {
    const rt = makeRuntime();
    // speak() harus menelan kegagalan, tidak re-throw.
    await rt.speak("tes"); // backend none → output.play no-op; voiceService.speak mungkin throw (TTS tak ada)
    // Yang penting: tidak ada exception keluar.
    assert.ok(true);
    await rt.stop();
});

// ---- VoiceSession (jalur AI yang sama) ----

test("VoiceSession.think memakai ingress kanonik (bukan cognition paralel)", async () => {
    let captured = null;
    const ingress = {
        request: async (channel, event) => {
            captured = { channel, event };
            return { detail: "Suhu 27 derajat.", outcomeLabel: "selesai" };
        }
    };

    const session = new VoiceSession({ interactionIngress: ingress });
    const { answer } = await session.think("Berapa suhu kamar?");

    assert.equal(answer, "Suhu 27 derajat.");
    assert.equal(captured.channel, "voice");
    assert.equal(captured.event.sessionId, "ses_voice-owner");
    assert.equal(captured.event.userId, "owner");

    // Riwayat persisten tercatat.
    const history = await session.history();
    assert.ok(history.length >= 2);
    assert.equal(history.at(-2).role, "user");
    assert.equal(history.at(-1).role, "assistant");
});

// ---- Graceful degradation lanjutan ----

test("VoiceRuntime.handleTranscript: model gagal → reset, tidak throw", async () => {
    const failingIngress = {
        request: async () => { throw new Error("model offline"); }
    };

    const rt = makeRuntime();
    rt.session = new VoiceSession({ interactionIngress: failingIngress });

    const res = await rt.handleTranscript("halo");

    assert.equal(res.error, "model offline");
    assert.equal(rt.machine.current, STATES.IDLE, "harus reset ke IDLE setelah gagal");
    assert.equal(rt.lastError, "model offline");

    await rt.stop();
});

test("VoiceRuntime.handleTranscript rejects hostile coercion without callback", async () => {
    const rt = makeRuntime();
    let callbacks = 0;
    const result = await rt.handleTranscript({ toString() { callbacks += 1; return "execute"; } });
    assert.equal(result.skipped, true);
    assert.equal(callbacks, 0);
    await rt.stop();
});

test("barge-in aborts active TTS and prevents stale audio playback", async () => {
    const rt = makeRuntime();
    const voice = require("../../src/services/voiceService");
    const originalSpeak = voice.speak;
    let release;
    let signal;
    let played = 0;
    voice.speak = (_text, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); };
    rt.output.play = async () => { played += 1; };
    rt.machine.transit(STATES.WAKE_DETECTED);
    rt.machine.transit(STATES.LISTENING);
    rt.machine.transit(STATES.TRANSCRIBING);
    rt.machine.transit(STATES.THINKING);
    rt.machine.transit(STATES.SPEAKING);
    const controller = new AbortController();
    rt._turnController = controller;
    const generation = rt._turnGeneration;
    const speaking = rt.speak("old", { signal: controller.signal, generation });
    await new Promise(resolve => setImmediate(resolve));
    await rt.interrupt();
    assert.equal(signal.aborted, true);
    release({ audio: Buffer.from("stale") });
    await speaking;
    assert.equal(played, 0);
    voice.speak = originalSpeak;
    await rt.stop();
});

test("stop supersedes cognition and late result cannot re-enter speaking", async () => {
    let resolveThinking;
    const rt = makeRuntime();
    rt.session = { think: () => new Promise(resolve => { resolveThinking = resolve; }) };
    let spoken = 0;
    rt.speak = async () => { spoken += 1; };
    const turn = rt.handleTranscript("old turn");
    await new Promise(resolve => setImmediate(resolve));
    await rt.stop();
    resolveThinking({ answer: "late" });
    const result = await turn;
    assert.equal(result.cancelled, true);
    assert.equal(spoken, 0);
    assert.equal(rt.machine.current, STATES.IDLE);
});

test("barge-in stops active capture owned by the superseded turn", async () => {
    const rt = makeRuntime();
    let stops = 0;
    rt._activeCapture = { stop: async () => { stops += 1; return Buffer.alloc(0); } };
    rt._turnController = new AbortController();
    const signal = rt._turnController.signal;
    await rt.interrupt();
    assert.equal(signal.aborted, true);
    assert.equal(stops, 1);
    assert.equal(rt._activeCapture, null);
    await rt.stop();
});

test("stale turn finally cannot reset or clear the newer turn", async () => {
    const rt = makeRuntime();
    rt.machine.transit(STATES.WAKE_DETECTED);
    rt.machine.transit(STATES.LISTENING);
    rt.machine.transit(STATES.TRANSCRIBING);
    rt.machine.transit(STATES.THINKING);
    const pending = [];
    rt.session = { think: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
    rt.speak = async () => {};
    let idleTransitions = 0;
    rt.on("state", ({ to }) => { if (to === STATES.IDLE) idleTransitions += 1; });

    const oldTurn = rt.handleTranscript("old");
    await new Promise(resolve => setImmediate(resolve));
    const newTurn = rt.handleTranscript("new");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rt.machine.current, STATES.THINKING);
    const newController = rt._turnController;

    pending[0].resolve({ answer: "late old" });
    const oldResult = await oldTurn;
    assert.equal(oldResult.cancelled, true);
    assert.equal(rt.machine.current, STATES.THINKING);
    assert.equal(rt._turnController, newController, "stale finally cannot clear newer controller");

    pending[1].resolve({ answer: "new answer" });
    const newResult = await newTurn;
    assert.equal(newResult.answer, "new answer");
    assert.equal(rt.machine.current, STATES.IDLE);
    assert.equal(idleTransitions, 1, "only the owning turn performs terminal reset");
    await rt.stop();
});

test("late rejected old turn cannot mutate newer state", async () => {
    const rt = makeRuntime();
    rt.machine.transit(STATES.WAKE_DETECTED);
    rt.machine.transit(STATES.LISTENING);
    rt.machine.transit(STATES.TRANSCRIBING);
    rt.machine.transit(STATES.THINKING);
    const pending = [];
    rt.session = { think: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
    const oldTurn = rt.handleTranscript("old");
    await new Promise(resolve => setImmediate(resolve));
    const newTurn = rt.handleTranscript("new");
    await new Promise(resolve => setImmediate(resolve));
    pending[0].reject(new Error("late abort"));
    assert.equal((await oldTurn).cancelled, true);
    assert.equal(rt.machine.current, STATES.THINKING);
    pending[1].resolve({ answer: "ok" });
    assert.equal((await newTurn).answer, "ok");
    assert.equal(rt.machine.current, STATES.IDLE);
    await rt.stop();
});

async function captureRace({ action, abortAndInterrupt = false, normal = false } = {}) {
    const rt = makeRuntime();
    let stops = 0;
    let releaseStop;
    const stopDone = new Promise(resolve => { releaseStop = resolve; });
    rt.input.startCapture = async () => ({
        stop: async () => { stops += 1; releaseStop(); return Buffer.alloc(20000); }
    });
    const controller = new AbortController();
    rt._turnController = controller;
    const capturePromise = rt._captureUtterance(1000, { signal: controller.signal, generation: rt._turnGeneration });
    await new Promise(resolve => setImmediate(resolve));
    if (normal) await rt._finalizeCapture(rt._activeCapture);
    else if (abortAndInterrupt) {
        controller.abort();
        await rt.interrupt();
    } else if (action === "abort") controller.abort();
    else if (action === "interrupt") await rt.interrupt();
    else if (action === "stop") await rt.stop();
    await Promise.race([capturePromise, stopDone]);
    await capturePromise;
    assert.equal(stops, 1);
    await rt.stop();
}

test("capture cleanup stops exactly once on abort", () => captureRace({ action: "abort" }));
test("capture cleanup stops exactly once on barge-in", () => captureRace({ action: "interrupt" }));
test("capture cleanup stops exactly once on stop", () => captureRace({ action: "stop" }));
test("capture abort and interrupt race stops exactly once", () => captureRace({ abortAndInterrupt: true }));
test("normal capture completion has no duplicate terminal cleanup", () => captureRace({ normal: true }));

test("stale capture cleanup cannot stop a newer capture", async () => {
    const rt = makeRuntime();
    const stops = [];
    let calls = 0;
    rt.input.startCapture = async () => {
        calls += 1;
        const id = calls;
        return { stop: async () => { stops.push(id); return Buffer.alloc(20000); } };
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = rt._captureUtterance(1000, { signal: firstController.signal, generation: 1 });
    await new Promise(resolve => setImmediate(resolve));
    const second = rt._captureUtterance(1000, { signal: secondController.signal, generation: 2 });
    await new Promise(resolve => setImmediate(resolve));
    firstController.abort();
    await first;
    assert.deepEqual(stops, [1]);
    assert.notEqual(rt._activeCapture, null);
    secondController.abort();
    await second;
    assert.deepEqual(stops, [1, 2]);
    await rt.stop();
});

test("VoiceRuntime: input/mic unavailable tidak memblokir status", async () => {
    const rt = makeRuntime();
    await rt.start(); // backend none → probe false, tapi start tetap sukses
    const s = rt.status();
    assert.equal(s.microphone.available, false);
    assert.equal(s.speaker.available, false);
    assert.equal(s.enabled, true);
    await rt.stop();
});

test("VoiceRuntime.stop: bersih tanpa error (daemon shutdown aman)", async () => {
    const rt = makeRuntime();
    await rt.start();
    await rt.stop();
    assert.equal(rt.running, false);
    assert.equal(rt.machine.current, STATES.IDLE);
});

test("actual VoiceRuntime lazily binds canonical RuntimeHost Manager ingress", async () => {
    const rt = makeRuntime();
    rt.session = new VoiceSession();
    await rt.start();
    assert.equal(typeof rt.session.interactionIngress.request, "function");
    const result = await rt.handleTranscript("status aman");
    assert.equal(typeof result.answer, "string");
    assert.match(result.answer, /authentication|autentikasi/i);
    assert.equal(rt.interactionHost.channels, rt.session.interactionIngress);
    await rt.stop();
});
