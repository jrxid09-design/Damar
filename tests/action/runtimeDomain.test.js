"use strict";

/**
 * ACTION AUTHORITY GATE V1 — sixth-targeted-repair regressions (Wave 4 Lane 2):
 * canonical bootstrap ownership — caller-selectable verifier REMOVED.
 *
 * Trust-domain tests using the trusted test bootstrap. Every composition goes
 * through tests/action/bootstrapHarness.js (mirroring src/action/bootstrap.js):
 * canonical state + the identity verifier are owned by the trusted closure.
 *
 * Direct tests for every Codex repro:
 *   BLOCKER 1 — composition factories are NOT public exports; NO caller can
 *               obtain a runtime/gate/verifier constructor
 *   BLOCKER 2 — there is no importable gate constructor; forged evaluator
 *               injection over the canonical registry impossible (the runtime
 *               factory is bootstrap-internal; injected options are ignored)
 *   BLOCKER 3 — session brand is runtime-local; cross-runtime replay rejected
 *               in BOTH directions without runtimeId strings
 *
 * Plus structural export scans of every action module.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const api = require("../../src/action");
const { makeHarness, composeIsolatedTrustDomain, authenticate } = require("./helpers");

const CLOCK = { nowMs: () => 1000 };

async function makeDomain() {
    const h = await makeHarness({
        clock: CLOCK,
        scopeBindings: { "cap.x": { read: (a) => (a && a.target ? [a.target] : []) } }
    });
    const res = await h.registerCapability({ id: "cap.x", operations: ["read"] });
    await h.registry.observeAvailability("cap.x", "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    await h.grantAuthority({ capabilityId: "cap.x", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    const intent = h.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "cap.x", operation: "read", arguments: { target: "safe.target" } }));
    return { registry: h.registry, registrars: h.registrars, store: h.store, rt: h.rt, authDomain: h.authDomain, intent, h };
}

// ---------------------------------------------------------------------------
// BLOCKER 1 — composition factories are NOT public exports
// ---------------------------------------------------------------------------

test("B1-R6: public API exposes no composition factories", () => {
    for (const name of ["createActionAuthorityRuntime", "createAuthenticationDomain", "createGate", "createAuthSessionIssuer"]) {
        assert.equal(typeof api[name], "undefined", `api.${name} must not exist`);
    }
});

test("B1-R6: direct require of every action submodule exposes no runtime/domain/gate factory", () => {
    // bootstrap.js is the trusted composition layer; requiring it here would
    // re-bind the already-bound hosts (one-shot law). Its own surface is
    // audited exhaustively in canonicalBootstrap.test.js, which loads the
    // production bootstrap in ITS own process. Here we scan every other
    // submodule (including the internals runtime.js and authDomain.js).
    const modules = [
        "../../src/action/index.js",
        "../../src/action/authSession.js",
        "../../src/action/authDomain.js",
        "../../src/action/gate.js",
        "../../src/action/runtime.js",
        "../../src/action/intent.js",
        "../../src/action/errors.js",
        "../../src/action/clock.js"
    ];
    const FORBIDDEN = ["createActionAuthorityRuntime", "createAuthenticationDomain", "createAuthSessionIssuer", "mintAuthSession", "issueIdentity", "issueSession", "mintSession", "bindAuthentication", "onReady"];
    for (const m of modules) {
        const mod = require(m);
        for (const name of FORBIDDEN) {
            assert.equal(typeof mod[name], "undefined", `${m} must not export ${name}`);
        }
    }
});

test("B1-R6: no public callable can produce a session trusted by a canonical runtime", async () => {
    const h = await makeDomain();
    // Every callable export is probed with victim-shaped payloads. Whatever
    // comes back must NOT satisfy the canonical runtime's verifier.
    for (const [name, value] of Object.entries(api)) {
        if (typeof value !== "function") continue;
        let minted = null;
        try {
            minted = await value({ principal: "victim" }, { principal: "victim" });
        } catch { /* typed rejection is fine */ }
        if (minted && typeof minted === "object" && typeof minted.then !== "function") {
            const d = await h.rt.evaluate(h.intent, minted);
            assert.notEqual(d.decision, "ALLOW",
                `public export '${name}' must not be able to produce a trusted session`);
        }
    }
});

test("B1-R6: runtime surface exposes no mint/issuer/bind/bootstrap function", async () => {
    const h = await makeDomain();
    for (const forbidden of ["mintSession", "issueIdentity", "issueSession", "bindAuthentication", "onReady", "issuer", "sessionIssuer", "authVerifier", "verifier", "authDomain", "gate", "createGate"]) {
        assert.equal(typeof h.rt[forbidden], "undefined", `rt.${forbidden} must not exist`);
    }
    assert.deepEqual(Object.keys(h.rt).sort(), ["admit", "evaluate"]);
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — no importable gate; forged-evaluator injection impossible
// ---------------------------------------------------------------------------

test("B2-R6: require('src/action/gate').createGate === undefined", () => {
    const gate = require("../../src/action/gate");
    assert.equal(gate.createGate, undefined, "createGate must not exist on gate module");
    assert.equal(typeof gate.createGate, "undefined");
});

test("B2-R6: no action module exports any gate-minting function", () => {
    const dir = path.join(__dirname, "../../src/action");
    // Skip bootstrap.js: it is the trusted composition layer, its host bind is
    // one-shot per process, and this process's bind belongs to the trusted
    // test bootstrap (helpers). bootstrap.js's own surface is audited
    // exhaustively in canonicalBootstrap.test.js.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "bootstrap.js");
    for (const f of files) {
        const mod = require(path.join(dir, f));
        for (const key of Object.keys(mod)) {
            assert.ok(!/^createGate$|^buildGate$|^makeGate$|^newGate$/i.test(key),
                `${f} must not export gate minting function '${key}'`);
        }
    }
});

test("B2-R6: forged evaluator over canonical registry cannot be injected anywhere", async () => {
    const h = await makeDomain();
    const forgedEvaluation = {
        allowed: true,
        reasonCode: "AUTHORIZED",
        snapshot: {
            generation: 0, capabilityId: "cap.x", subject: "alice", principal: "alice",
            actions: ["read"], scope: ["safe.target"], allowedPurposes: [],
            identityBinding: null, maxExecutions: null
        }
    };

    // The historical exploit path is gone: there is no importable runtime
    // constructor that accepts an authorityEvaluator/isCanonicalEvaluation/
    // verifySession/gate option at all. The trusted test bootstrap's
    // isolated-domain facility composes over ITS OWN domain; the injected
    // evaluator options are never read for trust — only the pre-bound
    // verifier's brand acceptance decides identity.
    const attacker = composeIsolatedTrustDomain({
        clock: CLOCK,
        capabilityRuntime: { registry: h.registry, registrars: h.registrars },
        authorityStore: h.store,
        trustedScopeBindings: { "cap.x": { read: (a) => (a && a.target ? [a.target] : []) } }
        // The runtime factory is bootstrap-internal; there is no option to
        // pass `authorityEvaluator`, `isCanonicalEvaluation`, `verifySession`,
        // `evaluator`, or `gate` — they would be rejected as privileged
        // composition options if attempted via the bootstrap.
    });
    const attackerIntent = attacker.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "cap.x", operation: "read", arguments: { target: "safe.target" } }));

    // The forged evaluation object passed as a session is rejected as
    // identity (not in the attacker domain's brand), and there were no
    // evaluator hooks to inject.
    const d = await attacker.rt.evaluate(attackerIntent, forgedEvaluation);
    assert.equal(d.decision, "DENY", "forged evaluation cannot be injected or trusted");
    assert.equal(d.reasonCode, "INVALID_IDENTITY");

    // And a session minted by runtime h cannot be replayed on the attacker
    // runtime either (different brand).
    const legitSession = h.authDomain.authenticate({ claimedPrincipal: "alice" });
    const d2 = await attacker.rt.evaluate(attackerIntent, legitSession);
    assert.equal(d2.decision, "DENY", "cross-runtime replay must fail");
    assert.equal(d2.reasonCode, "INVALID_IDENTITY");
});

// ---------------------------------------------------------------------------
// BLOCKER 3 — runtime-local session brand; cross-runtime replay
// ---------------------------------------------------------------------------

test("B3-R6: A session -> A accepted", async () => {
    const A = await makeDomain();
    const s = A.authDomain.authenticate({ claimedPrincipal: "alice" });
    assert.equal((await A.rt.evaluate(A.intent, s)).decision, "ALLOW");
});

test("B3-R6: A session -> B rejected; B session -> A rejected (both directions)", async () => {
    const A = await makeDomain();
    const B = await makeDomain();
    const sa = A.authDomain.authenticate({ claimedPrincipal: "alice" });
    const sb = B.authDomain.authenticate({ claimedPrincipal: "alice" });

    const ab = await B.rt.evaluate(B.intent, sa);
    assert.equal(ab.decision, "DENY");
    assert.equal(ab.reasonCode, "INVALID_IDENTITY");

    const ba = await A.rt.evaluate(A.intent, sb);
    assert.equal(ba.decision, "DENY");
    assert.equal(ba.reasonCode, "INVALID_IDENTITY");
});

test("B3-R6: forged/cloned/JSON session rejected by canonical runtime", async () => {
    const A = await makeDomain();
    const s = A.authDomain.authenticate({ claimedPrincipal: "alice" });
    const candidates = [
        ["clone", { ...s }],
        ["frozenClone", Object.freeze({ ...s })],
        ["json", JSON.parse(JSON.stringify(s))],
        ["structural", { principal: "alice", sessionId: "", channel: "" }],
        ["symbolLookalike", { principal: "alice", sessionId: "", channel: "", [Symbol("brand")]: 1 }],
        ["nullProto", Object.assign(Object.create(null), { principal: "alice" })]
    ];
    for (const [label, candidate] of candidates) {
        const d = await A.rt.evaluate(A.intent, candidate);
        assert.equal(d.decision, "DENY", `${label} must be rejected`);
        assert.equal(d.reasonCode, "INVALID_IDENTITY", `${label} reason`);
    }
});

test("B3-R6: no runtimeId string trusted — string fields on forged session change nothing", async () => {
    const A = await makeDomain();
    const B = await makeDomain();
    const sb = B.authDomain.authenticate({ claimedPrincipal: "alice" });
    const spoofed = Object.freeze({ ...sb, runtimeId: "A", domain: "A", trusted: true });
    const d = await A.rt.evaluate(A.intent, spoofed);
    assert.equal(d.decision, "DENY");
    assert.equal(d.reasonCode, "INVALID_IDENTITY");
});

// ---------------------------------------------------------------------------
// STRUCTURAL EXPORT SCAN — no privileged surface anywhere in src/action
// ---------------------------------------------------------------------------

test("structural: no module in src/action exports privileged trust constructors", () => {
    const dir = path.join(__dirname, "../../src/action");
    const FORBIDDEN = [
        "createActionAuthorityRuntime",
        "createAuthenticationDomain",
        "createAuthSessionIssuer",
        "createGate",
        "mintAuthSession",
        "issueIdentity",
        "mintRuntimeIdentity",
        "createRuntimeIdentityContext",
        "createIntentAdmission",
        "createReadOnlyAuthorityContext",
        "mintSession",
        "createSessionTrustDomain",
        "createEvaluationBrand",
        "injectEvaluator",
        "setEvaluator",
        "setVerifier",
        "setClock",
        "sessionBrand",
        "authSessionBrands",
        "EVAL_BRAND",
        "brandGate",
        "bindAuthentication",
        "onReady",
        "authBinder"
    ];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "bootstrap.js");
    for (const f of files) {
        const mod = require(path.join(dir, f));
        for (const name of FORBIDDEN) {
            assert.equal(typeof mod[name], "undefined", `${f} must not export ${name}`);
        }
    }
});

test("structural: source scan — no export binding for issuer/gate minting or brand state", () => {
    const dir = path.join(__dirname, "../../src/action");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "bootstrap.js");
    const FORBIDDEN_NAMES = [
        "createActionAuthorityRuntime", "createAuthenticationDomain", "createAuthSessionIssuer",
        "createGate", "mintAuthSession", "mintSession", "issueIdentity", "issueSession",
        "sessionBrand", "authSessionBrands", "EVAL_BRAND", "brandGate", "buildGate",
        "bindAuthentication", "onReady"
    ];
    for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const exportBlocks = [...text.matchAll(/module\.exports\s*=\s*\{([\s\S]*?)\};/g)].map((m) => m[1]);
        exportBlocks.push(...[...text.matchAll(/exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)].map((m) => m[1]));
        if (exportBlocks.length === 0) continue;
        for (const block of exportBlocks) {
            // Strip comments INSIDE the export block: only actual property
            // bindings count, not prose describing what is NOT exported.
            const code = String(block).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
            for (const name of FORBIDDEN_NAMES) {
                assert.ok(!new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(code),
                    `${f}: module export block must not bind '${name}'`);
            }
        }
    }
});
