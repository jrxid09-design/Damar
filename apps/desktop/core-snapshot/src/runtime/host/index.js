"use strict";

const hostMod = require("./runtimeHost");
const { createTransportAdapter } = require("./transportAdapter");
const { createChannelBridge, CHANNEL_SPECS } = require("./channelBridge");
const { createHotkeyPort } = require("./ports/hotkeyPort");
const { createTrayController, createTrayControllerForHost } = require("./ports/trayPort");
const {
    createVoiceTurnController,
    CANONICAL_VOICE_IDENTITY,
    VOICE_TURN_PHASE
} = require("./voice/voiceContract");

module.exports = Object.freeze({
    ...hostMod,
    createTransportAdapter,
    createChannelBridge,
    CHANNEL_SPECS,
    createHotkeyPort,
    createTrayController,
    createTrayControllerForHost,
    createVoiceTurnController,
    CANONICAL_VOICE_IDENTITY,
    VOICE_TURN_PHASE
});
