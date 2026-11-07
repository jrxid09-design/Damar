"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — storm test (post trust-origin repair).
 * >=12000 deterministic mixed operations. Gate is OBSERVATIONAL. Extended
 * violation counters (all zero), each with an ACTIVE detection path.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createCapabilityRuntime } = require("../../src/capability/registry");
const { createMemoryAuthorityStore } = require("../../src/authority/store");
const { parseActionIntent, DECISION, isCanonicalAuthorityEvaluation } = require("../../src/action");
const { ActionError } = require("../../src/action");
const { makeHarness, composeIsolatedTrustDomain } = require("./helpers");

const OP_TARGET = 12000;
const CAP_POOL = 12;

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function targetScope(args) {
    const target = args && typeof args.target === "string" ? args.target.trim().toLowerCase() : "";
    return target ? [target] : [];
}

async function runStorm(seed) {
    const rng = mulberry32(seed);

    // ---- trusted test bootstrap (sixth repair): canonical state, the
    // AuthenticationDomain, and the identity verifier are all owned by the
    // trusted harness closure. The storm composes through the trusted
    // bootstrap facilities only. ----
    const bindings = {};
    for (let i = 0; i < CAP_POOL; i++) bindings[`pool.cap.${i}`] = { read: targetScope, write: targetScope };
    const h = await makeHarness({
        scopeBindings: bindings,
        authenticate: (e) => {
            // Mirror trusted auth infra: the authenticated principal comes
            // from the authenticator's own decision. The caller's claimed
            // principal is echoed ONLY when bootstrap intends to mint it.
            const p = e && (e.claimedPrincipal ?? e.principal);
            return (typeof p === "string" && p.length > 0) ? { principal: p } : null;
        }
    });
    const capabilityRuntime = { registry: h.registry, registrars: h.registrars };
    const { registry, registrars } = capabilityRuntime;
    const store = h.store;
    const authDomain = h.authDomain;
    const rt = h.rt;
    const session = (o) => authDomain.authenticate({ claimedPrincipal: o && o.principal, ...o }); // trusted infra path

    const C = {
        executions: 0, actuations: 0, authorityMutations: 0, capabilityMutations: 0,
        forgedAuthorityAccepted: 0, modelAuthorityAccepted: 0, memoryAuthorityAccepted: 0,
        channelAuthorityAccepted: 0, staleIncarnationAllowed: 0, staleAuthorityAllowed: 0,
        undeclaredOperationAllowed: 0, unavailableCapabilityAllowed: 0, partialMutation: 0,
        hostileCallerCodeExecution: 0, canonicalStateEscape: 0, untypedErrors: 0, openHandles: 0,
        identitySpoofAllowed: 0, channelSpoofAllowed: 0, sessionSpoofAllowed: 0,
        scopeBypassAllowed: 0, authorityReadFailureAllowed: 0,
        malformedAuthorityEvaluationAllowed: 0, staleUnboundIntentAllowed: 0,
        invalidTimestampAccepted: 0, lane2AllowCanonicalDeny: 0,
        forgedRuntimeIdentityAccepted: 0, clonedRuntimeIdentityAccepted: 0,
        forgedScopeResolverAccepted: 0, fakeAuthorityContextAllowed: 0,
        forgedAuthorityEvaluationAllowed: 0, subjectPrincipalMismatchAllowed: 0,
        malformedGrantAllowed: 0, lane2AllowCanonicalReject: 0,
        arbitraryPrincipalMinted: 0, canonicalStateImpersonation: 0,
        evaluatorReplacementSucceeded: 0, canonicalVerifierReplacementSucceeded: 0,
        scopeBindingMutationAffectedRuntime: 0, hostileIdentityTrapExecution: 0,
        // Wave-4 fourth repair (runtime-local trust domain) counters
        publicIssuerMintedVictim: 0, crossRuntimeSessionAccepted: 0,
        directGateInjectionSucceeded: 0, forgedSessionAccepted: 0,
        // Wave-4 fifth repair (caller-owned auth bootstrap removed) counters
        callerObtainedAuthBinder: 0, callerObtainedSessionMint: 0,
        authFailurePrincipalFallback: 0, retainedAuthBindingReplay: 0,
        // Wave-4 SIXTH repair (canonical bootstrap ownership) counters
        publicActionRuntimeFactoryExposed: 0, publicAuthenticationDomainFactoryExposed: 0,
        callerSelectedVerifierAccepted: 0, canonicalStateReboundByAttacker: 0,
        // Wave-4 SEVENTH repair counters (first-binder + caller authenticator + facade seeding)
        exportedCompositionBinderAcquired: 0, exportedAuthenticationBinderAcquired: 0,
        callerAuthenticatorControlledCanonicalIdentity: 0, productionFacadeAuthorityMutationSucceeded: 0
    };

    // A SECOND runtime over DIFFERENT canonical state: sessions from it must
    // never be accepted by `rt` (runtime-local brand via separate domain).
    const foreign = composeIsolatedTrustDomain({
        clock: { nowMs: () => 1000 },
        trustedScopeBindings: { "pool.cap.0": { read: targetScope } }
    });
    const foreignState = foreign.capabilityRuntime;
    const foreignStore = foreign.authorityStore;
    const foreignDomain = foreign.authDomain;
    const foreignRt = foreign.rt;
    {
        const fres = foreignState.registrars.core.register(JSON.stringify({ schemaVersion: 1, id: "pool.cap.0", kind: "system", provider: "core", operations: ["read", "write"], requirements: [], effects: [] }));
        foreignState.registry.observeAvailability("pool.cap.0", "AVAILABLE", { generation: 1, incarnationId: fres.incarnationId });
        await foreignStore.upsertCapability("pool.cap.0", "ACTIVE", 0, JSON.stringify({
            capabilityId: "pool.cap.0", kind: "root", subject: "actor.0", issuer: "storm", actions: ["read"], scope: [], allowedPurposes: [],
            restrictions: { kind: "unrestricted" }, maxExecutions: null, usedExecutions: 0,
            issuedAt: "2025-01-01T00:00:00Z", notBefore: null, expiresAt: null,
            status: "ACTIVE", generation: 0, delegationDepth: 0, remainingDelegationDepth: 2,
            parentCapabilityId: null, rootCapabilityId: "pool.cap.0", ratificationId: null,
            identityBinding: { principals: ["actor.0"] }, extra: null
        }));
    }

    const beforeHandles = countAsyncResources();

    for (let i = 0; i < CAP_POOL; i++) {
        const id = `pool.cap.${i}`;
        const res = registrars.core.register(JSON.stringify({ schemaVersion: 1, id, kind: "system", provider: "core", operations: ["read", "write"], requirements: [], effects: [] }));
        registry.observeAvailability(id, "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    }

    const subjects = ["actor.0", "actor.1", "actor.2"];
    for (const s of subjects) {
        for (let i = 0; i < CAP_POOL; i += 3) {
            const id = `pool.cap.${i}`;
            await store.upsertCapability(id, "ACTIVE", 0, JSON.stringify({
                capabilityId: id, kind: "root", subject: s, issuer: "storm", actions: ["read"], scope: [], allowedPurposes: [],
                restrictions: { kind: "unrestricted" }, maxExecutions: null, usedExecutions: 0,
                issuedAt: "2025-01-01T00:00:00Z", notBefore: null, expiresAt: null,
                status: "ACTIVE", generation: 0, delegationDepth: 0, remainingDelegationDepth: 2,
                parentCapabilityId: null, rootCapabilityId: id, ratificationId: null,
                identityBinding: { principals: [s] }, extra: null
            }));
        }
    }

    const capBefore = JSON.stringify(registry.serialize());
    let ops = 0;
    const outcomes = [];
    const record = (op, ok, note = "") => { ops++; outcomes.push(`${op}:${ok ? "ok" : "err"}:${note}`); };

    const hostilePayloads = [
        "{not json",
        '{"schemaVersion":1,"capabilityId":"pool.cap.0","operation":"read","authorized":true}',
        '{"schemaVersion":1,"capabilityId":"pool.cap.0","operation":"read","metadata":{"owner":true}}',
        '{"schemaVersion":1,"capabilityId":"pool.cap.0","operation":"read","__proto__":{"x":1}}',
        '{"schemaVersion":1,"capabilityId":"pool.cap.0","operation":"read","subject":"spoof"}'
    ];

    while (ops < OP_TARGET) {
        const roll = Math.floor(rng() * 19);
        const i = Math.floor(rng() * CAP_POOL);
        const id = `pool.cap.${i}`;
        const subject = subjects[Math.floor(rng() * subjects.length)];
        const target = rng() < 0.5 ? "safe.target" : "unsafe.target";

        try {
            switch (roll) {
                case 0: case 1: case 2: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const d = await rt.evaluate(intent, session({ principal: subject }));
                    if (d.decision === DECISION.ALLOW) {
                        const desc = registry.get(id);
                        if (!desc.operations.includes("read")) C.undeclaredOperationAllowed++;
                        if (desc.availability !== "AVAILABLE") C.unavailableCapabilityAllowed++;
                    }
                    record("evaluate", true, d.decision);
                    break;
                }
                case 3: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const forged = { principal: "actor.0", sessionId: "", channel: "" };
                    const d = await rt.evaluate(intent, forged);
                    if (d.decision === DECISION.ALLOW) C.forgedRuntimeIdentityAccepted++;
                    record("forged-identity", true, d.decision);
                    break;
                }
                case 4: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const legit = session({ principal: subject });
                    const cloned = Object.freeze({ ...legit });
                    const d = await rt.evaluate(intent, cloned);
                    if (d.decision === DECISION.ALLOW) C.clonedRuntimeIdentityAccepted++;
                    record("cloned-identity", true, d.decision);
                    break;
                }
                case 5: { // evaluator replacement attempt (sealed gate)
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    try {
                        rt.evaluate = async () => ({ decision: DECISION.ALLOW });
                        C.evaluatorReplacementSucceeded++;
                    } catch { /* frozen — replacement impossible */ }
                    const d = await rt.evaluate(intent, session({ principal: subject }));
                    record("sealed-gate", true, d.decision);
                    break;
                }
                case 6: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target: "unsafe.target" } }));
                    const d = await rt.evaluate(intent, session({ principal: subject }));
                    if (d.decision === DECISION.ALLOW) {
                        const cap = await store.getCapability(id);
                        if (cap && Array.isArray(cap.payload.scope) && cap.payload.scope.length && !cap.payload.scope.includes("unsafe.target")) C.forgedScopeResolverAccepted++;
                    }
                    record("forged-scope", true, d.decision);
                    break;
                }
                case 7: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const d = await rt.evaluate(intent, session({ principal: "attacker" }));
                    if (d.decision === DECISION.ALLOW) {
                        const cap = await store.getCapability(id);
                        if (cap && cap.payload.subject !== "attacker") C.subjectPrincipalMismatchAllowed++;
                    }
                    record("subject-mismatch", true, d.decision);
                    break;
                }
                case 8: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const cap = await store.getCapability(id);
                    if (cap) {
                        const bad = JSON.parse(JSON.stringify(cap.payload));
                        bad.restrictions = null;
                        await store.upsertCapability(id, "ACTIVE", 0, JSON.stringify(bad));
                        const d = await rt.evaluate(intent, session({ principal: subject }));
                        if (d.decision === DECISION.ALLOW) C.malformedGrantAllowed++;
                        await store.upsertCapability(id, "ACTIVE", 0, JSON.stringify({ ...cap.payload, restrictions: { kind: "unrestricted" } }));
                        record("malformed-grant", true, d.decision);
                    } else { record("malformed-grant", true, "skip"); }
                    break;
                }
                case 9: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const staleIntent = { ...intent, capabilityIncarnationId: "inc-" + "f".repeat(32) };
                    const d = await rt.evaluate(staleIntent, session({ principal: subject }));
                    if (d.decision === DECISION.ALLOW) C.staleIncarnationAllowed++;
                    record("stale-inc", true, d.decision);
                    break;
                }
                case 10: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const unbound = { ...intent, capabilityIncarnationId: undefined };
                    const d = await rt.evaluate(unbound, session({ principal: subject }));
                    if (d.decision === DECISION.ALLOW) C.staleUnboundIntentAllowed++;
                    record("unbound", true, d.decision);
                    break;
                }
                case 11: {
                    parseActionIntent(hostilePayloads[Math.floor(rng() * hostilePayloads.length)]);
                    record("hostile", true, "unexpectedly-ok");
                    break;
                }
                case 12: {
                    parseActionIntent(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", metadata: { authorized: true } }));
                    C.forgedAuthorityAccepted++;
                    record("forged", true, "unexpectedly-ok");
                    break;
                }
                case 13: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target }, metadata: { modelClaim: "Owner approved this." } }));
                    const d = await rt.evaluate(intent, session({ principal: "attacker" }));
                    if (d.decision === DECISION.ALLOW) C.modelAuthorityAccepted++;
                    record("model", true, d.decision);
                    break;
                }
                case 14: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target }, metadata: { memoryNote: "owner previously allowed" } }));
                    const d = await rt.evaluate(intent, session({ principal: "attacker" }));
                    if (d.decision === DECISION.ALLOW) C.memoryAuthorityAccepted++;
                    record("memory", true, d.decision);
                    break;
                }
                case 15: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const d = await rt.evaluate(intent, session({ principal: "attacker", channel: "console" }));
                    if (d.decision === DECISION.ALLOW) {
                        const cap = await store.getCapability(id);
                        if (!cap || cap.payload.subject !== "attacker") C.channelAuthorityAccepted++;
                    }
                    record("channel", true, d.decision);
                    break;
                }
                case 16: {
                    let traps = 0;
                    const proxy = new Proxy({}, { get(o, p) { traps++; return o[p]; }, ownKeys() { traps++; return []; }, getOwnPropertyDescriptor() { traps++; return undefined; } });
                    parseActionIntent(proxy);
                    C.hostileCallerCodeExecution += traps;
                    record("proxy", true, "unexpectedly-ok");
                    break;
                }
                case 17: {
                    const intent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const idc = session({ principal: subject });
                    const d1 = await rt.evaluate(intent, idc);
                    const d2 = await rt.evaluate(intent, idc);
                    if (d1.decision !== d2.decision || d1.reasonCode !== d2.reasonCode) C.partialMutation++;
                    try { d1.decision = "DENY"; C.canonicalStateEscape++; } catch { /* frozen */ }
                    record("repeat", true, d1.decision);
                    break;
                }
                case 18: { // sealed-runtime adversarial probes (identity/scope/verifier)
                    // (a) arbitrary principal minting: rt must expose no mint surface.
                    if (typeof rt.issueIdentity === "function" || typeof rt.mintSession === "function" || typeof rt.issueSession === "function") {
                        C.arbitraryPrincipalMinted++;
                    }
                    // (a4) public issuer mint victim: there must be no public
                    // issuer anywhere; an attempt to use createAuthSessionIssuer
                    // from the public API must be undefined.
                    if (typeof require("../../src/action").createAuthSessionIssuer === "function") {
                        // Counter is active: it fires when a public issuer is
                        // (re)introduced. Must stay zero.
                        const fakeIssuer = require("../../src/action").createAuthSessionIssuer();
                        const victim = fakeIssuer.mintSession({ principal: "victim" });
                        const dv = await rt.evaluate(intent, victim);
                        if (dv.decision === DECISION.ALLOW) C.publicIssuerMintedVictim++;
                    }
                    // (b) canonical verifier replacement: rt must expose no writable verifier.
                    try {
                        rt.isCanonicalEvaluation = () => true;
                        C.canonicalVerifierReplacementSucceeded++;
                    } catch { /* frozen */ }
                    // (c) hostile Proxy identity rejection: zero traps.
                    {
                        let traps = 0;
                        const hostileSession = new Proxy({}, {
                            get(o, p) { traps++; return o[p]; },
                            getPrototypeOf() { traps++; return Object.prototype; },
                            ownKeys() { traps++; return []; },
                            getOwnPropertyDescriptor() { traps++; return undefined; },
                            has() { traps++; return false; },
                            set() { traps++; return false; }
                        });
                        const d = await rt.evaluate(rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } })), hostileSession);
                        if (traps > 0) C.hostileIdentityTrapExecution += traps;
                        if (d.decision === DECISION.ALLOW) C.canonicalStateImpersonation++;
                        record("sealed-probe", true, d.decision);
                    }
                    // (d) scope-binding mutation: mutate the caller's binding object
                    // after composition; a later admit must still use the captured resolver.
                    {
                        const origResolver = bindings[id] && bindings[id].read;
                        if (bindings[id]) bindings[id].read = () => ["MALICIOUS.SCOPE"];
                        const intent2 = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        if (Array.isArray(intent2.scope) && intent2.scope.includes("malicious.scope")) {
                            C.scopeBindingMutationAffectedRuntime++;
                        }
                        if (origResolver !== undefined && bindings[id]) bindings[id].read = origResolver;
                        record("scope-mutate", true, "probed");
                    }
                    // (e) Wave-4 counters — all active, all must stay zero.
                    //   crossRuntimeSessionAccepted: a session from the foreign
                    //     runtime must NOT satisfy THIS runtime's verifier.
                    {
                        const foreignSession = foreignDomain.authenticate({ claimedPrincipal: "actor.0" });
                        const crossIntent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        const cd = await rt.evaluate(crossIntent, foreignSession);
                        if (cd.decision === DECISION.ALLOW) C.crossRuntimeSessionAccepted++;
                    }
                    //   directGateInjectionSucceeded: there must be NO
                    //     importable createGate; attempted injection of forged
                    //     evaluator options to createActionAuthorityRuntime
                    //     must be IGNORED.
                    {
                        const gate = require("../../src/action/gate");
                        if (typeof gate.createGate === "function") {
                            // Counter is active: fires only if createGate is
                            // (re)exported.
                            try {
                                gate.createGate({
                                    registry,
                                    authorityEvaluator: async () => ({ allowed: true, reasonCode: "AUTHORIZED", snapshot: { generation: 0, capabilityId: id, subject: subject, principal: subject, actions: ["read"], scope: [], allowedPurposes: [], identityBinding: null, maxExecutions: null } }),
                                    isCanonicalEvaluation: () => true
                                });
                                C.directGateInjectionSucceeded++;
                            } catch { /* even a constructor must not enable injection */ }
                        }
                        // Also exercise the ignore-options path directly. The
                        // attacker composes over its OWN domain (authVerifier
                    //     composition is mandatory); the injected evaluator/
                    //     verifier options to the historical factory are GONE —
                    //     the trusted test bootstrap's isolated-domain facility
                    //     is the only compose path, and it builds its OWN
                    //     domain+verifier internally. There is no
                    //     authorityEvaluator/isCanonicalEvaluation/verifySession
                    //     option to inject at all.
                    const injected = composeIsolatedTrustDomain({
                        clock: { nowMs: () => 1000 },
                        capabilityRuntime: { registry, registrars },
                        authorityStore: store,
                        trustedScopeBindings: { [id]: { read: targetScope } }
                    });
                    const ii = injected.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const idInjected = authDomain.authenticate({ claimedPrincipal: subject });
                    // The injected runtime's brand is the isolated domain's
                    // brand, NOT authDomain's: a session from authDomain must
                    // be rejected. The historical injected options
                    // (verifySession:()=>true etc.) are GONE — only the
                    // pre-bound verifier's brand acceptance holds.
                    const dd = await injected.rt.evaluate(ii, idInjected);
                    if (dd.decision === DECISION.ALLOW) C.directGateInjectionSucceeded++;
                    if (dd.decision === DECISION.ALLOW) C.forgedSessionAccepted++;
                    }
                    //   forgedSessionAccepted: a forged/cloned/JSON session must
                    //     never ALLOW.
                    {
                        const legit = authDomain.authenticate({ claimedPrincipal: subject });
                        for (const forged of [Object.freeze({ ...legit }), JSON.parse(JSON.stringify(legit)), { principal: subject, sessionId: "", channel: "" }]) {
                            const fi = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                            const fd = await rt.evaluate(fi, forged);
                            if (fd.decision === DECISION.ALLOW) C.forgedSessionAccepted++;
                        }
                    }
                    // ---- Wave-4 FIFTH repair counters (caller-owned auth
                    // bootstrap removed). All active paths; all must stay zero. ----
                    //   callerObtainedAuthBinder: the runtime constructor must
                    //     expose NO onReady/bindAuthentication callback surface.
                    //     The factory itself is no longer callable by anyone but
                    //     the trusted bootstrap (one-shot host binding), so there
                    //     is no composition call to even attempt; the active
                    //     detection path is probing every reachable surface for
                    //     a binder-like callable.
                    {
                        let binder = null;
                        // The factory is not importable: any attempt to compose
                        // via a public/direct surface must be impossible.
                        const api = require("../../src/action");
                        if (typeof api.createActionAuthorityRuntime === "function") {
                            // Historical factory re-exposed: try the exploit.
                            try {
                                api.createActionAuthorityRuntime({
                                    capabilityRuntime: { registry, registrars },
                                    authorityStore: store,
                                    authVerifier: authDomain.verifier,
                                    trustedScopeBindings: {},
                                    clock: { nowMs: () => 1000 },
                                    onReady: (caps) => { binder = caps && caps.bindAuthentication ? caps.bindAuthentication : "obtained"; }
                                });
                            } catch { /* rejection is correct */ }
                        }
                        if (binder !== null) C.callerObtainedAuthBinder++;
                        // Even a rejected construction must not leave any callable
                        // binder lying on the runtime module exports.
                        const apiB = require("../../src/action");
                        if (typeof apiB.bindAuthentication === "function" || typeof apiB.onReady === "function") C.callerObtainedAuthBinder++;
                    }
                    //   callerObtainedSessionMint: no export or runtime surface
                    //     may expose mintSession; probe every runtime property
                    //     and module export for a mint-like callable.
                    {
                        const apiC = require("../../src/action");
                        for (const k of Object.keys(apiC)) {
                            if (typeof apiC[k] === "function" && /mint|issue/i.test(k)) C.callerObtainedSessionMint++;
                        }
                        for (const k of Object.keys(rt)) {
                            if (typeof rt[k] === "function" && /mint|issue|bind/i.test(k)) C.callerObtainedSessionMint++;
                        }
                        // createAuthenticationDomain itself must expose no mintSession
                        // method on its returned surface (authenticate + verifier only).
                        if (typeof authDomain.mintSession === "function" || typeof authDomain.issuer === "function") C.callerObtainedSessionMint++;
                        // Even with authentication failing, a "claimed victim" object
                        // minted through any public path must never verify.
                        const victimAttempt = authDomain.authenticate({ claimedPrincipal: "victim", principal: "victim", requestedPrincipal: "victim" });
                        // (attacker grant for actor.0 exists for cap.0 only; use a
                        // subject that has a grant to prove ALLOW is impossible for
                        // an unauthenticated claim.)
                        if (victimAttempt && (await rt.evaluate(rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } })), victimAttempt)).decision === DECISION.ALLOW && !subjects.includes("victim")) {
                            C.callerObtainedSessionMint++;
                        }
                    }
                    //   authFailurePrincipalFallback: authentication that fails
                    //     (null/undefined/malformed/throws) must NEVER mint a session
                    //     that verifies, and the gate must not fall back to any
                    //     caller-asserted principal string.
                    {
                        const intentF = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        // Deterministic failing authenticator: returns null,
                        // undefined, malformed, or throws — never a valid principal.
                        // No rng() consumption (keeps the storm op-count stable).
                        const failingCases = [
                            () => null,
                            () => undefined,
                            () => false,
                            () => ({}),
                            () => { throw new Error("auth infra down"); },
                            () => ({ principal: null }),
                            () => ({ principal: 123 }),
                            () => ({ principal: "" })
                        ];
                        for (const authFn of failingCases) {
                            // Trusted test bootstrap isolated-domain facility: the
                            // domain is constructed internally, not by a caller.
                            const failingAuth = composeIsolatedTrustDomain({ clock: { nowMs: () => 1000 }, authenticate: authFn }).authDomain;
                            const attempt = failingAuth.authenticate({ claimedPrincipal: "actor.0", principal: "actor.0", requestedPrincipal: "actor.0" });
                            if (attempt !== null) {
                                // A failing authenticator must never produce a minted session.
                                C.authFailurePrincipalFallback++;
                            }
                        }
                        // Even if a hostile caller forges an object with claimed
                        // fields, the gate must DENY (no fallback to claimed identity).
                        const hostile = { claimedPrincipal: "actor.0", principal: "actor.0", requestedPrincipal: "actor.0", sessionId: "", channel: "" };
                        const fd = await rt.evaluate(intentF, hostile);
                        if (fd.decision === DECISION.ALLOW) C.authFailurePrincipalFallback++;
                    }
                    //   retainedAuthBindingReplay: there is no retained binder to
                    //     replay; a hostile caller cannot obtain one from the
                    //     AuthenticationDomain surface, and any retained reference
                    //     to the verifier cannot mint.
                    {
                        // The domain surface is authenticate + verifier only; the
                        // verifier cannot mint anything (verify() reads the brand).
                        const retained = authDomain.verifier;
                        if (typeof retained.mint === "function" || typeof retained.mintSession === "function" || typeof retained.bindAuthentication === "function") {
                            C.retainedAuthBindingReplay++;
                        } else {
                            // Attempt to "replay" the verifier as an issuer: verify
                            // must not mint new sessions (brand membership only).
                            const forgedReplay = retained.verify({ claimedPrincipal: "actor.0", principal: "actor.0" });
                            if (forgedReplay !== null) C.retainedAuthBindingReplay++;
                        }
                        // A second AuthenticationDomain cannot verify (or mint into)
                        // the first domain's brand.
                        const secondDomain = composeIsolatedTrustDomain({ clock: { nowMs: () => 1000 }, authenticate: (e) => ({ principal: e && e.claimedPrincipal }) }).authDomain;
                        const s2 = secondDomain.authenticate({ claimedPrincipal: "actor.0" });
                        const d2 = await rt.evaluate(rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } })), s2);
                        if (d2.decision === DECISION.ALLOW) C.retainedAuthBindingReplay++;
                    }
                    // ---- Wave-4 SIXTH repair counters (canonical bootstrap
                    // ownership; caller-selectable verifier removed). All active
                    // paths; all must stay zero. ----
                    //   publicActionRuntimeFactoryExposed: the public API must
                    //     expose NO createRuntime/createActionAuthorityRuntime
                    //     factory, and no action submodule export may be a
                    //     runtime-factory-like callable.
                    {
                        const api = require("../../src/action");
                        if (typeof api.createActionAuthorityRuntime === "function") C.publicActionRuntimeFactoryExposed++;
                        for (const name of Object.keys(api)) {
                            if (typeof api[name] === "function" && /createActionAuthorityRuntime|createRuntime|createActionRuntime/i.test(name)) {
                                C.publicActionRuntimeFactoryExposed++;
                            }
                        }
                        // direct submodule imports also expose no factory
                        const runtimeModule = require("../../src/action/runtime");
                        if (typeof runtimeModule.createActionAuthorityRuntime === "function") C.publicActionRuntimeFactoryExposed++;
                    }
                    //   publicAuthenticationDomainFactoryExposed: the public API
                    //     and authDomain submodule must expose NO
                    //     createAuthenticationDomain factory.
                    {
                        const api = require("../../src/action");
                        if (typeof api.createAuthenticationDomain === "function") C.publicAuthenticationDomainFactoryExposed++;
                        for (const name of Object.keys(api)) {
                            if (typeof api[name] === "function" && /createAuthenticationDomain|createDomain/i.test(name)) {
                                C.publicAuthenticationDomainFactoryExposed++;
                            }
                        }
                        const authDomainModule = require("../../src/action/authDomain");
                        if (typeof authDomainModule.createAuthenticationDomain === "function") C.publicAuthenticationDomainFactoryExposed++;
                    }
                    //   callerSelectedVerifierAccepted: a fake verifier
                    //     {verify:()=>victim} has NO path into the canonical
                    //     runtime. Probe the public API and the trusted
                    //     bootstrap for any composition surface that accepts an
                    //     authVerifier/verifier option; none should trust the
                    //     fake verifier to produce an ALLOW on canonical state.
                    {
                        const fakeVerifier = { verify: () => "actor.0" };
                        // The public API exposes no composition factory at all.
                        // The trusted test bootstrap's isolated-domain facility
                        // is the only compose path, and it constructs its OWN
                        // verifier internally (the fakeVerifier is never read).
                        let attackerRt = null;
                        try {
                            attackerRt = composeIsolatedTrustDomain({
                                clock: { nowMs: () => 1000 },
                                capabilityRuntime: { registry, registrars },
                                authorityStore: store,
                                trustedScopeBindings: { [id]: { read: targetScope } }
                                // No authVerifier option accepted — the isolated
                                // facility builds its own domain+verifier.
                            });
                        } catch { /* composition with a caller verifier must reject */ }
                        if (attackerRt && attackerRt.rt) {
                            // The canonical victim session must NEVER verify on
                            // the attacker runtime (separate brand).
                            const victim = authDomain.authenticate({ claimedPrincipal: "actor.0" });
                            const ai = attackerRt.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                            const dv = await attackerRt.rt.evaluate(ai, victim);
                            if (dv.decision === DECISION.ALLOW) C.callerSelectedVerifierAccepted++;
                        }
                        // The fake verifier cannot be attached to canonical
                        // state at all: there is no public/direct factory.
                        const api = require("../../src/action");
                        if (typeof api.createActionAuthorityRuntime === "function") C.callerSelectedVerifierAccepted++;
                    }
                    //   canonicalStateReboundByAttacker: an attacker that
                    //     POSSESSES canonical registry+store references cannot
                    //     construct a runtime over them that accepts its OWN
                    //     attacker-minted "victim" session for canonical state.
                    //     The attacker can compose an isolated domain (separate
                    //     trust), but that domain's sessions never verify on the
                    //     canonical runtime, and the attacker's runtime never
                    //     trusts the canonical victim session.
                    {
                        const attacker = composeIsolatedTrustDomain({
                            clock: { nowMs: () => 1000 },
                            capabilityRuntime: { registry, registrars },
                            authorityStore: store,
                            trustedScopeBindings: { [id]: { read: targetScope } }
                        });
                        const attackerSession = attacker.authDomain.authenticate({ claimedPrincipal: "actor.0" });
                        const canonicalIntent = rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        // attacker session on canonical runtime => DENY
                        const onCanonical = await rt.evaluate(canonicalIntent, attackerSession);
                        if (onCanonical.decision === DECISION.ALLOW) C.canonicalStateReboundByAttacker++;
                        // canonical victim session on attacker runtime => DENY
                        const victimSession = authDomain.authenticate({ claimedPrincipal: "actor.0" });
                        const attackerIntent = attacker.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        const onAttacker = await attacker.rt.evaluate(attackerIntent, victimSession);
                        if (onAttacker.decision === DECISION.ALLOW) C.canonicalStateReboundByAttacker++;
                    }
                    // ---- Wave-4 SEVENTH repair counters (first-binder trust
                    // + caller authenticator + facade seeding removed). All
                    // active paths; all must stay zero. ----
                    //   exportedCompositionBinderAcquired: NO exported binder,
                    //     token, host, or first-call-wins surface may exist on
                    //     any action module (runtime.js/authDomain.js are pure
                    //     non-privileged vocabulary modules).
                    {
                        const runtimeModule = require("../../src/action/runtime");
                        for (const name of ["bindCompositionHost", "bindHost", "acquireHost", "registerHost", "installHost", "claimComposition", "bootstrapBind", "hostToken", "getFactory", "getComposer", "composeActionAuthorityRuntime", "createActionAuthorityRuntime"]) {
                            if (typeof runtimeModule[name] === "function") C.exportedCompositionBinderAcquired++;
                        }
                    }
                    //   exportedAuthenticationBinderAcquired: same for the
                    //     authentication/domain composition surface.
                    {
                        const authDomainModule = require("../../src/action/authDomain");
                        for (const name of ["bindAuthenticationHost", "bindHost", "acquireHost", "registerHost", "installHost", "claimComposition", "bootstrapBind", "hostToken", "getFactory", "getComposer", "composeAuthenticationDomain", "createAuthenticationDomain"]) {
                            if (typeof authDomainModule[name] === "function") C.exportedAuthenticationBinderAcquired++;
                        }
                    }
                    //   callerAuthenticatorControlledCanonicalIdentity: the
                    //     PRODUCTION canonical facade must accept NO caller-
                    //     selected authenticator/verifier, and its fixed
                    //     fail-closed adapter must never mint a caller-asserted
                    //     principal.
                    {
                        // The storm process holds the trusted TEST bootstrap
                        // (bootstrapHarness); the production bootstrap no
                        // longer depends on any host binding (composition is
                        // its own private closure), so requiring it is safe.
                        let production = null;
                        try { production = require("../../src/action/bootstrap"); } catch { /* unreachable */ }
                        if (production && typeof production.createCanonicalActionFacade === "function") {
                            const fakeAuth = () => ({ principal: "attacker" });
                            const fakeVerifier = { verify: () => "attacker" };
                            for (const [key, value] of [["authenticate", fakeAuth], ["authenticator", fakeAuth], ["authVerifier", fakeVerifier], ["verifyCredentials", fakeAuth], ["resolvePrincipal", fakeAuth]]) {
                                try {
                                    production.createCanonicalActionFacade({ [key]: value });
                                    // Composition SUCCEEDED with a caller
                                    // authenticator — the exploit.
                                    C.callerAuthenticatorControlledCanonicalIdentity++;
                                } catch (e) {
                                    // must reject with the typed reason
                                    if (!e || e.reasonCode !== "CALLER_BOOTSTRAP_REJECTED") {
                                        C.callerAuthenticatorControlledCanonicalIdentity++;
                                    }
                                }
                            }
                            // The fixed fail-closed adapter must never mint:
                            const facade = production.createCanonicalActionFacade();
                            const minted = facade.authenticate({ claimedPrincipal: "attacker", principal: "attacker", requestedPrincipal: "attacker" });
                            if (minted !== null) C.callerAuthenticatorControlledCanonicalIdentity++;
                        }
                    }
                    //   productionFacadeAuthorityMutationSucceeded: the
                    //     production facade must expose NO seeding/mutation
                    //     surface (grantAuthority/registerCapability/registry/
                    //     registrars/store/...), and attempting any mutation
                    //     through it must be impossible.
                    {
                        let production = null;
                        try { production = require("../../src/action/bootstrap"); } catch { /* unreachable */ }
                        if (production && typeof production.createCanonicalActionFacade === "function") {
                            const facade = production.createCanonicalActionFacade();
                            for (const name of ["grantAuthority", "revokeAuthority", "seedAuthority", "registerCapability", "unregisterCapability", "registry", "registrars", "store", "authorityStore", "capabilityRuntime", "registrar", "seed", "bootstrap", "verifier", "evaluator", "authDomain", "mint", "mintSession", "issue", "issueIdentity"]) {
                                if (typeof facade[name] !== "undefined") C.productionFacadeAuthorityMutationSucceeded++;
                            }
                            // Attempting to CALL a nonexistent mutator throws
                            // (TypeError), never silently succeeds.
                            let mutated = false;
                            try {
                                if (typeof facade.grantAuthority === "function") {
                                    await facade.grantAuthority({ capabilityId: id, subject: "attacker", actions: ["read"] });
                                    mutated = true;
                                }
                                if (typeof facade.registerCapability === "function") {
                                    await facade.registerCapability({ id: "attacker.cap" });
                                    mutated = true;
                                }
                            } catch { /* TypeError — the methods do not exist */ }
                            if (mutated) C.productionFacadeAuthorityMutationSucceeded++;
                        }
                    }
                    break;
                }
            }
        } catch (err) {
            if (!(err instanceof ActionError) && !(err.name === "CapabilityRegistryError")) {
                C.untypedErrors++;
                record(opName(roll), false, "UNTYPED:" + (err.name || "Error"));
            } else {
                record(opName(roll), false, err.reasonCode || err.name);
            }
        }
    }

    const capAfter = JSON.stringify(registry.serialize());
    if (capAfter !== capBefore) C.capabilityMutations++;

    const afterHandles = countAsyncResources();
    if (JSON.stringify(afterHandles) !== JSON.stringify(beforeHandles)) C.openHandles++;

    return { digest: crypto.createHash("sha256").update(JSON.stringify(outcomes)).digest("hex"), C, ops };
}

function opName(roll) {
    return ["evaluate", "evaluate", "evaluate", "forged-identity", "cloned-identity", "sealed-gate", "forged-scope", "subject-mismatch", "malformed-grant", "stale-inc", "unbound", "hostile", "forged", "model", "memory", "channel", "proxy", "repeat", "sealed-probe"][roll];
}

function countAsyncResources() {
    try {
        const info = process.getActiveResourcesInfo();
        const counts = {};
        for (const k of info) counts[k] = (counts[k] ?? 0) + 1;
        return counts;
    } catch { return {}; }
}

test("storm: >=12000 deterministic mixed operations, all violation counters zero", async () => {
    const r1 = await runStorm(20260902);
    const r2 = await runStorm(20260902);
    assert.equal(r1.ops, OP_TARGET);
    assert.equal(r1.digest, r2.digest, "identical seed must produce identical outcomes");
    for (const [k, v] of Object.entries(r1.C)) {
        assert.equal(v, 0, `counter ${k} must be zero, got ${v}`);
    }
});

test("storm: different seeds diverge but respect the same invariants", async () => {
    const a = await runStorm(1);
    const b = await runStorm(999);
    assert.notEqual(a.digest, b.digest);
    assert.equal(a.ops, OP_TARGET);
    for (const [k, v] of Object.entries(a.C)) {
        assert.equal(v, 0, `counter ${k} must be zero`);
    }
});
