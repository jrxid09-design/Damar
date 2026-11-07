"use strict";

/**
 * ACTION AUTHORITY GATE V1 — sixth-targeted-repair regressions (Wave 4 Lane 2):
 * canonical bootstrap ownership — caller-selectable verifier REMOVED.
 *
 * This is the trusted-bootstrap-owned trust-origin suite. It uses the trusted
 * test bootstrap (tests/action/bootstrapHarness.js), which mirrors the
 * production src/action/bootstrap.js composition layer. The runtime factory is
 * no longer a public export, so every composition goes through the trusted
 * harness.
 *
 * Proves:
 *   - VALID SHAPE != TRUSTED ORIGIN
 *   - VALID ORIGIN IN RUNTIME A != TRUSTED IN RUNTIME B
 *   - the public/direct surface exposes no issuer minting, no gate
 *     construction, and no caller-selectable verifier path
 *   - a caller cannot mint a session trusted by ANY canonical runtime except
 *     through the trusted bootstrap's authenticated-mint path
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../../src/action");
const { makeHarness, composeIsolatedTrustDomain, authenticate } = require("./helpers");

const CLOCK = { nowMs: () => 1000 };

async function setupAvailable(h, id = "filesystem.read", ops = ["read"]) {
    const res = await h.registerCapability({ id, operations: ops });
    await h.registry.observeAvailability(id, "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    return res;
}

/** Build a minimal trusted test harness + cap.x capability (mirrors trusted
 *  bootstrap for cross-runtime replay tests). */
async function makeRuntime({ nowMs = () => 1000 } = {}) {
    const h = await makeHarness({
        clock: { nowMs },
        scopeBindings: { "cap.x": { read: (a) => (a && a.target ? [a.target] : []) } }
    });
    const res = await h.registerCapability({ id: "cap.x", operations: ["read"] });
    await h.registry.observeAvailability("cap.x", "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    await h.grantAuthority({ capabilityId: "cap.x", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "cap.x", operation: "read", arguments: { target: "safe.target" } }));
    return { registry: h.registry, registrars: h.registrars, store: h.store, rt: h.rt, authDomain: h.authDomain, intent, h };
}

test("trust-origin: runtime surface is exactly { admit, evaluate } — no identity minting", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    assert.equal(typeof h.rt.issueIdentity, "undefined", "no issueIdentity surface");
    assert.equal(typeof h.rt.mintSession, "undefined", "no mintSession surface");
    assert.equal(typeof h.rt.issueSession, "undefined", "no issueSession surface");
    assert.equal(typeof h.rt.bindAuthentication, "undefined", "no bindAuthentication on runtime surface");
    assert.equal(typeof h.rt.onReady, "undefined", "no onReady on runtime surface");
    assert.equal(typeof h.rt.authVerifier, "undefined", "no authVerifier surface");
    assert.deepEqual(Object.keys(h.rt).sort(), ["admit", "evaluate"].sort());
});

test("trust-origin: public API exposes no composition/verifier factory at all", () => {
    // The factories are no longer public exports (seventh repair). A caller
    // cannot obtain a runtime/domain/gate/verifier constructor at all, and
    // there are no binders / tokens / first-call-wins surfaces anywhere.
    for (const name of ["createActionAuthorityRuntime", "createAuthenticationDomain", "createGate", "createAuthSessionIssuer", "bindCompositionHost", "bindAuthenticationHost", "bindHost", "acquireHost", "registerHost", "installHost", "claimComposition", "bootstrapBind", "hostToken", "getFactory", "getComposer", "bindAuthentication", "mintSession", "onReady", "issueIdentity", "issuer", "sessionIssuer", "authVerifier", "verifier"]) {
        assert.equal(typeof api[name], "undefined", `api.${name} must not exist`);
    }
    // Direct submodule imports expose no factory or binder either (the
    // privileged factories live ONLY inside the trusted bootstrap's private
    // closure; runtime.js/authDomain.js are pure non-privileged modules).
    const runtimeModule = require("../../src/action/runtime");
    const authDomainModule = require("../../src/action/authDomain");
    for (const name of ["createActionAuthorityRuntime", "composeActionAuthorityRuntime", "bindCompositionHost", "isCompositionHostBound"]) {
        assert.equal(typeof runtimeModule[name], "undefined", `runtime.js.${name} must not be exported`);
    }
    for (const name of ["createAuthenticationDomain", "composeAuthenticationDomain", "bindAuthenticationHost", "isAuthenticationHostBound"]) {
        assert.equal(typeof authDomainModule[name], "undefined", `authDomain.js.${name} must not be exported`);
    }
});

test("trust-origin: caller cannot mint a session trusted by any canonical runtime", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    await h.grantAuthority({ subject: "victim", actions: ["read"], identityBinding: { principals: ["victim"] } });
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" } }));

    // The attacker holds NO issuer for this runtime domain: the issuer is
    // owned by the trusted bootstrap closure and never placed on the runtime.
    // Every fake/lookalike session is DENY INVALID_IDENTITY.
    const lookalikes = [
        { principal: "victim", sessionId: "", channel: "" },
        Object.freeze({ principal: "victim", sessionId: "", channel: "" }),
        JSON.parse(JSON.stringify({ principal: "victim", sessionId: "", channel: "" })),
        { principal: "victim", sessionId: "", channel: "", [Symbol("damar.action.authSession.brand")]: true }
    ];
    for (const candidate of lookalikes) {
        const d = await h.evaluate(intent, candidate);
        assert.equal(d.decision, "DENY");
        assert.equal(d.reasonCode, "INVALID_IDENTITY");
    }
    // Only bootstrap-minted (authenticated) sessions are trusted.
    const d = await h.evaluate(intent, h.session("victim"));
    assert.equal(d.decision, "ALLOW");
});

test("trust-origin: cross-runtime session replay A -> B rejected; B -> A rejected", async () => {
    const A = await makeRuntime();
    const B = await makeRuntime();

    const sessionA = A.authDomain.authenticate({ claimedPrincipal: "alice" });
    const sessionB = B.authDomain.authenticate({ claimedPrincipal: "alice" });

    // 1. A session -> A accepted
    assert.equal((await A.rt.evaluate(A.intent, sessionA)).decision, "ALLOW");
    // 2. A session -> B rejected
    const ab = await B.rt.evaluate(B.intent, sessionA);
    assert.equal(ab.decision, "DENY", "runtime A session must be rejected by runtime B");
    assert.equal(ab.reasonCode, "INVALID_IDENTITY");
    // 3. B session -> A rejected
    const ba = await A.rt.evaluate(A.intent, sessionB);
    assert.equal(ba.decision, "DENY", "runtime B session must be rejected by runtime A");
    assert.equal(ba.reasonCode, "INVALID_IDENTITY");
    // 4. B session -> B accepted
    assert.equal((await B.rt.evaluate(B.intent, sessionB)).decision, "ALLOW");
});

test("trust-origin: shared canonical state does NOT federate session trust", async () => {
    // An attacker who shares the SAME canonical registry + authority store
    // (e.g. an in-process holder that reaches the harness's references) still
    // cannot replay a victim session: the trusted test bootstrap's isolated-
    // domain facility composes a NEW AuthenticationDomain with its OWN brand,
    // and the victim's session is not in it. And the attacker's own "victim"
    // session does not work on runtime A.
    const A = await makeRuntime();
    const attacker = composeIsolatedTrustDomain({
        clock: CLOCK,
        capabilityRuntime: { registry: A.registry, registrars: A.registrars },
        authorityStore: A.store,
        trustedScopeBindings: { "cap.x": { read: (a) => (a && a.target ? [a.target] : []) } }
    });

    const victimSession = A.authDomain.authenticate({ claimedPrincipal: "victim" });
    const attackerIntent = attacker.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "cap.x", operation: "read", arguments: { target: "safe.target" } }));

    const d = await attacker.rt.evaluate(attackerIntent, victimSession);
    assert.equal(d.decision, "DENY", "victim session must not be replayable on a new runtime over shared state");
    assert.equal(d.reasonCode, "INVALID_IDENTITY");

    const forged = attacker.authDomain.authenticate({ claimedPrincipal: "victim" });
    const aIntent = A.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "cap.x", operation: "read", arguments: { target: "safe.target" } }));
    const d2 = await A.rt.evaluate(aIntent, forged);
    assert.equal(d2.decision, "DENY", "runtime B session must be rejected by runtime A even over shared canonical state");
    assert.equal(d2.reasonCode, "INVALID_IDENTITY");
});

test("trust-origin: identity from authenticated trusted session works; fake session object fails", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    await h.grantAuthority({ subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" } }));

    // legit branded session from THIS runtime's bootstrap issuer
    const legit = h.session("alice");
    assert.equal((await h.evaluate(intent, legit)).decision, "ALLOW");

    // fake plain-object session (unbranded)
    const fake = { principal: "alice", sessionId: "", channel: "" };
    const d = await h.evaluate(intent, fake);
    assert.equal(d.decision, "DENY");
    assert.equal(d.reasonCode, "INVALID_IDENTITY");
});

test("trust-origin: cloned/frozen/session-shaped objects fail", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    await h.grantAuthority({ subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" } }));

    const legit = h.session("alice");
    const frozenClone = Object.freeze({ ...legit });
    const structural = { principal: "alice", sessionId: "", channel: "" };
    const jsonRound = JSON.parse(JSON.stringify(legit));

    for (const candidate of [frozenClone, structural, jsonRound]) {
        const d = await h.evaluate(intent, candidate);
        assert.equal(d.decision, "DENY", "clone/JSON session must be rejected");
        assert.equal(d.reasonCode, "INVALID_IDENTITY");
    }

    // legit still works
    assert.equal((await h.evaluate(intent, legit)).decision, "ALLOW");
});

test("trust-origin: fake Symbol/token cannot self-issue a session", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" } }));

    const fakeSymbolObj = { principal: "victim", sessionId: "", channel: "", [Symbol("damar.action.authSession.brand")]: true };
    const d = await h.evaluate(intent, fakeSymbolObj);
    assert.equal(d.decision, "DENY", "Symbol-branded lookalike rejected");
    assert.equal(d.reasonCode, "INVALID_IDENTITY");
});

test("trust-origin: evaluator/verifier are sealed (no replacement, no prototype tampering)", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" } }));
    const id = h.session("alice");

    // frozen surface: no reassignment of evaluate.
    assert.ok(Object.isFrozen(h.rt));
    assert.throws(() => { h.rt.evaluate = () => ({ decision: "ALLOW" }); });
    // defineProperty replacement also fails on a frozen object.
    assert.throws(() => Object.defineProperty(h.rt, "evaluate", { value: () => ({ decision: "ALLOW" }) }));

    // No prototype on the runtime surface to tamper with (it is a frozen plain object).
    const d = await h.evaluate(intent, id);
    assert.equal(d.decision, "DENY", "canonical behavior unchanged after tamper attempts");
});

test("trust-origin: scope-binding outer/nested mutation has zero effect", async () => {
    // The CALLER supplies the binding object; the runtime captures resolver
    // FUNCTION IDENTITIES once into a detached closure-owned Map. Mutating
    // the caller-side object (outer map and nested resolver) afterward must
    // have zero effect.
    const bindings = { "x.one": { read: (a) => (a && a.target ? [a.target] : []) } };
    const h = await makeHarness({ scopeBindings: bindings });
    const res = await h.registerCapability({ id: "x.one", operations: ["read"] });
    await h.registry.observeAvailability("x.one", "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });

    // mutate the outer binding object and nested resolver AFTER composition
    bindings["x.one"] = { read: () => ["MALICIOUS.SCOPE"] };
    bindings["x.one"].read = () => ["MALICIOUS.SCOPE"];
    delete bindings["x.one"];

    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "x.one", operation: "read", arguments: { target: "safe.target" } }));
    assert.deepEqual(intent.scope, ["safe.target"], "captured resolver still used; caller mutation has no effect");
});

test("trust-origin: hostile Proxy identity rejection executes zero traps", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" } }));

    let traps = 0;
    const hostile = new Proxy({}, {
        get(o, p) { traps++; return o[p]; },
        getPrototypeOf() { traps++; return Object.prototype; },
        ownKeys() { traps++; return []; },
        getOwnPropertyDescriptor() { traps++; return undefined; },
        has() { traps++; return false; },
        set() { traps++; return false; }
    });
    const d = await h.evaluate(intent, hostile);
    assert.equal(d.decision, "DENY");
    assert.equal(traps, 0, "no Proxy trap may execute during rejection or after");
});

test("trust-origin: fake authorityContext / copied canonical-looking evaluation rejected", async () => {
    const { isCanonicalAuthorityEvaluation } = require("../../src/action");
    const plainEval = {
        allowed: true, reasonCode: "AUTHORIZED",
        snapshot: { generation: 0, capabilityId: "filesystem.read", subject: "alice", principal: "alice", actions: ["read"], scope: ["safe.target"], allowedPurposes: [], identityBinding: null, maxExecutions: null }
    };
    assert.equal(isCanonicalAuthorityEvaluation(plainEval), false, "copied evaluation not canonical");
    assert.equal(isCanonicalAuthorityEvaluation(JSON.parse(JSON.stringify(plainEval))), false, "cloned evaluation not canonical");
});
