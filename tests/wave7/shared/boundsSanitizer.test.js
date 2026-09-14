const test = require("node:test");
const assert = require("node:assert");

/**
 * Wave7 shared prerequisite — src/cognition/core/bounds.js's sanitizeBounds.
 *
 * Independent audit round 57 (Codex, W7R57-P2-1): round 53's per-lane
 * bounds normalization validated that the `bounds` override was an
 * object, but never validated each VALUE inside it -- a caller could
 * override a single MAX_* to Infinity/NaN/negative and disable that
 * cap entirely, even though the merged result was frozen (round 55).
 * sanitizeBounds is the one shared fix, used identically by all 6 lanes.
 */

const { sanitizeBounds } = require("../../../src/cognition/core/bounds");

test("BOUNDS-SANITIZE-1: a finite, non-negative override value is kept as-is", () => {
    const defaults = Object.freeze({ MAX_X: 10, MAX_Y: 20 });
    const out = sanitizeBounds(defaults, { MAX_X: 5 });
    assert.equal(out.MAX_X, 5);
    assert.equal(out.MAX_Y, 20);
});

test("BOUNDS-SANITIZE-2: Infinity/-Infinity/NaN/negative overrides fall back to the default value for that key", () => {
    const defaults = Object.freeze({ MAX_X: 10 });
    assert.equal(sanitizeBounds(defaults, { MAX_X: Infinity }).MAX_X, 10);
    assert.equal(sanitizeBounds(defaults, { MAX_X: -Infinity }).MAX_X, 10);
    assert.equal(sanitizeBounds(defaults, { MAX_X: NaN }).MAX_X, 10);
    assert.equal(sanitizeBounds(defaults, { MAX_X: -1 }).MAX_X, 10);
});

test("BOUNDS-SANITIZE-3: a non-number override (string/object/Symbol) falls back to the default value for that key", () => {
    const defaults = Object.freeze({ MAX_X: 10 });
    assert.equal(sanitizeBounds(defaults, { MAX_X: "100" }).MAX_X, 10);
    assert.equal(sanitizeBounds(defaults, { MAX_X: {} }).MAX_X, 10);
    assert.equal(sanitizeBounds(defaults, { MAX_X: Symbol("x") }).MAX_X, 10);
});

test("BOUNDS-SANITIZE-4: fractional values are allowed (attention's DECAY_PER_MS / metacog's NO_EVIDENCE_CEILING are legitimately non-integer)", () => {
    const defaults = Object.freeze({ DECAY_PER_MS: 0.0005 });
    assert.equal(sanitizeBounds(defaults, { DECAY_PER_MS: 0.001 }).DECAY_PER_MS, 0.001);
});

test("BOUNDS-SANITIZE-5: a zero override is allowed (a caller may legitimately disable a limit down to zero)", () => {
    const defaults = Object.freeze({ MAX_X: 10 });
    assert.equal(sanitizeBounds(defaults, { MAX_X: 0 }).MAX_X, 0);
});

test("BOUNDS-SANITIZE-6: never raw-throws on a revoked-Proxy override, falling back to the frozen defaults", () => {
    const defaults = Object.freeze({ MAX_X: 10 });
    const r = Proxy.revocable({}, {});
    r.revoke();
    let out;
    assert.doesNotThrow(() => { out = sanitizeBounds(defaults, r.proxy); });
    assert.equal(out.MAX_X, 10);
});

test("BOUNDS-SANITIZE-7: the result is frozen", () => {
    const defaults = Object.freeze({ MAX_X: 10 });
    const out = sanitizeBounds(defaults, { MAX_X: 5 });
    assert.ok(Object.isFrozen(out));
});

test("W7-shared: all 6 lanes reject a non-finite MAX_* bounds override at construction (independent audit round 57, Codex, W7R57-P2-1)", async () => {
    const { createSelfModel } = require("../../../src/cognition/selfmodel");
    const { BOUNDS: SM_BOUNDS } = require("../../../src/cognition/selfmodel/bounds");
    const { createWorldModel } = require("../../../src/cognition/worldmodel");
    const { BOUNDS: WM_BOUNDS } = require("../../../src/cognition/worldmodel/bounds");
    const { createGoalEngine } = require("../../../src/cognition/goals");
    const { BOUNDS: GL_BOUNDS } = require("../../../src/cognition/goals/bounds");
    const { createProspectiveMemory } = require("../../../src/cognition/prospective");
    const { BOUNDS: PM_BOUNDS } = require("../../../src/cognition/prospective/bounds");
    const { createAttentionEconomy } = require("../../../src/cognition/attention");
    const { BOUNDS: AT_BOUNDS } = require("../../../src/cognition/attention/bounds");
    const { createMetacognition } = require("../../../src/cognition/metacog");
    const { BOUNDS: MC_BOUNDS } = require("../../../src/cognition/metacog/bounds");

    const registry = { get: () => ({ id: "x" }), has: () => true, getAvailability: () => null };

    const sm = await createSelfModel({ capabilityRegistry: registry, bounds: { MAX_ACTIVE_PROVIDERS: Infinity } });
    assert.equal(sm.bounds.MAX_ACTIVE_PROVIDERS, SM_BOUNDS.MAX_ACTIVE_PROVIDERS);

    const wm = await createWorldModel({ bounds: { MAX_ENTITIES: Infinity } });
    assert.equal(wm.bounds.MAX_ENTITIES, WM_BOUNDS.MAX_ENTITIES);

    const ge = await createGoalEngine({ bounds: { MAX_ACTIVE_GOALS: -1 } });
    assert.equal(ge.bounds.MAX_ACTIVE_GOALS, GL_BOUNDS.MAX_ACTIVE_GOALS);

    const pm = await createProspectiveMemory({ bounds: { MAX_ARMED_REMINDERS: NaN } });
    assert.equal(pm.bounds.MAX_ARMED_REMINDERS, PM_BOUNDS.MAX_ARMED_REMINDERS);

    const at = await createAttentionEconomy({ bounds: { MAX_QUEUED_TARGETS: Infinity } });
    assert.equal(at.bounds.MAX_QUEUED_TARGETS, AT_BOUNDS.MAX_QUEUED_TARGETS);

    const mc = await createMetacognition({ bounds: { MAX_OPEN_REVIEWS: Infinity } });
    assert.equal(mc.bounds.MAX_OPEN_REVIEWS, MC_BOUNDS.MAX_OPEN_REVIEWS);
});
