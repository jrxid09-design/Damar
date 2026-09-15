const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
    MODES, AUTHORITY_SHAPED_KEYS, assertNoAuthorityShapedFields,
    resolveMode, isInfluenceAllowed, validateGovernedCognitiveProjection,
    recordModeTransition
} = require("../../../src/cognition/governed");

test("FG03-1: resolveMode passes through exactly the three sanctioned modes", () => {
    assert.equal(resolveMode("off"), "off");
    assert.equal(resolveMode("shadow"), "shadow");
    assert.equal(resolveMode("governed"), "governed");
});

test("FG03-2: resolveMode fails closed to 'off' for anything unrecognized -- restart/recovery can never resume into a live/permissive mode by accident", () => {
    assert.equal(resolveMode(undefined), "off");
    assert.equal(resolveMode(null), "off");
    assert.equal(resolveMode(""), "off");
    assert.equal(resolveMode("GOVERNED"), "off", "case-sensitive, no coercion");
    assert.equal(resolveMode("live"), "off");
    assert.equal(resolveMode(123), "off");
    assert.equal(resolveMode({ toString: () => "governed" }), "off", "no coercion of a hostile object");
});

test("FG03-3: resolveMode fails closed (not raw-throw) on a revoked Proxy mode value", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.equal(resolveMode(proxy), "off");
});

test("FG03-4: isInfluenceAllowed is true only for governed, per ADR-17 (shadow is decisionInfluence:false ALWAYS, by contract)", () => {
    assert.equal(isInfluenceAllowed("governed"), true);
    assert.equal(isInfluenceAllowed("shadow"), false);
    assert.equal(isInfluenceAllowed("off"), false);
    assert.equal(isInfluenceAllowed("anything-else"), false);
});

test("FG03-5: assertNoAuthorityShapedFields accepts a clean projection at any depth", () => {
    assert.doesNotThrow(() => assertNoAuthorityShapedFields(
        { a: { b: { c: [1, 2, { d: "safe" }] } } }, "test"
    ));
});

test("FG03-6: assertNoAuthorityShapedFields rejects every AUTHORITY_SHAPED_KEYS entry at the top level", () => {
    for (const key of AUTHORITY_SHAPED_KEYS) {
        assert.throws(() => assertNoAuthorityShapedFields({ [key]: "x" }, "test"), new RegExp(key));
    }
});

test("FG03-7: assertNoAuthorityShapedFields rejects an authority-shaped key nested arbitrarily deep -- the original two-level-shallow check this was extracted from would have missed this", () => {
    const deep = { a: { b: { c: { d: { authProof: "forged" } } } } };
    assert.throws(() => assertNoAuthorityShapedFields(deep, "test"), /authProof/);
});

test("FG03-8: assertNoAuthorityShapedFields rejects an authority-shaped key inside an array element", () => {
    assert.throws(() => assertNoAuthorityShapedFields({ list: [{ grant: "x" }] }, "test"), /grant/);
});

test("FG03-9: assertNoAuthorityShapedFields is cycle-safe (WeakSet), never infinite-loops on a self-referencing object", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => assertNoAuthorityShapedFields(cyclic, "test"));
});

test("FG03-10: assertNoAuthorityShapedFields fails closed on a pathologically deep chain instead of stack-overflowing or hanging", () => {
    let deep = { authProof: "buried" };
    for (let i = 0; i < 10_000; i++) deep = { next: deep };
    assert.throws(() => assertNoAuthorityShapedFields(deep, "test"), /terlalu dalam|melebihi batas/);
});

test("FG03-11: validateGovernedCognitiveProjection accepts a well-formed frozen projection", () => {
    const projection = Object.freeze({
        schemaVersion: "governedCognitiveProjection.v1",
        decisionInfluence: "ADVISORY_ONLY",
        selfModel: Object.freeze({ capabilityCount: 0 })
    });
    assert.strictEqual(validateGovernedCognitiveProjection(projection), true);
});

test("FG03-12: validateGovernedCognitiveProjection rejects wrong schemaVersion, wrong decisionInfluence, an unfrozen object, and an authority-shaped field", () => {
    assert.throws(() => validateGovernedCognitiveProjection({ schemaVersion: "x", decisionInfluence: "ADVISORY_ONLY" }), /schemaVersion/);
    assert.throws(() => validateGovernedCognitiveProjection(Object.freeze({ schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "AUTHORITATIVE" })), /decisionInfluence/);
    assert.throws(() => validateGovernedCognitiveProjection({ schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "ADVISORY_ONLY" }), /dibekukan/);
    assert.throws(() => validateGovernedCognitiveProjection(Object.freeze({
        schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "ADVISORY_ONLY", authProof: "forged"
    })), /authProof/);
});

test("FG03-13: validateGovernedCognitiveProjection rejects null/non-object input as a domain error, not a raw TypeError", () => {
    assert.throws(() => validateGovernedCognitiveProjection(null), /wajib objek/);
    assert.throws(() => validateGovernedCognitiveProjection(undefined), /wajib objek/);
    assert.throws(() => validateGovernedCognitiveProjection("x"), /wajib objek/);
});

test("FG03-14: recordModeTransition emits a well-shaped, resolved-mode audit event", () => {
    const events = [];
    const ledger = { append: (e) => events.push(e) };
    const returned = recordModeTransition({ auditLedger: ledger, from: "off", to: "governed", at: 1234 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "cognition.governed.mode_transition");
    assert.equal(events[0].metadata.from, "off");
    assert.equal(events[0].metadata.to, "governed");
    assert.equal(events[0].metadata.at, 1234);
    assert.deepEqual(returned, events[0]);
});

test("FG03-15: recordModeTransition normalizes an unrecognized from/to through resolveMode (never audits a fabricated mode string)", () => {
    const events = [];
    const ledger = { append: (e) => events.push(e) };
    recordModeTransition({ auditLedger: ledger, from: "hostile", to: undefined });
    assert.equal(events[0].metadata.from, "off");
    assert.equal(events[0].metadata.to, "off");
});

test("FG03-16: recordModeTransition never throws when auditLedger is missing, non-callable, throwing, or a revoked Proxy -- audit failure never blocks cognition", () => {
    assert.doesNotThrow(() => recordModeTransition({ from: "off", to: "shadow" }));
    assert.doesNotThrow(() => recordModeTransition({ auditLedger: {}, from: "off", to: "shadow" }));
    assert.doesNotThrow(() => recordModeTransition({
        auditLedger: { append: () => { throw new Error("ledger down"); } }, from: "off", to: "shadow"
    }));
    const { proxy, revoke } = Proxy.revocable({ append: () => {} }, {});
    revoke();
    assert.doesNotThrow(() => recordModeTransition({ auditLedger: proxy, from: "off", to: "shadow" }));
});

test("FG03-17 (FG03_AUTHORITY_LEAKAGE=0): governed/** imports nothing from authority/ or action/bootstrap -- zero path to Authority, zero path to the dispatcher", () => {
    const dir = path.join(__dirname, "../../../src/cognition/governed");
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".js")) continue;
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        assert.doesNotMatch(content, /require\(["'].*\/(authority|action)\//,
            `${file} tidak boleh mengimpor authority/action`);
    }
});

test("FG03-18 (FG03_SECOND_DISPATCHER=0): governed's public API exposes only pure guard/validation/audit functions and frozen constants -- no dispatch, execute, run, invoke, or call surface", () => {
    const governed = require("../../../src/cognition/governed");
    const dispatchShaped = /^(dispatch|execute|invoke|run|call|route|act)/i;
    for (const [key, value] of Object.entries(governed)) {
        if (typeof value === "function") {
            assert.doesNotMatch(key, dispatchShaped, `${key} looks dispatch-shaped, governed must never expose one`);
        }
    }
});

test("FG03-19: MODES is the same frozen array instance longhorizon/bounds.js re-exports (single source of truth, no drift)", () => {
    const { MODES: longhorizonModes } = require("../../../src/cognition/longhorizon/bounds");
    assert.strictEqual(longhorizonModes, MODES);
});

test("FG03-20: every export is frozen or a pure function -- governed holds no mutable state of its own to persist, restart, or leak", () => {
    assert.ok(Object.isFrozen(MODES));
    assert.ok(Object.isFrozen(AUTHORITY_SHAPED_KEYS));
});

test("FG03-21: deep validation rejects proxy-hidden authority fields and contains async audit rejection", async () => {
    const hidden = new Proxy(Object.freeze({ authProof: "forged" }), { ownKeys: () => [] });
    const projection = Object.freeze({ schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "ADVISORY_ONLY", nested: hidden });
    assert.throws(() => validateGovernedCognitiveProjection(projection), /dibekukan|authProof/);
    let unhandled = false;
    const listener = () => { unhandled = true; };
    process.once("unhandledRejection", listener);
    recordModeTransition({ auditLedger: { append: () => Promise.reject(new Error("down")) }, from: "off", to: "governed" });
    await new Promise(resolve => setImmediate(resolve));
    process.removeListener("unhandledRejection", listener);
    assert.equal(unhandled, false);
});

test("FG03-22: validation never trusts inherited or accessor-backed projection fields", () => {
    const inherited = Object.freeze(Object.assign(Object.create({ authProof: "forged" }), {
        schemaVersion: "governedCognitiveProjection.v1",
        decisionInfluence: "ADVISORY_ONLY"
    }));
    assert.throws(() => validateGovernedCognitiveProjection(inherited), /objek data biasa|authProof/);

    let getterCalls = 0;
    const accessor = Object.freeze(Object.defineProperties({}, {
        schemaVersion: { value: "governedCognitiveProjection.v1", enumerable: true },
        decisionInfluence: { value: "ADVISORY_ONLY", enumerable: true },
        nested: { get() { getterCalls += 1; return { authProof: "forged" }; }, enumerable: true }
    }));
    assert.throws(() => validateGovernedCognitiveProjection(accessor), /data property/);
    assert.equal(getterCalls, 0);
});

test("FG03-23: mode transition timestamps are detached scalar data", () => {
    const at = { counter: 1 };
    const event = recordModeTransition({ from: "off", to: "shadow", at });
    assert.equal(event.metadata.at, null);
    assert.equal(Object.isFrozen(event.metadata), true);
});

test("FG03-24: governed foundation is exposed through the canonical cognition entry point", () => {
    const cognition = require("../../../src/cognition");
    assert.equal(cognition.governed.validateGovernedCognitiveProjection, validateGovernedCognitiveProjection);
    assert.equal(cognition.governed.REASONS.INVALID_PROJECTION, "INVALID_PROJECTION");
});
