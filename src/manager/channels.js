"use strict";

/**
 * DAMAR MANAGER — built-in channel normalizers (Lane 5).
 *
 * These are INERT declarative adapters for the active channel classes.
 * They shape transport payloads into normalized request material and render
 * outbound projections. They:
 *
 *   - NEVER authorize actions
 *   - NEVER change principal
 *   - NEVER mint trusted sessions
 *   - NEVER inject capabilities
 *   - NEVER choose verifier or actuator
 *   - NEVER bypass the Manager or the fabric
 *
 *   CHANNEL != AUTHORITY
 *
 * They are wired through the TRUSTED composition (composition-time only);
 * they are NOT exported as a mutable public registry.
 *
 * ONE DAMAR: all five channels normalize toward the SAME canonical Manager —
 * there is no TelegramDamar / WhatsAppDamar / ConsoleDamar identity instance.
 */

const { CHANNEL_TYPES } = require("./schema");
const { OUTCOME } = require("./errors");

/**
 * Shared inbound normalization: extract a bounded declarative payload from
 * channel-specific message shapes. Metadata is forwarded as-is for the
 * Manager to detach/bound — it NEVER carries authority.
 */
function normalizeCommon({ channelType, channelId, peer, sessionId, payload, metadata }) {
    return {
        channelType,
        channelId,
        peer: peer ?? "",
        sessionId,
        // Normalize the common "user said something" shape.
        payload: {
            text: typeof payload?.text === "string" ? payload.text : String(payload ?? ""),
            ...((payload && typeof payload === "object" && payload.data && typeof payload.data === "object") ? payload.data : {})
        },
        metadata: metadata ?? null
    };
}

/**
 * Shared outbound rendering: the SAME semantic lifecycle classification for
 * every channel. Channels may vary presentation only — never the outcome
 * category (no channel-specific timeout reinterpretation).
 */
function renderCommon(managerResult) {
    const outcomeText = {
        [OUTCOME.COMPLETED]: "selesai (terverifikasi)",
        [OUTCOME.EXECUTED_UNVERIFIED]: "dieksekusi (belum terverifikasi)",
        [OUTCOME.INCONCLUSIVE]: "hasil tidak dapat dipastikan",
        [OUTCOME.FAILED]: "gagal",
        [OUTCOME.AUTHORITY_DENIED]: "ditolak otoritas",
        [OUTCOME.CANCELLED]: "dibatalkan",
        [OUTCOME.INVALID_REQUEST]: "permintaan tidak valid",
        [OUTCOME.AUTHENTICATION_REQUIRED]: "autentikasi diperlukan"
    };
    return {
        channelType: managerResult ? undefined : undefined,
        requestId: managerResult?.managerRequestId ?? null,
        outcome: managerResult?.outcome ?? null,
        outcomeLabel: outcomeText[managerResult?.outcome] ?? "hasil tidak diketahui",
        detail: managerResult?.detail ?? "",
        lifecycleState: managerResult?.lifecycleState ?? null
    };
}

/**
 * The built-in adapter definitions (inert; wired through the trusted
 * composition only). Each adapter is channel-specific ONLY in transport
 * decoding/presentation — the semantic classification is shared.
 */
const CHANNEL_ADAPTERS = Object.freeze([
    {
        channelType: CHANNEL_TYPES.CONSOLE,
        normalizeInbound: normalizeCommon,
        renderOutbound: renderCommon
    },
    {
        channelType: CHANNEL_TYPES.CLI,
        normalizeInbound: normalizeCommon,
        renderOutbound: renderCommon
    },
    {
        channelType: CHANNEL_TYPES.TELEGRAM,
        normalizeInbound: normalizeCommon,
        renderOutbound: renderCommon
    },
    {
        channelType: CHANNEL_TYPES.WHATSAPP,
        normalizeInbound: normalizeCommon,
        renderOutbound: renderCommon
    },
    {
        channelType: CHANNEL_TYPES.COMPANION,
        normalizeInbound: normalizeCommon,
        renderOutbound: renderCommon
    },
    {
        channelType: CHANNEL_TYPES.VOICE,
        normalizeInbound: normalizeCommon,
        renderOutbound: renderCommon
    }
]);

module.exports = { CHANNEL_ADAPTERS, normalizeCommon, renderCommon };
