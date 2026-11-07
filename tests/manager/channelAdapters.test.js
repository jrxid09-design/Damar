"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL_ADAPTERS } = require("../../src/manager/channels");
const { CHANNEL_TYPES } = require("../../src/manager/schema");

test("built-in channel adapters normalize and render only", () => {
    assert.equal(Object.isFrozen(CHANNEL_ADAPTERS), true);
    assert.deepEqual(CHANNEL_ADAPTERS.map(a => a.channelType).sort(), [
        CHANNEL_TYPES.CLI, CHANNEL_TYPES.COMPANION, CHANNEL_TYPES.CONSOLE,
        CHANNEL_TYPES.TELEGRAM, CHANNEL_TYPES.VOICE, CHANNEL_TYPES.WHATSAPP
    ].sort());
    for (const adapter of CHANNEL_ADAPTERS) {
        const normalized = adapter.normalizeInbound({
            channelType: adapter.channelType, channelId: "c", peer: "p",
            sessionId: "s", payload: { text: "hello", data: { value: 1 } },
            metadata: { claimedPrincipal: "attacker" }
        });
        assert.equal(normalized.channelType, adapter.channelType);
        assert.equal(normalized.payload.text, "hello");
        const rendered = adapter.renderOutbound({
            managerRequestId: "r", outcome: "AUTHORITY_DENIED",
            detail: "denied", lifecycleState: "FAILED"
        });
        assert.equal(rendered.outcome, "AUTHORITY_DENIED");
        for (const key of ["authorize", "evaluate", "execute", "verify", "compensate", "grantAuthority"]) {
            assert.equal(Object.prototype.hasOwnProperty.call(adapter, key), false, key);
        }
    }
});

test("channel adapter outputs cannot mint Manager provenance", () => {
    const adapter = CHANNEL_ADAPTERS[0];
    const out = adapter.normalizeInbound({
        channelType: adapter.channelType, channelId: "c", sessionId: "s",
        payload: { principal: "attacker", authority: { decision: "ALLOW" } },
        metadata: { execute: () => true }
    });
    assert.equal(out.authority, undefined);
    assert.equal(out.session, undefined);
    assert.equal(out.request, undefined);
    assert.equal(out.decision, undefined);
});
