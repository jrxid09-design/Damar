"use strict";

/**
 * ACTION AUTHORITY GATE V1 — canonical Authority differential matrix.
 *
 * For >=2000 generated grant/request cases (including MALFORMED persisted
 * state), compare the canonical evaluator (`loadAndEvaluateAuthority`, used by
 * AuthorityRegistry.authorize) against the Lane 2 gate. Invariants:
 *
 *   lane2AllowCanonicalReject == 0   (Lane 2 never ALLOWs what canonical rejects)
 *   lane2AllowCanonicalDeny   == 0   (Lane 2 never ALLOWs what canonical denies)
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadAndEvaluateAuthority } = require("../../src/authority/evaluate");
const { makeHarness } = require("./helpers");

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ACTIONS = ["read", "write", "delete"];
const SCOPES = ["safe.target", "unsafe.target", "scope=home-lan", "scope=cloud"];
const STATUSES = ["ACTIVE", "SUSPENDED", "REVOKED", "EXHAUSTED"];
const PRINCIPALS = ["alice", "bob", "carol"];

async function runDifferential(seed) {
    const rng = mulberry32(seed);

    // Trusted test bootstrap composes the canonical evaluation harness and
    // registers the differential capability + scope resolvers internally.
    const h = await makeHarness({
        scopeBindings: {
            "cap.diff": {
                read: (a) => a && a.target ? [a.target] : [],
                write: (a) => a && a.target ? [a.target] : [],
                delete: (a) => a && a.target ? [a.target] : []
            }
        }
    });
    const { registry, registrars, store, rt, authDomain } = h;

    const res = registrars.core.register(JSON.stringify({
        schemaVersion: 1, id: "cap.diff", kind: "system", provider: "core",
        operations: ["read", "write", "delete"], requirements: [], effects: []
    }));
    registry.observeAvailability("cap.diff", "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });

    let lane2AllowCanonicalReject = 0;
    let lane2AllowCanonicalDeny = 0;
    let cases = 0;

    for (let i = 0; i < 2200; i++) {
        const action = ACTIONS[Math.floor(rng() * ACTIONS.length)];
        const scopeToken = SCOPES[Math.floor(rng() * SCOPES.length)];
        const status = STATUSES[Math.floor(rng() * STATUSES.length)];
        const grantScope = rng() < 0.5 ? [scopeToken] : [];
        const grantActions = rng() < 0.5 ? [action] : ["read", "write"];
        const principal = PRINCIPALS[Math.floor(rng() * PRINCIPALS.length)];
        const grantSubject = rng() < 0.5 ? principal : PRINCIPALS[Math.floor(rng() * PRINCIPALS.length)];
        const useIdentityBinding = rng() < 0.5;
        // occasionally inject a malformed persisted grant
        const malformed = rng() < 0.05;

        let payload;
        if (malformed) {
            const malformedKinds = [
                { restrictions: null },
                { actions: null },
                { maxExecutions: "NaN" },
                { subject: null },
                { identityBinding: { principals: "not-an-array" } },
                { scope: "not-an-array" }
            ];
            const m = malformedKinds[Math.floor(rng() * malformedKinds.length)];
            payload = {
                capabilityId: "cap.diff", kind: "root", subject: grantSubject,
                issuer: "diff", actions: grantActions, scope: grantScope, allowedPurposes: [],
                restrictions: { kind: "unrestricted" }, maxExecutions: null, usedExecutions: 0,
                issuedAt: "2025-01-01T00:00:00Z", notBefore: null, expiresAt: null,
                status, generation: 0, delegationDepth: 0, remainingDelegationDepth: 2,
                parentCapabilityId: null, rootCapabilityId: "cap.diff", ratificationId: null,
                identityBinding: useIdentityBinding ? { principals: [grantSubject] } : null,
                extra: null,
                ...m
            };
        } else {
            payload = {
                capabilityId: "cap.diff", kind: "root", subject: grantSubject,
                issuer: "diff", actions: grantActions, scope: grantScope, allowedPurposes: [],
                restrictions: { kind: "unrestricted" }, maxExecutions: null, usedExecutions: 0,
                issuedAt: "2025-01-01T00:00:00Z", notBefore: null, expiresAt: null,
                status, generation: 0, delegationDepth: 0, remainingDelegationDepth: 2,
                parentCapabilityId: null, rootCapabilityId: "cap.diff", ratificationId: null,
                identityBinding: useIdentityBinding ? { principals: [grantSubject] } : null,
                extra: null
            };
        }
        await store.upsertCapability("cap.diff", status, 0, JSON.stringify(payload));

        const request = {
            capabilityId: "cap.diff",
            action,
            scope: [scopeToken],
            identity: { principal }
        };

        const canonical = await loadAndEvaluateAuthority(store, request, { nowMs: 1000 });

        const intent = rt.admit(JSON.stringify({
            schemaVersion: 1, capabilityId: "cap.diff", operation: action,
            arguments: { target: scopeToken }
        }));
        // Trusted test authentication (harness-owned domain): the differential
        // principal is asserted by the trusted authenticator, exactly like a
        // token-guarded transport would decide in production.
        const lane2 = await rt.evaluate(intent, h.session(principal));

        if (canonical.allowed !== true) {
            if (lane2.decision === "ALLOW") {
                // canonical denied/rejected; lane2 must NOT allow.
                if (canonical.reasonCode === "CAP_MALFORMED") lane2AllowCanonicalReject++;
                else lane2AllowCanonicalDeny++;
            }
        }
        cases++;
    }

    return { lane2AllowCanonicalReject, lane2AllowCanonicalDeny, cases };
}

test("differential: >=2000 cases (incl. malformed), zero lane2-ALLOW-vs-canonical-reject/deny", async () => {
    const r = await runDifferential(20260901);
    assert.ok(r.cases >= 2000);
    assert.equal(r.lane2AllowCanonicalReject, 0, "Lane 2 must never ALLOW when canonical rejects (malformed)");
    assert.equal(r.lane2AllowCanonicalDeny, 0, "Lane 2 must never ALLOW when canonical denies");
});
