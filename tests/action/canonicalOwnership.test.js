"use strict";

/**
 * ACTION AUTHORITY GATE V1 — SEVENTH targeted repair regressions (Wave 4
 * Lane 2): first-binder trust + caller authenticator + seeding on the
 * production facade REMOVED.
 *
 * This file loads the PRODUCTION trusted bootstrap (src/action/bootstrap.js)
 * and exercises ONLY its surface. It is the test analogue of canonicalBootstrap
 * (sixth repair) but adapted to the seventh repair's stricter architecture:
 *
 *   - no binders / tokens / first-call-wins surfaces anywhere
 *   - no caller-selectable authenticator on the production facade
 *   - production facade is exactly least-privilege (no seeding)
 *
 * Proves:
 *   R7-1   no first-binder exploit: no bindCompositionHost / bindAuthenticationHost
 *          or any equivalent exported anywhere
 *   R7-2   fresh-process attacker cannot acquire privileged construction by
 *          importing modules before bootstrap loads
 *   R7-3   canonical-first then attacker imports modules: still no privileged
 *          constructor acquired
 *   R7-4   production createCanonicalActionFacade accepts NO options (in
 *          particular no caller-selectable authenticator)
 *   R7-5   caller-authenticator attempts (authenticate/authenticator/authVerifier/
 *          verifyCredentials/resolvePrincipal) all rejected as
 *          CALLER_BOOTSTRAP_REJECTED
 *   R7-6   production facade is EXACTLY { admit, evaluate, authenticate, session }
 *   R7-7   production facade exposes no seeding/mutation/privileged surface
 *          (grantAuthority/registerCapability/registry/registrars/store/...)
 *   R7-8   with the fixed fail-closed canonical auth adapter, the production
 *          facade can NEVER mint a caller-asserted victim; attacker sessions
 *          are always rejected by evaluate()
 *   R7-9   evaluator/verifier replacement impossible on the canonical runtime
 *   R7-10  structural scans: no binder-equivalent exported anywhere; bootstrap
 *          is the only composition layer; dependency direction preserved
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const api = require("../../src/action");
const bootstrap = require("../../src/action/bootstrap");
const { createCanonicalActionFacade, PRIVILEGED_KEYS } = bootstrap;

// ---------------------------------------------------------------------------
// R7-1 + R7-2 + R7-3. No first-binder exploit; no privileged construction
// ---------------------------------------------------------------------------

const FORBIDDEN_BINDER_NAMES = [
    "bindCompositionHost", "bindAuthenticationHost",
    "bindHost", "acquireHost", "registerHost", "installHost",
    "claimComposition", "bootstrapBind", "hostToken",
    "getFactory", "getComposer",
    "createActionAuthorityRuntime", "createAuthenticationDomain",
    "composeActionAuthorityRuntime", "composeAuthenticationDomain"
];

test("R7-1: no action module exports any privileged composition/binder surface", () => {
    const dir = path.join(__dirname, "../../src/action");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.ok(files.length > 0);
    for (const f of files) {
        const mod = require(path.join(dir, f));
        for (const name of FORBIDDEN_BINDER_NAMES) {
            assert.equal(typeof mod[name], "undefined", `${f} must not export ${name}`);
        }
    }
    // Public API exports neither factory nor binder.
    for (const name of FORBIDDEN_BINDER_NAMES) {
        assert.equal(typeof api[name], "undefined", `api.${name} must be undefined`);
    }
});

test("R7-2: fresh-process attacker importing runtime.js/authDomain.js before bootstrap acquires NO privileged construction", () => {
    // Fresh child process: load runtime.js + authDomain.js FIRST, then probe
    // every export for binders/factories. This is the exact Codex repro shape.
    const probe = `
        const r = require(${JSON.stringify(path.resolve(__dirname, "../../src/action/runtime"))});
        const a = require(${JSON.stringify(path.resolve(__dirname, "../../src/action/authDomain"))});
        const found = [];
        for (const name of ${JSON.stringify(FORBIDDEN_BINDER_NAMES)}) {
            if (typeof r[name] !== "undefined") found.push("runtime." + name + ":" + typeof r[name]);
            if (typeof a[name] !== "undefined") found.push("authDomain." + name + ":" + typeof a[name]);
        }
        // Now try to load bootstrap AFTER the attacker binds hosts (there is
        // no binder to call, so this should just produce the canonical facade).
        const bs = require(${JSON.stringify(path.resolve(__dirname, "../../src/action/bootstrap"))});
        const facade = bs.createCanonicalActionFacade();
        console.log(JSON.stringify({
            found,
            facadeKeys: Object.keys(facade).sort(),
            canMintFromCaller: typeof facade.grantAuthority !== "undefined" || typeof facade.registerCapability !== "undefined"
        }));
    `;
    const out = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    const r = JSON.parse(out);
    assert.deepEqual(r.found, [], "attacker must acquire NO privileged construction");
    assert.deepEqual(r.facadeKeys, ["admit", "authenticate", "evaluate", "session"]);
    assert.equal(r.canMintFromCaller, false, "no seeding surface exposed");
});

test("R7-3: canonical-first then attacker imports modules: still no privileged constructor", () => {
    // Fresh child process: load bootstrap FIRST (production order), then probe
    // every module export for binders/factories.
    const probe = `
        const bs = require(${JSON.stringify(path.resolve(__dirname, "../../src/action/bootstrap"))});
        const facade = bs.createCanonicalActionFacade();
        const r = require(${JSON.stringify(path.resolve(__dirname, "../../src/action/runtime"))});
        const a = require(${JSON.stringify(path.resolve(__dirname, "../../src/action/authDomain"))});
        const found = [];
        for (const name of ${JSON.stringify(FORBIDDEN_BINDER_NAMES)}) {
            if (typeof r[name] !== "undefined") found.push("runtime." + name);
            if (typeof a[name] !== "undefined") found.push("authDomain." + name);
        }
        // Even after bootstrap loaded, the attacker cannot acquire the factory.
        console.log(JSON.stringify({ found, facadeKeys: Object.keys(facade).sort() }));
    `;
    const out = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    const r = JSON.parse(out);
    assert.deepEqual(r.found, [], "no privileged constructor acquired after canonical load");
    assert.deepEqual(r.facadeKeys, ["admit", "authenticate", "evaluate", "session"]);
});

test("R7-2/3: attacker-imports-every-module-before-bootstrap acquires NOTHING", () => {
    // Fresh child process: import EVERY src/action/*.js module before bootstrap,
    // then verify no privileged construction was acquired and bootstrap still
    // initializes correctly.
    const probe = `
        const fs = require("node:fs");
        const path = require("node:path");
        const dir = ${JSON.stringify(path.resolve(__dirname, "../../src/action"))};
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "bootstrap.js");
        const found = [];
        for (const f of files) {
            const mod = require(path.join(dir, f));
            for (const name of ${JSON.stringify(FORBIDDEN_BINDER_NAMES)}) {
                if (typeof mod[name] !== "undefined") found.push(f + ":" + name);
            }
        }
        const bs = require(path.join(dir, "bootstrap.js"));
        const facade = bs.createCanonicalActionFacade();
        console.log(JSON.stringify({ found, facadeKeys: Object.keys(facade).sort() }));
    `;
    const out = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    const r = JSON.parse(out);
    assert.deepEqual(r.found, [], "no privileged construction acquired by pre-importing all modules");
    assert.deepEqual(r.facadeKeys, ["admit", "authenticate", "evaluate", "session"]);
});

// ---------------------------------------------------------------------------
// R7-4 + R7-5. Production facade accepts NO options; no caller-selectable auth
// ---------------------------------------------------------------------------

test("R7-4: createCanonicalActionFacade accepts NO options", () => {
    // Any option (privileged or not) is rejected.
    for (const opt of [{}, { clock: { nowMs: () => 1 } }, { authenticate: () => null }, { anything: 1 }]) {
        assert.throws(
            () => createCanonicalActionFacade(opt),
            (e) => e.reasonCode === "CALLER_BOOTSTRAP_REJECTED",
            `createCanonicalActionFacade must reject any option`
        );
    }
    // No-arg form is the ONLY valid call.
    const facade = createCanonicalActionFacade();
    assert.deepEqual(Object.keys(facade).sort(), ["admit", "authenticate", "evaluate", "session"]);
});

test("R7-5: caller-authenticator attempts (authenticate/authenticator/authVerifier/verifyCredentials/resolvePrincipal) are CALLER_BOOTSTRAP_REJECTED", () => {
    const fakeAuth = () => ({ principal: "attacker" });
    const fakeVerifier = { verify: () => "attacker" };
    const attemptKeys = [
        ["authenticate", fakeAuth],
        ["authenticator", fakeAuth],
        ["authenticationProvider", fakeAuth],
        ["verifyCredentials", fakeAuth],
        ["resolvePrincipal", fakeAuth],
        ["authVerifier", fakeVerifier],
        ["verifier", fakeVerifier]
    ];
    for (const [key, value] of attemptKeys) {
        assert.throws(
            () => createCanonicalActionFacade({ [key]: value }),
            (e) => e.reasonCode === "CALLER_BOOTSTRAP_REJECTED",
            `createCanonicalActionFacade must reject caller-selectable identity option '${key}'`
        );
    }
    // And EVERY key in the bootstrap's published PRIVILEGED_KEYS list.
    assert.ok(Array.isArray(PRIVILEGED_KEYS) && PRIVILEGED_KEYS.length >= 30);
    for (const key of PRIVILEGED_KEYS) {
        assert.throws(
            () => createCanonicalActionFacade({ [key]: {}}),
            (e) => e.reasonCode === "CALLER_BOOTSTRAP_REJECTED",
            `createCanonicalActionFacade must reject PRIVILEGED_KEYS entry '${key}'`
        );
    }
});

// ---------------------------------------------------------------------------
// R7-6 + R7-7. Production facade is exactly least-privilege; no seeding
// ---------------------------------------------------------------------------

test("R7-6: production facade is EXACTLY { admit, evaluate, authenticate, session }", () => {
    const facade = createCanonicalActionFacade();
    assert.deepEqual(Object.keys(facade).sort(), ["admit", "authenticate", "evaluate", "session"]);
    assert.ok(Object.isFrozen(facade));
});

test("R7-7: production facade exposes no seeding/mutation/privileged surface", () => {
    const facade = createCanonicalActionFacade();
    const FORBIDDEN = [
        "grantAuthority", "revokeAuthority", "seedAuthority",
        "registerCapability", "unregisterCapability",
        "registry", "registrars", "store", "authorityStore", "capabilityRuntime",
        "registrar", "seed", "bootstrap",
        "verifier", "evaluator", "authDomain", "AuthenticationDomain",
        "mint", "mintSession", "issue", "issueIdentity"
    ];
    for (const name of FORBIDDEN) {
        assert.equal(typeof facade[name], "undefined", `facade.${name} must be undefined`);
    }
    // Optional-chaining attempt must be impossible (no such method exists).
    assert.equal(typeof facade.grantAuthority, "undefined");
    assert.equal(typeof facade.registerCapability, "undefined");
    // Calling the undefined methods throws TypeError (not silently no-op).
    assert.throws(() => facade.grantAuthority({}), TypeError);
    assert.throws(() => facade.registerCapability({}), TypeError);
});

// ---------------------------------------------------------------------------
// R7-8. Fixed fail-closed canonical auth adapter: attacker can never mint
// ---------------------------------------------------------------------------

test("R7-8: production canonical authenticate() always fails closed; caller cannot mint victim", async () => {
    const facade = createCanonicalActionFacade();
    // With the fixed fail-closed adapter, authenticate() returns null for ANY
    // caller input — no caller-asserted principal is ever trusted.
    for (const evidence of [
        { claimedPrincipal: "victim" },
        { principal: "victim" },
        { claimedPrincipal: "victim", principal: "victim", requestedPrincipal: "victim" },
        { claimedPrincipal: "owner" },
        null, undefined, {}, "victim", 42
    ]) {
        assert.equal(facade.authenticate(evidence), null, `authenticate(${JSON.stringify(evidence)}) must fail closed`);
    }
    // And session() (which wraps authenticate) must throw on the fail-closed path.
    assert.throws(() => facade.session("victim"), (e) => e.reasonCode === "AUTH_FAILED");
    // Without any canonical capability registered, admit() also fails closed.
    assert.throws(() => facade.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "cap.x", operation: "read", arguments: { target: "safe.target" } })),
        (e) => e.reasonCode === "CAPABILITY_NOT_FOUND");
    // And evaluate() with a forged/caller session is INVALID_IDENTITY fail-closed.
    const d = await facade.evaluate(
        { intentId: "x", capabilityId: "cap.x", operation: "read", capabilityIncarnationId: "inc-" + "0".repeat(32) },
        { principal: "victim", claimedPrincipal: "victim" }
    );
    assert.equal(d.decision, "DENY");
    assert.equal(d.reasonCode, "INVALID_IDENTITY");
});

// ---------------------------------------------------------------------------
// R7-9. Evaluator/verifier replacement impossible
// ---------------------------------------------------------------------------

test("R7-9: evaluator/verifier replacement impossible on canonical facade", () => {
    const facade = createCanonicalActionFacade();
    // frozen surface: no reassignment
    assert.throws(() => { facade.evaluate = () => ({ decision: "ALLOW" }); });
    assert.throws(() => Object.defineProperty(facade, "evaluate", { value: () => ({ decision: "ALLOW" }) }));
    // The facade returned is the SAME singleton across calls (impossible to
    // re-compose with different state).
    assert.equal(createCanonicalActionFacade(), facade, "canonical facade is a singleton");
});

// ---------------------------------------------------------------------------
// R7-10. Structural scans
// ---------------------------------------------------------------------------

test("R7-10: no binder-equivalent name exported by ANY action module", () => {
    const dir = path.join(__dirname, "../../src/action");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    for (const f of files) {
        const mod = require(path.join(dir, f));
        for (const name of FORBIDDEN_BINDER_NAMES) {
            assert.equal(typeof mod[name], "undefined", `${f} must not export ${name}`);
        }
    }
});

test("R7-10: bootstrap.js is the only module referencing private composition (and only as its own private closure)", () => {
    const dir = path.join(__dirname, "../../src/action");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    // No action module export may be a function returning a runtime-like surface.
    for (const f of files) {
        const mod = require(path.join(dir, f));
        for (const [name, value] of Object.entries(mod)) {
            if (typeof value !== "function") continue;
            if (name === "createCanonicalActionFacade") continue; // bootstrap's own entry
            let produced = null;
            try { produced = value({}); } catch { /* rejection fine */ }
            if (produced && typeof produced === "object" && typeof produced.then !== "function") {
                const keys = Object.keys(produced).sort();
                assert.ok(!(keys.includes("admit") && keys.includes("evaluate")),
                    `${f}:${name}() must not produce a runtime-like { admit, evaluate } surface`);
            }
        }
    }
});

test("R7-10: dependency direction — bootstrap imports action internals, not vice versa", () => {
    const dir = path.join(__dirname, "../../src/action");
    const bootstrapText = fs.readFileSync(path.join(dir, "bootstrap.js"), "utf8");
    assert.ok(/require\("\.\.\/capability\/registry"\)/.test(bootstrapText), "bootstrap must import capability registry");
    assert.ok(/require\("\.\.\/authority\/store"\)/.test(bootstrapText), "bootstrap must import authority store");
    // Internals must NOT import bootstrap.
    for (const f of ["index.js", "runtime.js", "authDomain.js", "gate.js", "intent.js", "errors.js", "clock.js", "authSession.js"]) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        assert.ok(!/require\([^)]*bootstrap/.test(code), `${f} must not import the trusted bootstrap (dependency direction)`);
    }
});
