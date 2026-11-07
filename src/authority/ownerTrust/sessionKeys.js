"use strict";

/**
 * SESSION KEY GRAMMAR for trust-domain consumption (Wave 5 Lane 4).
 *
 * SessionStore keys look like `channel:<kanal>:<kind>:<peer>`.  The trust
 * domain needs the channel + peer part to match against transport bindings;
 * a session key alone is NEVER evidence — it only names a conversation.
 */

const LINKABLE_CHANNELS = Object.freeze(["console", "telegram", "whatsapp"]);

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

/** Parse `channel:<kanal>:<kind>:<peer>` (SessionStore.sessionKey grammar). */
function parseSessionKeyPart(key) {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
        throw fail("OT_SESSION_KEY_INVALID", "session key malformed");
    }
    const parts = key.split(":");
    if (parts.length < 4 || parts[0] !== "channel") {
        throw fail("OT_SESSION_KEY_INVALID", "session key grammar mismatch");
    }
    const channel = parts[1];
    const kind = parts[2];
    const peer = parts.slice(3).join(":");
    if (!LINKABLE_CHANNELS.includes(channel)) {
        throw fail("OT_CHANNEL_NOT_LINKABLE", `channel '${channel}' has no canonical binder`);
    }
    if (kind !== "dm" && kind !== "group") {
        throw fail("OT_SESSION_KEY_INVALID", "session kind must be dm|group");
    }
    if (typeof peer !== "string" || peer.length === 0) {
        throw fail("OT_SESSION_KEY_INVALID", "session peer empty");
    }
    return { channel, kind, peer };
}

module.exports = Object.freeze({
    parseSessionKeyPart,
    LINKABLE_CHANNELS
});
