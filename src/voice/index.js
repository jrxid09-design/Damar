/**
 * Titik masuk subsistem suara.
 *
 * VoiceRuntime = channel baru menuju Aether Core, bukan otak kedua.
 * Lihat voiceRuntime.js untuk orchestrator; voiceSession.js untuk
 * jembatan ke aiRuntime (jalur yang sama dengan Telegram/WhatsApp).
 */
const { VoiceRuntime } = require("./voiceRuntime");
const { VoiceSession } = require("./voiceSession");
const { voiceConfig } = require("./config");
const { StateMachine, STATES } = require("./stateMachine");

const runtime = new VoiceRuntime();

module.exports = {
    runtime,
    VoiceRuntime,
    VoiceSession,
    voiceConfig,
    StateMachine,
    STATES
};
