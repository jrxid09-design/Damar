"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPandawaSessionRegistry } = require("../../src/runtime/interactionBus/pandawaSessions");

/**
 * F-03 tests: session ownership and memory namespace are immutable and
 * owner-authorized. Wrong owner, namespace reassignment, target
 * reassignment, cross-session updates, and authority smuggling all
 * fail closed. Legitimate same-owner bounded updates still work.
 */

function registry(now = () => 1000) {
    return createPandawaSessionRegistry({ now, maxSessions: 16 });
}

test("F-03: update requires the canonical owner", () => {
    const sessions = registry();
    const session = sessions.create({ sessionId: "ses_f03_a", targetEntity: "janaka", ownerUserId: "owner", surface: "console", channel: "console" });

    assert.throws(() => sessions.update(session.sessionId, { state: "WORKING" }, { ownerUserId: "attacker" }), /UPDATE_DENIED/);
    assert.throws(() => sessions.update(session.sessionId, { state: "WORKING" }), /UPDATE_DENIED/);
    assert.throws(() => sessions.update(session.sessionId, { state: "WORKING" }, { ownerUserId: null }), /UPDATE_DENIED/);
    // Wrong-owner context mutation is also denied.
    assert.throws(() => sessions.update(session.sessionId, { contextRefs: ["evil:ref"] }, { ownerUserId: "attacker" }), /UPDATE_DENIED/);
    assert.equal(sessions.get(session.sessionId).state, "IDLE");
    assert.deepEqual(sessions.get(session.sessionId).contextRefs, []);
});

test("F-03: ownerUserId / targetEntity / memoryNamespace / sessionId are immutable through update", () => {
    const sessions = registry();
    const session = sessions.create({ sessionId: "ses_f03_b", targetEntity: "janaka", ownerUserId: "owner", surface: "console", channel: "console" });

    assert.throws(() => sessions.update(session.sessionId, { ownerUserId: "attacker" }, { ownerUserId: "owner" }), /FIELD_IMMUTABLE:ownerUserId/);
    assert.throws(() => sessions.update(session.sessionId, { targetEntity: "pandawa:werkudara" }, { ownerUserId: "owner" }), /FIELD_IMMUTABLE:targetEntity/);
    // Cross-Pandawa namespace reassignment must be impossible.
    assert.throws(() => sessions.update(session.sessionId, { memoryNamespace: "pandawa:werkudara" }, { ownerUserId: "owner" }), /FIELD_IMMUTABLE:memoryNamespace/);
    assert.throws(() => sessions.update(session.sessionId, { memoryNamespace: "pandawa:sadewa" }, { ownerUserId: "owner" }), /FIELD_IMMUTABLE:memoryNamespace/);
    assert.throws(() => sessions.update(session.sessionId, { sessionId: "ses_hijacked" }, { ownerUserId: "owner" }), /FIELD_IMMUTABLE:sessionId/);
    assert.throws(() => sessions.update(session.sessionId, { parentDamarSessionId: "forged-parent" }, { ownerUserId: "owner" }), /FIELD_IMMUTABLE:parentDamarSessionId/);
    assert.throws(() => sessions.update(session.sessionId, { createdAt: 0, generation: 999 }, { ownerUserId: "owner" }), /FIELD_IMMUTABLE/);

    const current = sessions.get(session.sessionId);
    assert.equal(current.ownerUserId, "owner");
    assert.equal(current.targetEntity, "pandawa:janaka");
    assert.equal(current.memoryNamespace, "pandawa:janaka");
    assert.equal(current.sessionId, "ses_f03_b");
});

test("F-03: authority context can never be reintroduced through update or forged at create", () => {
    const sessions = registry();
    const session = sessions.create({ sessionId: "ses_f03_c", targetEntity: "janaka", ownerUserId: "owner", authorityContextRef: "forged" });
    assert.equal(session.authorityContextRef, null);
    const updated = sessions.update(session.sessionId, { state: "THINKING" }, { ownerUserId: "owner" });
    assert.equal(updated.authorityContextRef, null);
});

test("F-03: valid same-owner bounded context update works and stays within the same namespace", () => {
    let now = 1000;
    const sessions = registry(() => now);
    const session = sessions.create({ sessionId: "ses_f03_d", targetEntity: "sadewa", ownerUserId: "owner", contextRefs: ["ctx:1"] });
    now = 2000;
    const updated = sessions.update(session.sessionId, { contextRefs: ["ctx:1", "ctx:2"], state: "WORKING", activeTaskId: "task-9" }, { ownerUserId: "owner" });
    assert.deepEqual(updated.contextRefs, ["ctx:1", "ctx:2"]);
    assert.equal(updated.memoryNamespace, "pandawa:sadewa", "namespace unchanged by bounded update");
    assert.equal(updated.targetEntity, "pandawa:sadewa");
    assert.equal(updated.state, "WORKING");
    assert.equal(updated.generation, session.generation, "update does not fake a resume generation");
    assert.ok(updated.lastActiveAt > session.lastActiveAt);
    // Bounded refs.
    assert.throws(() => sessions.update(session.sessionId, { contextRefs: Array(33).fill("x") }, { ownerUserId: "owner" }), /CONTEXT_REFS_INVALID/);
});

test("F-03: cross-session update is impossible and restart/resume stays generation-aware", () => {
    let now = 1000;
    const sessions = registry(() => now);
    const a = sessions.create({ sessionId: "ses_f03_e", targetEntity: "janaka", ownerUserId: "owner" });
    const b = sessions.create({ sessionId: "ses_f03_f", targetEntity: "werkudara", ownerUserId: "owner" });

    // A update to a nonexistent/foreign session id fails closed; a's update
    // can never touch b's record.
    assert.throws(() => sessions.update("ses_missing", { state: "WORKING" }, { ownerUserId: "owner" }), /NOT_FOUND/);
    const before = sessions.get(b.sessionId);
    sessions.update(a.sessionId, { contextRefs: ["a:ctx"] }, { ownerUserId: "owner" });
    assert.deepEqual(sessions.get(b.sessionId), before, "session b untouched by session a update");

    // Resume remains owner-checked and generation-aware after updates.
    assert.throws(() => sessions.resume(a.sessionId, { ownerUserId: "attacker" }), /RESUME_DENIED/);
    now = 3000;
    const resumed = sessions.resume(a.sessionId, { ownerUserId: "owner" });
    assert.equal(resumed.generation, 2);
    assert.equal(resumed.targetEntity, "pandawa:janaka");
    assert.equal(resumed.memoryNamespace, "pandawa:janaka");
    assert.equal(resumed.authorityContextRef, null, "authority not restored on resume");
    // Resume cannot retarget to another Pandawa.
    assert.throws(() => sessions.resume(a.sessionId, { ownerUserId: "owner", targetEntity: "bima" }), /TARGET_MISMATCH/);
});
