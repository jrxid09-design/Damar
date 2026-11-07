"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { GenerationLedger } = require("../../src/runtime/recovery/generation");
const ids = require("../../src/runtime/recovery/ids");

test("generation: starts with a valid current generation", () => {
    const g = new GenerationLedger();
    assert.match(g.current, /^rtg-[0-9a-f]{32}$/);
    assert.ok(g.isCurrent(g.current));
});

test("generation: advance creates a new generation and preserves history", () => {
    const g = new GenerationLedger();
    const before = g.current;
    const { generationId, previousGenerationId } = g.advance("post-recovery");
    assert.notEqual(generationId, before);
    assert.equal(previousGenerationId, before);
    assert.equal(g.current, generationId);
    assert.equal(g.history.length, 2);
    assert.ok(!g.isCurrent(before), "old generation must no longer be current");
});

test("generation: stale async work from old generation is rejected", () => {
    const g = new GenerationLedger();
    const staleStamp = g.current;
    g.advance("clean-restart");
    assert.throws(() => g.assertCurrent(staleStamp), /stale runtime generation/);
    assert.ok(g.assertCurrent(g.current));
});

test("generation: malformed stamps are simply not current (fail closed, not crash)", () => {
    const g = new GenerationLedger();
    for (const bad of [null, undefined, "../../x", "rtg-ZZZ"]) {
        assert.equal(g.isCurrent(bad), false);
    }
});

test("generation id helpers reject malformed values deterministically", () => {
    assert.throws(() => ids.coerceRuntimeGenerationId("rtg-" + "g".repeat(32)), RangeError);
});
