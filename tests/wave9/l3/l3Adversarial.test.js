"use strict";

/**
 * W9-L3 Human-Agent Collaboration — adversarial tests (RT-W9-21..30).
 * PM-34: tests written BEFORE implementation — must fail initially.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

const { makeCollabStore } = require("../../../src/collab/store");
const { makeConsentManager } = require("../../../src/collab/consent");
const { makeModeManager } = require("../../../src/collab/mode");
const { makeStopHandler } = require("../../../src/collab/stop");

function makePorts() {
    const acc = createMemoryAccStore();
    const store = makeCollabStore(acc);
    const consent = makeConsentManager(store);
    const mode = makeModeManager(store);
    const stop = makeStopHandler();
    return { store, consent, mode, stop };
}

// RT-W9-21: pre-selected confirm button harvests consent — schema-level rejection
test("RT-W9-21: preselected consent signal rejected at schema level", async () => {
    const { consent } = makePorts();
    await assert.rejects(
        () => consent.mint("delete-files", { affirmative: true, preselected: true }),
        { message: /preselected.*not.*consent|default button.*not.*consent/i }
    );
});

// RT-W9-22: consent token replayed — CONSUMED blocks reuse
test("RT-W9-22: consumed consent token cannot be reused", async () => {
    const { consent } = makePorts();
    const token = await consent.mint("export-data", { affirmative: true, preselected: false });
    await consent.consume(token.id, "export-data");
    await assert.rejects(
        () => consent.consume(token.id, "export-data"),
        { message: /consumed|already used|reuse/i }
    );
});

// RT-W9-23: consent for A used for B — mismatch refused
test("RT-W9-23: consent scoped to purpose A refused for purpose B", async () => {
    const { consent } = makePorts();
    const token = await consent.mint("send-email", { affirmative: true, preselected: false });
    await assert.rejects(
        () => consent.consume(token.id, "delete-files"),
        { message: /scope.*mismatch|wrong purpose/i }
    );
});

// RT-W9-24: consent on unverified channel — no token minted
test("RT-W9-24: consent prompt on unverified channel yields no token", async () => {
    const { consent } = makePorts();
    await assert.rejects(
        () => consent.mint("exec-plan", { affirmative: true, preselected: false, channelVerified: false }),
        { message: /unverified channel|channel.*not.*trusted/i }
    );
});

// RT-W9-25: timeout treated as approval — refusal
test("RT-W9-25: timeout signal treated as refusal, not approval", async () => {
    const { consent } = makePorts();
    await assert.rejects(
        () => consent.mint("exec-plan", { affirmative: false, timeout: true, preselected: false }),
        { message: /timeout.*refusal|not.*affirmative/i }
    );
});

// RT-W9-26: nagging — blocked by cooldown after refusal
test("RT-W9-26: repeated consent requests after refusal blocked by cooldown", async () => {
    const { consent } = makePorts();
    await consent.recordRefusal("exec-plan", "owner-1");
    await assert.rejects(
        () => consent.requestAllowed("exec-plan", "owner-1"),
        { message: /cooldown|too soon|repeated/i }
    );
});

// RT-W9-27: secondary device impersonates owner — no consent minted
test("RT-W9-27: unverified device impersonation yields no consent token", async () => {
    const { consent } = makePorts();
    await assert.rejects(
        () => consent.mint("exec-plan", {
            affirmative: true, preselected: false, channelVerified: true,
            deviceTrust: "unverified"
        }),
        { message: /device.*not.*trusted|impersonat/i }
    );
});

// RT-W9-28: owner absence used to widen scope — scope unchanged
test("RT-W9-28: collaboration scope cannot widen during owner absence", async () => {
    const { mode } = makePorts();
    await mode.setMode("supervised");
    await mode.setOwnerPresent(false);
    await assert.rejects(
        () => mode.setMode("autonomous"),
        { message: /cannot widen.*absent|owner absent/i }
    );
    assert.equal(await mode.getMode(), "supervised");
});

// RT-W9-29: Damar mints its own consent — no internal path
test("RT-W9-29: Damar self-mint consent refused", async () => {
    const { consent } = makePorts();
    await assert.rejects(
        () => consent.selfMint("exec-plan"),
        { message: /self.*mint|damar.*cannot.*consent|internal.*mint/i }
    );
});

// RT-W9-30: stop signal preempts immediately
test("RT-W9-30: stop signal preempts pending work immediately", () => {
    const { stop } = makePorts();
    assert.equal(stop.isSignaled(), false);
    stop.signal();
    assert.equal(stop.isSignaled(), true);
    assert.throws(
        () => stop.check(),
        { message: /stop.*signaled|operation.*halted/i }
    );
});
