"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — structural security audit.
 *
 * Proves structurally that the action module imports no shell/process
 * execution, filesystem mutation, network, device/browser actuation, or
 * Authority mutation APIs. It MAY import the canonical evaluator and the
 * capability id grammar (read-only).
 *
 * Also proves the public surface exposes no execution verbs, no authority
 * -minting verbs, and no privileged trust constructors (identity minting,
 * scope resolver injection, generic authorityContext injection, evaluation
 * branding). As of the SIXTH targeted repair there is NO trust issuance
 * surface in the public API at all: canonical composition lives in the
 * trusted bootstrap layer (src/action/bootstrap.js), and the runtime/domain
 * factories are not exported anywhere. This file plays the trusted-bootstrap
 * role in ITS process (binding the one-shot composition hosts via the test
 * harness), so requiring src/action/bootstrap.js here would fail its one-shot
 * law; the bootstrap module's own surface is audited exhaustively in
 * canonicalBootstrap.test.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("structural: action module imports no executors, authority mutators, fs/network/actuation", () => {
    const dir = path.join(__dirname, "../../src/action");
    const files = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (p.endsWith(".js")) files.push(p);
        }
    })(dir);

    const FORBIDDEN = [
        /child_process/, /node:child_process/,
        /node:net\b/, /node:http/, /node:https/, /node:dns/, /node:fetch/,
        /axios|undici|node-pty/,
        /\beval\s*\(/, /new\s+Function\s*\(/,
        /execSync|spawnSync|execFile|spawn\s*\(/,
        /node:fs\b/, /require\(\s*["']fs["']\s*\)/,
        /writeFile|readFile|appendFile|mkdir|rmdir|unlink|chmod|chown/,
        /consumeExecution/, /revokeSubjectGeneration/, /issueRatifiedRootGrant/,
        /bumpGeneration/, /appendEvent/
    ];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        for (const rx of FORBIDDEN) {
            assert.ok(!rx.test(text), `${path.relative(process.cwd(), file)} matches forbidden pattern ${rx}`);
        }
    }

    // allowed external requires: intra-domain, node:crypto, capability ids, and
    // the canonical authority evaluator (read-only). The trusted bootstrap
    // (bootstrap.js) additionally constructs canonical state, so it may also
    // require the capability registry + authority store composition roots.
    // Lane 3 actuation modules may additionally require the capability id
    // grammar (actuatorRegistry.js canonical binding ids).
    // Lane 4 verification modules (verification/) are inert vocabulary modules
    // that may require their sibling action vocabulary modules via ../ —
    // still intra-action-domain, still no executors/mutators.
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        const isBootstrap = file.endsWith("bootstrap.js");
        const isActuatorRegistry = file.endsWith("actuatorRegistry.js");
        const isActuation = file.includes(`${path.sep}actuation${path.sep}`);
        const isVerification = file.includes(`${path.sep}verification${path.sep}`);
        const isInternal = file.includes(`${path.sep}internal${path.sep}`);
        for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
            const target = m[1];
            // Lane 3 actuation / Lane 4 verification subdomains may reach
            // sibling action modules via ../ (intent grammar, gate
            // vocabulary, clock, errors, authDomain, authSession) — still
            // intra-action-domain, still no executors/mutators.
            const ok =
                target.startsWith("./") ||
                target === "node:crypto" ||
                target === "node:util" ||
                target === "../capability/registry/ids" ||
                target === "../../capability/registry/ids" ||
                target === "../authority/evaluate" ||
                ((isActuation || isVerification || isInternal) && /^\/?(\.\.\/)*(intent|gate|clock|errors|authDomain|authSession|verification\/errors|verification\/postcondition|verification\/schema|verification\/verifierRegistry|actuation\/errors)$/.test(target.replace(".js", ""))) ||
                ((isActuation || isInternal) && /^\/?(\.\.\/)*(intent|gate|clock|errors|authDomain|authSession)$/.test(target.replace(".js", ""))) ||
                (isBootstrap && (target === "../capability/registry" || target === "../authority/store" || target === "./internal/verificationBootstrap")) ||
                // DB02-A (Repair5): the trusted bootstrap resolves a
                // READ-ONLY view (getCapability/getGeneration/countConsumption
                // only) over the canonical production Authority store — ONE
                // canonical authority truth, no second store, no bridge that
                // could write. See resolveLane2AuthorityStore()'s own header.
                (isBootstrap && target === "../authority/productionComposition") ||
                // MD-011: the canonical bootstrap wires the built-in Mata
                // Dewa visual-mode capabilities + actuators. These requires
                // pull capability metadata + a lazy read-only service getter
                // ONLY — no executors, no authority mutators, no fs/network
                // (the wiring module is separately scanned by the FORBIDDEN
                // patterns above only for action files; mataDewa wiring
                // laws are asserted in tests/mataDewa/visualModeWiring.test.js).
                // Lane 5 integration: the RF control wiring follows the
                // identical MD-011 pattern (descriptive capability metadata
                // + actuator binding over the service's internal control
                // surface; NO grants, NO authority mutators — laws asserted
                // in tests/mataDewa/trustIntegration.test.js).
                (isBootstrap && target === "../mataDewa/capabilities/visualModeWiring") ||
                (isBootstrap && target === "../mataDewa/capabilities/rfControlWiring") ||
                (isBootstrap && target === "../mataDewa/composition") ||
                // DB02-D (Repair5): the trusted bootstrap wires the first
                // real production external capability
                // (damar.runtime.diagnostic.probe) through the IDENTICAL
                // MD-011 pattern — descriptive capability metadata + an
                // actuator binding that routes through the governed
                // ExternalCapabilityFederation/DistributedExecutionRouter/
                // sandbox pipeline (src/federation/, a separately-audited
                // trust domain whose whole job IS governed execution). No
                // executor/mutator is embedded in src/action/ itself.
                (isBootstrap && target === "../federation/capabilities/diagnosticProbeWiring") ||
                (isActuatorRegistry && target === "../../capability/registry/ids");
            assert.ok(ok, `${file}: unexpected external require '${target}'`);
        }
    }
});

test("structural: gate delegates to canonical evaluator; no policy duplication", () => {
    const gateText = fs.readFileSync(path.join(__dirname, "../../src/action/gate.js"), "utf8");
    assert.ok(!/getGeneration|countConsumption|identityBinding/.test(gateText),
        "gate must not duplicate authority grant policy");
    // The trusted bootstrap (src/action/bootstrap.js) is the composition root
    // (seventh repair: the runtime factory lives in its private closure); it
    // must require the canonical evaluator.
    const bootstrapText = fs.readFileSync(path.join(__dirname, "../../src/action/bootstrap.js"), "utf8");
    assert.ok(/loadAndEvaluateAuthority/.test(bootstrapText), "bootstrap must delegate to canonical evaluator");
    // runtime.js is now a pure non-privileged vocabulary module: no factory,
    // no evaluator policy duplication.
    const runtimeText = fs.readFileSync(path.join(__dirname, "../../src/action/runtime.js"), "utf8");
    assert.ok(!/loadAndEvaluateAuthority\s*\(/.test(runtimeText), "runtime.js must contain no evaluation logic (vocabulary only)");
});

test("surface: no execution verbs in public API", () => {
    const api = require("../../src/action");
    const EXEC = /execute|invoke|run\b|dispatch|actuate|spawn|shell|callTool|performAction/i;
    // The runtime surface is { admit, evaluate } only.
    const names = Object.keys(api);
    for (const m of names) {
        assert.ok(!EXEC.test(m), `public API must not expose execution verb: ${m}`);
    }
    for (const v of ["execute", "invoke", "run", "dispatch", "actuate", "spawn", "shell", "callTool", "performAction"]) {
        assert.equal(typeof api[v], "undefined", `no '${v}' in public API`);
    }
});

test("surface: no authority-minting verbs in public API", () => {
    const api = require("../../src/action");
    const AUTH = /grant|authorize|approve|ratify|delegate|elevate|mint|issue\b|revoke/i;
    for (const m of Object.keys(api)) {
        assert.ok(!AUTH.test(m), `public API must not expose authority-minting verb: ${m}`);
    }
    for (const v of ["grant", "authorize", "approve", "ratify", "delegate", "elevate", "mint", "issue", "revoke"]) {
        assert.equal(typeof api[v], "undefined", `no '${v}' in public API`);
    }
    // issueIdentity / mintRuntimeIdentity / createRuntimeIdentityContext are gone.
    assert.equal(typeof api.issueIdentity, "undefined");
    assert.equal(typeof api.mintRuntimeIdentity, "undefined");
    assert.equal(typeof api.createRuntimeIdentityContext, "undefined");
});

test("surface: no privileged trust constructors exported", () => {
    const api = require("../../src/action");
    for (const forbidden of ["mintRuntimeIdentity", "createIntentAdmission", "createReadOnlyAuthorityContext", "createRuntimeIdentityContext", "mintAuthSession", "createAuthSessionIssuer", "createGate", "createSessionTrustDomain", "createActionAuthorityRuntime", "createAuthenticationDomain", "createTrustedActionRuntime", "createCanonicalVerifier", "createBootstrapFactory"]) {
        assert.equal(typeof api[forbidden], "undefined", `must not export ${forbidden}`);
    }
    assert.equal(typeof api.createAuthSessionIssuer, "undefined",
        "createAuthSessionIssuer must NOT be exported (Wave-4 blocker 1)");
    assert.equal(typeof api.isAuthSession, "undefined",
        "module-global isAuthSession must NOT be exported (runtime-local brand only)");
    // SIXTH repair: the composition factories are not exported at all —
    // composition is bootstrap-internal (one-shot host binding).
    assert.equal(typeof api.createActionAuthorityRuntime, "undefined",
        "createActionAuthorityRuntime must NOT be a public export (canonical bootstrap ownership)");
    assert.equal(typeof api.createAuthenticationDomain, "undefined",
        "createAuthenticationDomain must NOT be a public export (canonical bootstrap ownership)");
});

test("surface: no session/evaluation brand state reachable from any action module", () => {
    const path = require("node:path");
    const fs = require("node:fs");
    const dir = path.join(__dirname, "../../src/action");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
        const mod = require(path.join(dir, f));
        for (const forbidden of ["sessionBrand", "authSessionBrands", "EVAL_BRAND", "brandGate", "mintSession", "issueIdentity", "createGate", "createAuthSessionIssuer", "injectEvaluator", "setEvaluator", "setVerifier"]) {
            assert.equal(typeof mod[forbidden], "undefined", `${f} must not expose ${forbidden}`);
        }
    }
});
