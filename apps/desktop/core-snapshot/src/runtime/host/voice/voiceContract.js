"use strict";

/**
 * VOICE RUNTIME CONTRACT V1 — kontrak runtime untuk suara (fondasi).
 *
 * Alur kanonik:
 *   wake trigger → LISTENING → ASR input → conversation request →
 *   THINKING → semantic response chunks → SPEAKING →
 *   barge-in recommendation → return AWAKE/DORMANT
 *
 * HUKUM:
 *   - Voice input adalah INTERAKSI, bukan Authority, bukan autentikasi.
 *     Input suara masuk lewat transport adapter + InteractionBus dengan
 *     origin VOICE; tidak pernah jalur eksekusi berhak langsung.
 *   - TTS/ASR adalah ADAPTER yang disuntik. Modul ini tidak pernah
 *     menyentuh mikrofon, audio, jaringan, atau model.
 *   - Barge-in mengikuti semantik Presence: recommendInterruption()
 *     hanyalah REKOMENDASI (INTERRUPTION_RECOMMENDED); implementasi
 *     cancellation ada di tangan pemilik aktivitas.
 *   - Identitas suara kanonik: Damar (Ardi) — id-ID-ArdiNeural,
 *     rate -8%, pitch -12Hz.
 */

const presenceMod = require("../../presence");

const ACTIVITY = presenceMod.ACTIVITY_MODE;

const CANONICAL_VOICE_IDENTITY = Object.freeze({
    persona: "Damar (Ardi)",
    voice: "id-ID-ArdiNeural",
    rate: "-8%",
    pitch: "-12Hz"
});

const VOICE_TURN_PHASE = Object.freeze({
    WAKE_TRIGGER: "WAKE_TRIGGER",
    LISTENING: "LISTENING",
    ASR_INPUT: "ASR_INPUT",
    THINKING: "THINKING",
    SPEAKING: "SPEAKING",
    BARGE_IN_RECOMMENDED: "BARGE_IN_RECOMMENDED",
    SETTLED: "SETTLED"
});

/**
 * createVoiceTurnController({ host }) — mesin giliran suara di atas
 * Presence kanonik milik host.
 *
 * Fase:
 *   beginWakeTrigger()      : DORMANT → summon (AWAKE); catat WAKE_TRIGGER.
 *   beginListening()        : activity LISTENING (AWAKE terpromosi ACTIVE).
 *   asrInput(text)          : LISTENING berakhir → THINKING; mengembalikan
 *                             request interaksi siap-kirim (TIDAK mengeksekusi).
 *   beginSpeaking()         : THINKING berakhir → SPEAKING.
 *   speakChunk(chunk)       : delegasi ke ttsAdapter jika ada (adapter murni).
 *   recommendBargeIn()      : rekomendasi interupsi pada token SPEAKING.
 *   settle({dismiss})       : akhiri aktivitas hidup → kembali AWAKE,
 *                             opsional dismiss → DORMANT.
 */
function createVoiceTurnController({ host, ttsAdapter = null, asrAdapter = null } = {}) {
    if (!host || typeof host.summon !== "function") {
        throw new TypeError("VOICE_CONTROLLER_HOST_INVALID");
    }
    if (ttsAdapter !== null && typeof ttsAdapter.speak !== "function") {
        throw new TypeError("VOICE_TTS_ADAPTER_INVALID");
    }
    if (asrAdapter !== null && typeof asrAdapter.transcribe !== "function") {
        throw new TypeError("VOICE_ASR_ADAPTER_INVALID");
    }

    let phase = VOICE_TURN_PHASE.SETTLED;
    let listeningToken = null;
    let thinkingToken = null;
    let speakingToken = null;

    function assertOperational() {
        if (host.phase !== "READY" || !host.health().healthy) {
            throw Object.assign(new Error("HOST_NOT_READY"), { code: "HOST_NOT_READY" });
        }
    }

    function setPhase(next) { phase = next; }

    function beginWakeTrigger({ source = "voice", reason = "wake-trigger" } = {}) {
        assertOperational();
        const result = host.summon({ source: `voice:${source}`, reason });
        if (!result.ok) return { ok: false, phase: VOICE_TURN_PHASE.WAKE_TRIGGER, ...result };
        setPhase(VOICE_TURN_PHASE.WAKE_TRIGGER);
        return { ok: true, phase, presenceState: result.state ?? host.core.presence.lifecycleState };
    }

    function beginListening({ ttlMs = null } = {}) {
        assertOperational();
        const started = host.beginActivity(ACTIVITY.LISTENING, { ttlMs, reason: "voice-listening" });
        if (!started.ok) return { ok: false, phase, ...started };
        listeningToken = started.token;
        setPhase(VOICE_TURN_PHASE.LISTENING);
        return { ok: true, phase };
    }

    /** ASR adapter dipanggil hanya jika disuntik; hasilnya teks interaksi.
     * Teks dikembalikan sebagai REQUEST — controller tidak pernah
     * mengeksekusinya sendiri. */
    async function asrInput({ audio = null, text = null } = {}) {
        assertOperational();
        if (phase !== VOICE_TURN_PHASE.LISTENING) {
            return { ok: false, code: "VOICE_PHASE_ILLEGAL", phase };
        }
        let transcript = text;
        if (transcript === null && asrAdapter) {
            transcript = await asrAdapter.transcribe(audio);
        }
        if (typeof transcript !== "string" || !transcript.trim()) {
            return { ok: false, code: "VOICE_TRANSCRIPT_EMPTY", phase };
        }
        // Mulai THINKING SEBELUM menutup LISTENING agar Presence tidak
        // auto-tidur ke DORMANT saat tidak ada aktivitas hidup.
        const thinking = host.beginActivity(ACTIVITY.THINKING, { reason: "voice-thinking" });
        if (!thinking.ok) {
            return { ok: false, code: thinking.code ?? "THINKING_REJECTED", phase };
        }
        if (listeningToken) {
            host.endActivity(listeningToken, { reason: "asr-final" });
            listeningToken = null;
        }
        thinkingToken = thinking.token;
        setPhase(VOICE_TURN_PHASE.ASR_INPUT);
        return {
            ok: true,
            phase: VOICE_TURN_PHASE.ASR_INPUT,
            interactionRequest: {
                transportId: null, // wajib diisi adapter transport VOICE
                kind: "MESSAGE",
                payload: { text: transcript.slice(0, 4000) },
                claimedIdentity: null
            },
            thinkingToken
        };
    }

    function beginSpeaking() {
        assertOperational();
        // Mulai SPEAKING sebelum menutup THINKING (hindari auto-sleep).
        const speaking = host.beginActivity(ACTIVITY.SPEAKING, { reason: "voice-speaking" });
        if (!speaking.ok) return { ok: false, phase, ...speaking };
        if (thinkingToken) {
            host.endActivity(thinkingToken, { reason: "response-ready" });
            thinkingToken = null;
        }
        speakingToken = speaking.token;
        setPhase(VOICE_TURN_PHASE.SPEAKING);
        return { ok: true, phase };
    }

    /** Chunk respons semantik → adapter TTS murni (jika disuntik). */
    async function speakChunk(chunk) {
        if (phase !== VOICE_TURN_PHASE.SPEAKING) {
            return { ok: false, code: "VOICE_PHASE_ILLEGAL", phase };
        }
        if (ttsAdapter && chunk && typeof chunk === "object" && typeof chunk.text === "string") {
            await ttsAdapter.speak({
                text: chunk.text,
                identity: CANONICAL_VOICE_IDENTITY
            });
        }
        return { ok: true, phase, spoken: Boolean(ttsAdapter) };
    }

    /** Barge-in: REKOMENDASI saja — bukan implementasi cancellation.
     * Interruption != cancellation; keputusan akhir di pemilik aktivitas. */
    function recommendBargeIn({ by = "user-voice" } = {}) {
        if (!speakingToken) {
            return { ok: false, code: "NO_SPEAKING_ACTIVITY", phase };
        }
        const result = host.recommendInterruption(speakingToken, {
            producer: host.core.presenceProducers.interaction,
            reason: `barge-in:${String(by).slice(0, 60)}`
        });
        if (result.ok) setPhase(VOICE_TURN_PHASE.BARGE_IN_RECOMMENDED);
        return { ...result, phase };
    }

    function settle({ dismissAfter = false } = {}) {
        for (const [name, token] of [
            ["listening", listeningToken],
            ["thinking", thinkingToken],
            ["speaking", speakingToken]
        ]) {
            if (token) {
                try { host.endActivity(token, { reason: `voice-settle:${name}` }); } catch { /* idempoten */ }
            }
        }
        listeningToken = null;
        thinkingToken = null;
        speakingToken = null;
        let dismissed = null;
        if (dismissAfter) {
            dismissed = host.dismiss({ source: "voice:settle", reason: "settle-dormant" });
        }
        setPhase(VOICE_TURN_PHASE.SETTLED);
        return { ok: true, phase, dismissed };
    }

    function snapshot() {
        return Object.freeze({
            phase,
            identity: CANONICAL_VOICE_IDENTITY,
            hasListeningToken: listeningToken !== null,
            hasThinkingToken: thinkingToken !== null,
            hasSpeakingToken: speakingToken !== null,
            adapters: Object.freeze({
                tts: ttsAdapter ? true : false,
                asr: asrAdapter ? true : false
            })
        });
    }

    return Object.freeze({
        beginWakeTrigger,
        beginListening,
        asrInput,
        beginSpeaking,
        speakChunk,
        recommendBargeIn,
        settle,
        snapshot,
        get phase() { return phase; }
    });
}

module.exports = Object.freeze({
    createVoiceTurnController,
    CANONICAL_VOICE_IDENTITY,
    VOICE_TURN_PHASE,
    VOICE_ORIGIN: "VOICE"
});
