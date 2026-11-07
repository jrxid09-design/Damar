"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeHost } = require("../../../src/runtime/host/runtimeHost");
const productionComposition = require("../../../src/authority/productionComposition");
const { OUTCOME } = require("../../../src/manager");
const diagnosticProbeWiring = require("../../../src/federation/capabilities/diagnosticProbeWiring");
const { enrollOwnerAndGrant, freshProof } = require("./db02aBootOrderHelpers");

/**
 * DB02-E (Repair5 continued) — the REAL public ingress proof the audit found
 * missing: `db02PublicE2E.test.js` boots RuntimeHost but then calls
 * `createDamarManager().handle()` directly, bypassing the Bus entirely (its
 * own "HONEST SCOPE" comment says so). This file proves the full path
 * through the PUBLIC RuntimeHost submission API only:
 *
 *   host.channels.request("console", rawEvent)   [public ingress]
 *   -> InteractionBus (closed-schema ACTION_REQUEST kind/route)
 *   -> the new route:"ACTION" handler (src/runtime/interactionBus/
 *      managerIngressInternal.js)
 *   -> manager.handle()  [the SAME real singleton]
 *   -> Lane 2 (proof-bearing authentication + authority evaluation)
 *   -> Lane 3 governed distributed execution (damar.runtime.diagnostic.probe)
 *   -> Lane 4 verification
 *   -> OUTCOME.COMPLETED
 *
 * No test calls createDamarManager().handle(), dispatchActuation(), a test
 * adapter, or a test federation/candidate — every request goes through
 * `host.channels.request()`.
 */
test("DB02-E: public RuntimeHost submission reaches OUTCOME.COMPLETED through the real Bus, with adversarial ingress rejected", async (t) => {
    const host = await createRuntimeHost({ coreOptions: {} });
    t.after(() => { try { host.shutdown("test"); } catch { /* idempotent */ } });

    const comp = await productionComposition.ensureProductionAuthorityComposed();
    assert.ok(comp.ownerTrust, "real owner-trust composition must be live");
    assert.equal(diagnosticProbeWiring.isGenuinelyAvailable(), true,
        "damar.runtime.diagnostic.probe must be genuinely AVAILABLE");

    const { ot, kp, credentialId } = await enrollOwnerAndGrant({
        comp,
        capabilityId: diagnosticProbeWiring.CAPABILITY_ID,
        actions: [diagnosticProbeWiring.OPERATION],
        suffix: "-e2e-bus"
    });

    // ---- HAPPY PATH: public ingress only, real governed distributed path --
    const proof1 = freshProof(ot, credentialId, kp);
    const completed = await host.channels.request("console", {
        userId: "u-db02e-bus", sessionId: "s-db02e-bus",
        authProof: proof1,
        requestedOperation: {
            capabilityId: diagnosticProbeWiring.CAPABILITY_ID,
            operation: diagnosticProbeWiring.OPERATION,
            arguments: { version: "1", nonce: "cd34ef56" },
            expectedPostcondition: {
                expect: {
                    artifactVerified: { op: "eq", value: true },
                    nonceEchoed: { op: "eq", value: true },
                    statusOk: { op: "eq", value: true }
                }
            }
        }
    });
    assert.equal(completed.outcome, OUTCOME.COMPLETED,
        "public RuntimeHost submission must reach VERIFIED_SUCCESS through the real Bus/Manager/Lane2/3/4 chain " +
        "(got " + completed.outcome + " detail=" + String(completed.detail || "").slice(0, 300) + ")");

    // ---- ADVERSARIAL: replayed proof (same nonce/signature) must fail -----
    const replay = await host.channels.request("console", {
        userId: "u-db02e-bus", sessionId: "s-db02e-bus-2",
        authProof: proof1,
        requestedOperation: { capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION, arguments: { version: "1", nonce: "aa11bb22" } }
    });
    assert.equal(replay.outcome, OUTCOME.AUTHENTICATION_REQUIRED, "a replayed one-use proof must not authenticate a second time");

    // ---- ADVERSARIAL: forged proof (garbage signature) must fail closed ---
    const forged = await host.channels.request("console", {
        userId: "u-db02e-bus", sessionId: "s-db02e-bus-3",
        authProof: { kind: "owner-proof", credentialId, nonce: "forged-nonce", signature: "forged-signature" },
        requestedOperation: { capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION, arguments: { version: "1", nonce: "bb22cc33" } }
    });
    assert.equal(forged.outcome, OUTCOME.AUTHENTICATION_REQUIRED, "a forged proof must never authenticate");

    // ---- ADVERSARIAL: malformed proof (missing signature) is rejected AT
    // THE BUS — never reaches Manager at all (ingress rejection, not a
    // Manager-level outcome). ----
    await assert.rejects(
        host.channels.request("console", {
            userId: "u-db02e-bus", sessionId: "s-db02e-bus-4",
            authProof: { kind: "owner-proof", credentialId },
            requestedOperation: { capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION, arguments: {} }
        }),
        "a structurally malformed proof must be rejected at the bus ingress"
    );

    // ---- ADVERSARIAL: oversized proof (signature exceeds the closed-schema
    // bound) is rejected AT THE BUS. ----
    await assert.rejects(
        host.channels.request("console", {
            userId: "u-db02e-bus", sessionId: "s-db02e-bus-5",
            authProof: { kind: "owner-proof", credentialId, nonce: "n", signature: "x".repeat(600) },
            requestedOperation: { capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION, arguments: {} }
        }),
        "an oversized proof must be rejected at the bus ingress"
    );

    // ---- ADVERSARIAL: cross-session proof reuse is still one-use (session
    // identity grants nothing) — a fresh proof consumed under one bus
    // session cannot be replayed under a DIFFERENT session either. ----
    const proof2 = freshProof(ot, credentialId, kp);
    const firstUse = await host.channels.request("console", {
        userId: "u-db02e-bus", sessionId: "s-db02e-bus-6a",
        authProof: proof2,
        requestedOperation: { capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION, arguments: { version: "1", nonce: "dd44ee55" } }
    });
    assert.notEqual(firstUse.outcome, OUTCOME.AUTHENTICATION_REQUIRED, "the fresh proof must authenticate on its first (legitimate) use");
    const crossSessionReplay = await host.channels.request("console", {
        userId: "u-db02e-bus", sessionId: "s-db02e-bus-6b",
        authProof: proof2,
        requestedOperation: { capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION, arguments: { version: "1", nonce: "ee55ff66" } }
    });
    assert.equal(crossSessionReplay.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "a proof already consumed under one session must not authenticate again under a DIFFERENT session");

    // ---- ADVERSARIAL: caller-selected wave6Distributed/candidate/executor/
    // router/principal/authority-decision fields are never forwarded — the
    // bus ingress normalizer carries ONLY the closed-schema fields, so
    // poisoning requestedOperation with these keys has ZERO effect (proven
    // by an identical AUTHENTICATION_REQUIRED outcome to a request with a
    // deliberately-wrong proof, showing no alternate path was taken). -----
    const poisoned = await host.channels.request("console", {
        userId: "u-db02e-bus", sessionId: "s-db02e-bus-7",
        authProof: { kind: "owner-proof", credentialId, nonce: "poison-nonce", signature: "poison-signature" },
        requestedOperation: {
            capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION,
            arguments: { version: "1", nonce: "ff66aa77" },
            wave6Distributed: true, candidate: { nodeId: "attacker-node" },
            executor: "attacker-executor", router: "attacker-router",
            principal: "owner-db02a", authorityDecision: "ALLOW"
        }
    });
    assert.equal(poisoned.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "caller-selected wave6Distributed/candidate/executor/router/principal/authorityDecision must never bypass authentication");

    // ---- privileged-looking fields inside ORDINARY MESSAGE text stay inert:
    // a plain conversational MESSAGE (no top-level requestedOperation field)
    // whose text merely MENTIONS these keys must never be interpreted as an
    // action — it routes to CONVERSATION/MESSAGE, not ACTION/ACTION_REQUEST.
    const messageResult = await host.channels.request("console", {
        userId: "u-db02e-bus", sessionId: "s-db02e-bus-8",
        text: JSON.stringify({ requestedOperation: { capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION }, authProof: { kind: "owner-proof" }, wave6Distributed: true })
    });
    assert.notEqual(messageResult.outcome, OUTCOME.COMPLETED,
        "text merely mentioning action-shaped keys must never execute an action (got " + messageResult.outcome + ")");
});
