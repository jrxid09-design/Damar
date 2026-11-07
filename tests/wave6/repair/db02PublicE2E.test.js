"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createRuntimeHost } = require("../../../src/runtime/host/runtimeHost");
const { createDamarManager } = require("../../../src/manager/bootstrap");
const productionComposition = require("../../../src/authority/productionComposition");
const ownerTrustComposition = require("../../../src/authority/ownerTrustComposition");
const { CHANNEL_TYPES, OUTCOME } = require("../../../src/manager");
const diagnosticProbeWiring = require("../../../src/federation/capabilities/diagnosticProbeWiring");

/**
 * DB02-A/B (Repair5) — REAL public RuntimeHost boot proves the two closed
 * findings work TOGETHER on the REAL canonical Manager singleton:
 *
 *   DB02-A: Lane 2 evaluates against the SAME store the canonical
 *           AuthorityRegistry writes into (no bridge, no second store).
 *   DB02-B: a genuine one-use Owner proof, forwarded verbatim through the
 *           ManagerRequest schema, authenticates via the EXISTING sealed
 *           verifier (_setOwnerAuthVerifier) — no new token/session
 *           subsystem.
 *
 * DB02-D/E (Repair5, CLOSED): a second section below proves the FULL
 * governed distributed path for the first real production external
 * capability, `damar.runtime.diagnostic.probe` (see
 * src/federation/capabilities/diagnosticProbeWiring.js) — real
 * ExternalCapabilityFederation discover/inspect/validate/enableTool, a
 * real SHA-256-pinned artifact, a real DistributedExecutionRouter route +
 * claimGovernedExecution, the real governed external tool executor + real
 * AppContainer sandbox, and real Lane 4 Verification (independent digest +
 * enablement re-check, never trusting the actuator's self-report) —
 * reaching OUTCOME.COMPLETED (VERIFIED_SUCCESS) through manager.handle()
 * on this SAME real singleton. The mata_dewa capability above still falls
 * back to local Lane 3 (it has no federation-backed external tool; that
 * remains its own honest, separate boundary).
 *
 * AVAILABILITY-GAP (Repair5, CLOSED for MataDewa visual-mode capabilities):
 * previously, Lane 2's evaluateGate always denied CAPABILITY_UNAVAILABLE
 * because `observeAvailability` (the only way to mark a capability AVAILABLE)
 * was never called anywhere in production `src/`. It is now called exactly
 * once, at canonical composition time, for the visual-mode capabilities ONLY
 * (mode.activate/mode.deactivate) — a genuine observation, not a default:
 * these ops have no external dependency, so "wired" IS "available". RF
 * control capabilities are deliberately NOT marked here and stay UNKNOWN
 * (they depend on a real device-trust attach signal that is not yet
 * connected to this registry — a separate, deeper, still-open gap). This
 * test now proves authentication (DB02-B), authority evaluation (DB02-A),
 * AND availability all genuinely succeed on the real singleton, reaching
 * real local execution — not a fixed-up assertion papering over the old gap.
 *
 * HONEST SCOPE (bus ingress): the InteractionBus's only registered route
 * (CONVERSATION/MESSAGE) maps informational text only — it does not forward
 * `requestedOperation`/`authProof` (no planner is wired in production
 * either, so no route derives an action from text). There is today no
 * production BUS route that can carry an action-shaped payload at all; this
 * is a separate, pre-existing gap outside DB-02's scope. Bus -> Manager
 * routing itself is separately proven, unaffected, by the existing R4-05-A /
 * R3-06-A tests. This test therefore calls `manager.handle()` directly — the
 * SAME real singleton instance RuntimeHost boot wires — matching the exact
 * methodology this codebase's own prior repairs already use for this reason
 * (see R4-05-A/B and R3-06-A/B's identical split).
 */
test("DB02-A/B: public RuntimeHost boot + genuine one-use Owner proof reaches Lane2 ALLOW on the REAL canonical Manager singleton (no test grant, no test adapter)", async (t) => {
    // Boot the REAL RuntimeHost. This is what now wires
    // ensureProductionAuthorityComposed() (DB02-A) into this process BEFORE
    // the canonical Manager singleton is ever created.
    const host = await createRuntimeHost({ coreOptions: {} });
    t.after(() => { try { host.shutdown("test"); } catch { /* idempotent */ } });

    const comp = await productionComposition.ensureProductionAuthorityComposed();
    assert.ok(comp.ownerTrust, "real owner-trust composition must be live");
    const ot = comp.ownerTrust;

    // Enroll a genuine Owner (external mode: the test holds the private
    // key) through the REAL first-run ceremony contract — the SAME contract
    // tests/wave6/repair/ownerTrustProvisioning.test.js already proves. No
    // test-only shortcut, no raw ownerIdentity string.
    const kp = crypto.generateKeyPairSync("ed25519");
    if (ot.registry.getState() === "ACTIVE") {
        throw new Error("unexpected: an Owner is already ACTIVE before this file's own enrollment");
    }
    const begin = await ot.firstOwnerBootstrap.begin({
        principalId: "owner-db02e2e", mode: "external",
        publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" })
    });
    const bootstrapPayload = ownerTrustComposition.canonicalChallenge({
        purpose: ownerTrustComposition.BOOTSTRAP_PURPOSE,
        credentialId: begin.challenge.credentialId,
        nonce: begin.challenge.nonce,
        context: ownerTrustComposition.BOOTSTRAP_CONTEXT
    });
    const bootstrapSig = crypto.sign(null, bootstrapPayload, kp.privateKey).toString("base64url");
    const done = await ot.firstOwnerBootstrap.complete({ ceremonyId: begin.ceremonyId, signature: bootstrapSig });
    const credentialId = done.credentialId;
    const ownerPrincipalId = ot.registry.getOwner().principalId;

    // Grant mata_dewa.mode.deactivate (a REAL, production-declared capability
    // — wired at Lane 2 composition time, not an ad-hoc test capability) to
    // the REAL enrolled Owner principal, through the REAL production
    // ratification bridge (genuine proof-verified, not a raw ownerIdentity
    // string). DB02-A: this grant lands in the SAME store Lane 2 now reads.
    const proposalId = "db02-e2e-grant";
    await comp.canonicalOwner.proposeEvolution({
        proposalId, createdBy: "owner", kind: "authority_expansion",
        problem: "db02 public e2e", proposedChange: "grant",
        requestedAuthority: {
            // mata_dewa.mode.deactivate's trusted scope resolver always
            // resolves to [] (visual-mode ops carry no external resource
            // target — see mataDewa/capabilities/visualModeWiring.js). A
            // scoped grant (non-empty scope) can never match an empty
            // request scope (authority/evaluate.js CAP_SCOPE_MISMATCH,
            // fail-closed), so the grant itself must be scope-less here.
            capabilityId: "mata_dewa.mode.deactivate", subject: ownerPrincipalId,
            actions: ["deactivate"], scope: [], maxExecutions: 5
        }
    }, "owner");
    const ratifyChallenge = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const ratifySig = crypto.sign(null, ownerTrustComposition.canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: ratifyChallenge.nonce, context: ratifyChallenge.context
    }), kp.privateKey).toString("base64url");
    const ratified = await comp.ratifyAsOwner({
        proof: { credentialId, nonce: ratifyChallenge.nonce, signature: ratifySig },
        ratification: { ratificationId: "db02-e2e-rat", proposalId, decision: "APPROVED" }
    });
    assert.equal(ratified.applied, true, "genuine owner ratification must apply: " + JSON.stringify(ratified));
    const issued = await comp.provisionAuthority({ proposalId, ratificationId: "db02-e2e-rat" });
    assert.equal(issued.allowed, true, "owner-ratified grant must mint: " + JSON.stringify(issued));

    // Sign a FRESH, single-use proof for THIS Manager request specifically
    // (a proof is consumed once — PROOF != BEARER AUTHORITY; no session or
    // token is minted or reused).
    const requestChallenge = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const requestSig = crypto.sign(null, ownerTrustComposition.canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: requestChallenge.nonce, context: requestChallenge.context
    }), kp.privateKey).toString("base64url");

    // The REAL canonical Manager singleton — the SAME instance RuntimeHost
    // boot wired above (createDamarManager() is a memoized singleton).
    const manager = createDamarManager();
    const r = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02e2e",
        correlationId: "corr-db02e2e", receivedAtMs: Date.now(),
        // DB02-B: the ONLY new field. Opaque to Manager; verified entirely by
        // Lane 2's own sealed verifier.
        authProof: { kind: "owner-proof", credentialId, nonce: requestChallenge.nonce, signature: requestSig },
        requestedOperation: {
            capabilityId: "mata_dewa.mode.deactivate", operation: "deactivate", arguments: {}
        }
    });

    // DB02-B proof: authentication itself must succeed on the REAL
    // singleton — the genuine one-use proof, forwarded verbatim through
    // ManagerRequest, must reach and satisfy the sealed verifier.
    assert.notEqual(r.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "a genuine one-use Owner proof must authenticate (got " + r.outcome + " detail=" + String(r.detail || "").slice(0, 200) + ")");
    // AVAILABILITY-GAP CLOSED: authentication, authority evaluation, AND
    // availability all now genuinely succeed on the real singleton, so
    // Lane2 reaches ALLOW and the Manager actually dispatches execution.
    // DB02-D remains open (no production Federation-enabled external tool
    // exists yet), so dispatch correctly falls back to LOCAL Lane 3 — the
    // real mata_dewa.mode.deactivate actuator. In THIS test process no real
    // MataDewaService is composed, so the actuator fails closed
    // (MATA_DEWA_SERVICE_UNAVAILABLE) and Lane 4 cannot observe a postcondition,
    // giving the honest EXECUTED_UNVERIFIED outcome — not a hidden failure,
    // not a fabricated success.
    assert.equal(r.outcome, OUTCOME.EXECUTED_UNVERIFIED,
        "expected local execution to be attempted (availability + authority genuinely passed) but left unverified " +
        "(no real MataDewaService composed in this test process) (got " + r.outcome + " detail=" + String(r.detail || "").slice(0, 200) + ")");
    console.log("DB02-A/B public E2E outcome:", r.outcome, "detail:", String(r.detail || "").slice(0, 200),
        "(authentication + authority + availability all succeeded; local execution ran and is honestly unverified)");

    // ------------------------------------------------------------------
    // DB02-D/E (Repair5): the SAME real RuntimeHost/Manager singleton now
    // proves the FULL governed distributed path for the first real
    // production external capability (damar.runtime.diagnostic.probe):
    //   capability AVAILABLE (real federation ENABLED observation) ->
    //   canonical capability resolution -> distributed route ->
    //   ExecutionLease -> claimGovernedExecution -> governed external
    //   executor -> real AppContainer sandbox -> Lane 4 Verification
    //   (independent digest + enablement re-check + echo contract) ->
    //   VERIFIED_SUCCESS Manager response. No test-only registry, no
    //   test-only federation, no direct dispatchActuation bypass: this
    //   request goes through manager.handle() exactly like DB02-A/B above.
    // ------------------------------------------------------------------
    assert.equal(diagnosticProbeWiring.isGenuinelyAvailable(), true,
        "damar.runtime.diagnostic.probe must be genuinely AVAILABLE (real federation ENABLED observation)");

    // Grant #1: principal-level Lane 2 authority (Owner -> the enrolled
    // Owner principal). The probe's trusted scope resolver is [] (no
    // external resource target), so the grant itself must be scope-less.
    const probePrincipalProposalId = "db02-e2e-probe-principal-grant";
    await comp.canonicalOwner.proposeEvolution({
        proposalId: probePrincipalProposalId, createdBy: "owner", kind: "authority_expansion",
        problem: "db02 probe e2e (principal)", proposedChange: "grant",
        requestedAuthority: {
            capabilityId: diagnosticProbeWiring.CAPABILITY_ID, subject: ownerPrincipalId,
            actions: [diagnosticProbeWiring.OPERATION], scope: [], maxExecutions: 5
        }
    }, "owner");
    const probePrincipalRatifyChallenge = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const probePrincipalRatifySig = crypto.sign(null, ownerTrustComposition.canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: probePrincipalRatifyChallenge.nonce, context: probePrincipalRatifyChallenge.context
    }), kp.privateKey).toString("base64url");
    const probePrincipalRatified = await comp.ratifyAsOwner({
        proof: { credentialId, nonce: probePrincipalRatifyChallenge.nonce, signature: probePrincipalRatifySig },
        ratification: { ratificationId: "db02-e2e-probe-principal-rat", proposalId: probePrincipalProposalId, decision: "APPROVED" }
    });
    assert.equal(probePrincipalRatified.applied, true, "principal-level probe grant must apply: " + JSON.stringify(probePrincipalRatified));
    const probePrincipalIssued = await comp.provisionAuthority({ proposalId: probePrincipalProposalId, ratificationId: "db02-e2e-probe-principal-rat" });
    assert.equal(probePrincipalIssued.allowed, true, "principal-level probe grant must mint: " + JSON.stringify(probePrincipalIssued));

    // NOTE: the canonical AuthorityRegistry store holds exactly ONE ACTIVE
    // grant record per capabilityId (issueRatifiedRootGrant is a singleton
    // write keyed by capabilityId — a second grant for the SAME
    // capabilityId is rejected CAP_MALFORMED "already ACTIVE"). The
    // DistributedExecutionRouter's authorityBridge therefore evaluates
    // using the SAME already-authenticated Lane 2 principal as the subject
    // (see diagnosticProbeWiring.js wireActuator: `subject: principal`,
    // never a hardcoded system identity) — ONE unscoped (scope: [])
    // Owner-ratified grant genuinely covers both the Lane 2 gate and the
    // router/claim gate (an empty grant scope is unscoped: it matches any
    // requested scope, see src/authority/evaluate.js lines 247-255).

    // A FRESH one-use proof for the probe request.
    const probeRequestChallenge = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const probeRequestSig = crypto.sign(null, ownerTrustComposition.canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: probeRequestChallenge.nonce, context: probeRequestChallenge.context
    }), kp.privateKey).toString("base64url");

    const probeResult = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02e2e-probe",
        correlationId: "corr-db02e2e-probe", receivedAtMs: Date.now(),
        authProof: { kind: "owner-proof", credentialId, nonce: probeRequestChallenge.nonce, signature: probeRequestSig },
        requestedOperation: {
            capabilityId: diagnosticProbeWiring.CAPABILITY_ID, operation: diagnosticProbeWiring.OPERATION,
            arguments: { version: "1", nonce: "ab12ef34" },
            expectedPostcondition: {
                expect: {
                    artifactVerified: { op: "eq", value: true },
                    nonceEchoed: { op: "eq", value: true },
                    statusOk: { op: "eq", value: true }
                }
            }
        }
    });
    assert.equal(probeResult.outcome, OUTCOME.COMPLETED,
        "the diagnostic probe must reach VERIFIED_SUCCESS through the REAL governed distributed path " +
        "(got " + probeResult.outcome + " detail=" + String(probeResult.detail || "").slice(0, 300) + ")");
    console.log("DB02-D/E public E2E outcome:", probeResult.outcome, "detail:", String(probeResult.detail || "").slice(0, 200));

    // A REPLAYED proof (same nonce/signature reused) must fail — one-use.
    const replay = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02e2e-2",
        correlationId: "corr-db02e2e-2", receivedAtMs: Date.now(),
        authProof: { kind: "owner-proof", credentialId, nonce: requestChallenge.nonce, signature: requestSig },
        requestedOperation: { capabilityId: "mata_dewa.mode.deactivate", operation: "deactivate", arguments: {} }
    });
    assert.equal(replay.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "a replayed one-use proof must NOT authenticate a second time");

    // A FORGED proof (garbage signature) must fail closed, never authenticate.
    const forged = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02e2e-3",
        correlationId: "corr-db02e2e-3", receivedAtMs: Date.now(),
        authProof: { kind: "owner-proof", credentialId, nonce: "forged-nonce", signature: "forged-signature" },
        requestedOperation: { capabilityId: "mata_dewa.mode.deactivate", operation: "deactivate", arguments: {} }
    });
    assert.equal(forged.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "a forged proof must never authenticate");
});
