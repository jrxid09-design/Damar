"use strict";

/**
 * MD-011 — PRODUCTION WIRING PROOF + adversarial matrix.
 *
 * Bukti wajib:
 *  1. createCanonicalActionFacade() MELIHAT mata_dewa.mode.activate/deactivate
 *     (admit TIDAK CAPABILITY_NOT_FOUND) dengan scope binding kanonik [].
 *  2. Identitas palsu / sesi palsu tetap gagal tertutup (evaluate DENY,
 *     authority-shaped field di intent DITOLAK).
 *  3. Actuator + capability dipasang oleh KODE WIRING PRODUKSI
 *     (visualModeWiring), BUKAN duplikasi test glue — diuji E2E lewat
 *     komposisi Manager produksi dengan auth uji.
 *  4. Negative: perintah UI arbitrer, JS arbitrer, inkarnasi capability
 *     palsu, registry/runtime asing, service kanonik hilang — semua aman.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const bootstrap = require("../../src/action/bootstrap");
const {
    MATA_DEWA_MODE_ACTIVATE, MATA_DEWA_MODE_DEACTIVATE,
    VISUAL_MODE_SCOPE_BINDINGS, wireMataDewaVisualModeCapabilities,
    wireMataDewaVisualModeActuators
} = require("../../src/mataDewa/capabilities/visualModeWiring");
const { MATA_DEWA_SERVICE_UNAVAILABLE } = require("../../src/mataDewa/capabilities/uiModeActuator");
const { MataDewaService } = require("../../src/mataDewa/service");
const { makeActuationHarness } = require("../actuation/harness");
const { makeHarness } = require("../action/bootstrapHarness");

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 1. PRODUCTION ACTION FACADE — capability visibility + canonical scope
// ---------------------------------------------------------------------------

test("MD-011 production: canonical facade admits mata_dewa.mode.activate (no CAPABILITY_NOT_FOUND, canonical scope [])", () => {
    const facade = bootstrap.createCanonicalActionFacade();
    const intent = facade.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: MATA_DEWA_MODE_ACTIVATE,
        operation: "activate", arguments: {}
    }));
    assert.equal(intent.capabilityId, MATA_DEWA_MODE_ACTIVATE);
    assert.equal(intent.operation, "activate");
    assert.deepEqual([...intent.scope], []);
    assert.match(intent.capabilityIncarnationId, /^inc-[0-9a-f]{32}$/);
});

test("MD-011 production: canonical facade admits deactivate with canonical scope []", () => {
    const facade = bootstrap.createCanonicalActionFacade();
    const intent = facade.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: MATA_DEWA_MODE_DEACTIVATE,
        operation: "deactivate", arguments: {}
    }));
    assert.deepEqual([...intent.scope], []);
});

test("MD-011 production: scope binding uses the ACTUAL canonical resolver (not caller-supplied scope)", () => {
    // intent field 'scope' is authority-shaped and rejected at parse time —
    // the caller can NEVER inject a scope; only the canonical binding counts.
    const facade = bootstrap.createCanonicalActionFacade();
    assert.throws(() => facade.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: MATA_DEWA_MODE_ACTIVATE,
        operation: "activate", arguments: {}, scope: ["filesystem.write"]
    })), /authority-shaped|scope/i);
    assert.throws(() => facade.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: MATA_DEWA_MODE_ACTIVATE,
        operation: "activate", arguments: {}, subject: "owner"
    })), /authority-shaped|subject/i);
});

test("MD-011 production: unknown Mata Dewa capability id still fails closed", () => {
    const facade = bootstrap.createCanonicalActionFacade();
    assert.throws(() => facade.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: "mata_dewa.mode.self_grant_root",
        operation: "activate", arguments: {}
    })), /no such capability|CAPABILITY_NOT_FOUND/i);
});

test("MD-011 production: forged session fails closed at canonical evaluate", async () => {
    const facade = bootstrap.createCanonicalActionFacade();
    const intent = facade.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: MATA_DEWA_MODE_ACTIVATE,
        operation: "activate", arguments: {}
    }));
    const verdict = await facade.evaluate(intent, { principal: "owner", sessionId: "forged" });
    assert.equal(verdict.decision, "DENY");
    assert.equal(verdict.reasonCode, "INVALID_IDENTITY");
});

test("MD-011 production: canonical session() still fails closed (pre-Lane4 fail-closed auth)", () => {
    const facade = bootstrap.createCanonicalActionFacade();
    assert.throws(() => facade.session(), /AUTH|fail/i);
});

// ---------------------------------------------------------------------------
// 2. WIRING MODULE — capability installation from production code (harness)
// ---------------------------------------------------------------------------

test("MD-011 wiring: production wiring module installs capabilities into a canonical-style registrar", async () => {
    const harness = await makeHarness({
        scopeBindings: VISUAL_MODE_SCOPE_BINDINGS,
        authenticate: (evidence) =>
            evidence && typeof evidence.sessionId === "string" && evidence.sessionId.startsWith("ses_owner")
                ? { principal: "owner" } : null
    });
    const wiring = wireMataDewaVisualModeCapabilities({ registrar: harness.registrars.core });
    assert.match(wiring.activate.incarnationId, /^inc-[0-9a-f]{32}$/);
    assert.match(wiring.deactivate.incarnationId, /^inc-[0-9a-f]{32}$/);
    // Incarnations are DISTINCT lifetime identities.
    assert.notEqual(wiring.activate.incarnationId, wiring.deactivate.incarnationId);
    // admit through the SAME registry resolves the exact incarnation.
    const intent = harness.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: MATA_DEWA_MODE_ACTIVATE,
        operation: "activate", arguments: {}
    }));
    assert.equal(intent.capabilityIncarnationId, wiring.activate.incarnationId);
    assert.deepEqual([...intent.scope], []);
});

test("MD-011 wiring: idempotent re-registration returns the SAME incarnation (no bridge across registries)", async () => {
    const harness = await makeHarness({ scopeBindings: VISUAL_MODE_SCOPE_BINDINGS });
    const w1 = wireMataDewaVisualModeCapabilities({ registrar: harness.registrars.core });
    const w2 = wireMataDewaVisualModeCapabilities({ registrar: harness.registrars.core });
    assert.equal(w1.activate.incarnationId, w2.activate.incarnationId);
    // A DIFFERENT registry (fresh runtime) mints DIFFERENT incarnations —
    // Registry A incarnations are never consumable by Registry B actuation.
    const harnessB = await makeHarness({ scopeBindings: VISUAL_MODE_SCOPE_BINDINGS });
    const wb = wireMataDewaVisualModeCapabilities({ registrar: harnessB.registrars.core });
    assert.notEqual(w1.activate.incarnationId, wb.activate.incarnationId);
});

// ---------------------------------------------------------------------------
// 3. ACTUATOR — lazy service resolution, fail closed, negatives
// ---------------------------------------------------------------------------

function fakeRegistry() {
    const bindings = [];
    return {
        bindings,
        register(input) { bindings.push(input); return { ...input }; }
    };
}

test("MD-011 actuator: production wiring registers BOTH visual-mode actuators", () => {
    const wiring = {
        activate: { id: MATA_DEWA_MODE_ACTIVATE, incarnationId: `inc-${"a".repeat(32)}` },
        deactivate: { id: MATA_DEWA_MODE_DEACTIVATE, incarnationId: `inc-${"b".repeat(32)}` }
    };
    // Incarnation ids must be valid canonical grammar for the real registry;
    // use the harness registry to prove binding acceptance.
    return (async () => {
        const harness = await makeActuationHarness({ scopeBindings: VISUAL_MODE_SCOPE_BINDINGS });
        const bindings = wireMataDewaVisualModeActuators({
            actuatorRegistry: { register: harness.registerActuator },
            wiring: {
                activate: { id: MATA_DEWA_MODE_ACTIVATE, incarnationId: wiring.activate.incarnationId.replace(/a/g, "0") },
                deactivate: { id: MATA_DEWA_MODE_DEACTIVATE, incarnationId: wiring.deactivate.incarnationId.replace(/b/g, "1") }
            },
            resolveService: () => null // absent service — proven fail-closed below
        });
        assert.equal(bindings.length, 2);
    })();
});

test("MD-011 actuator: missing canonical service fails closed MATA_DEWA_SERVICE_UNAVAILABLE", async () => {
    const { registerMataDewaUiModeActuator } = require("../../src/mataDewa/capabilities/uiModeActuator");
    let resolveCount = 0;
    const binding = registerMataDewaUiModeActuator({
        actuatorRegistry: fakeRegistry(),
        capabilityId: MATA_DEWA_MODE_ACTIVATE,
        capabilityIncarnationId: `inc-${"0".repeat(32)}`,
        resolveService: () => { resolveCount += 1; return null; }
    });
    const outcome = await binding.invoke({});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, MATA_DEWA_SERVICE_UNAVAILABLE);
    assert.equal(resolveCount, 1, "resolver consulted lazily at invoke time");
});

test("MD-011 actuator: resolver throwing fails closed (no crash)", async () => {
    const { registerMataDewaUiModeActuator } = require("../../src/mataDewa/capabilities/uiModeActuator");
    const binding = registerMataDewaUiModeActuator({
        actuatorRegistry: fakeRegistry(),
        capabilityId: MATA_DEWA_MODE_ACTIVATE,
        capabilityIncarnationId: `inc-${"0".repeat(32)}`,
        resolveService: () => { throw new Error("composition ordering"); }
    });
    const outcome = await binding.invoke({});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, MATA_DEWA_SERVICE_UNAVAILABLE);
});

test("MD-011 actuator: service without canonical setUiMode shape fails closed", async () => {
    const { registerMataDewaUiModeActuator } = require("../../src/mataDewa/capabilities/uiModeActuator");
    const binding = registerMataDewaUiModeActuator({
        actuatorRegistry: fakeRegistry(),
        capabilityId: MATA_DEWA_MODE_ACTIVATE,
        capabilityIncarnationId: `inc-${"0".repeat(32)}`,
        resolveService: () => ({ nope: true })
    });
    const outcome = await binding.invoke({});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, MATA_DEWA_SERVICE_UNAVAILABLE);
});

test("MD-011 actuator: happy path through the production wiring with real service + telemetry delivery", async () => {
    const events = [];
    const telemetry = { publish(type, payload) { events.push({ type, payload }); return { id: events.length }; } };
    const service = new MataDewaService({ clock: { nowMs: () => NOW }, telemetry });
    const { registerMataDewaUiModeActuator } = require("../../src/mataDewa/capabilities/uiModeActuator");
    const binding = registerMataDewaUiModeActuator({
        actuatorRegistry: fakeRegistry(),
        capabilityId: MATA_DEWA_MODE_ACTIVATE,
        capabilityIncarnationId: `inc-${"0".repeat(32)}`,
        resolveService: () => service
    });
    const outcome = await binding.invoke({ parameters: {} });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.uiMode, "MATA_DEWA");
    assert.equal(outcome.delivered, true);
    // ui.mode.set published by the SERVICE on the existing telemetry stream —
    // no second publisher (A6): exactly one command event.
    const cmds = events.filter(e => e.type === "damar:ui-command");
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].payload.command, "ui.mode.set");
    assert.deepEqual(cmds[0].payload.args, { mode: "mata-dewa" });
});

test("MD-011 actuator: deactivate + activate again (repeat cycles safe)", async () => {
    const service = new MataDewaService({ clock: { nowMs: () => NOW } });
    const { registerMataDewaUiModeActuator } = require("../../src/mataDewa/capabilities/uiModeActuator");
    const act = registerMataDewaUiModeActuator({
        actuatorRegistry: fakeRegistry(), capabilityId: MATA_DEWA_MODE_ACTIVATE,
        capabilityIncarnationId: `inc-${"0".repeat(32)}`, resolveService: () => service
    });
    const deact = registerMataDewaUiModeActuator({
        actuatorRegistry: fakeRegistry(), capabilityId: MATA_DEWA_MODE_DEACTIVATE,
        capabilityIncarnationId: `inc-${"1".repeat(32)}`, resolveService: () => service
    });
    assert.equal((await act.invoke({})).uiMode, "MATA_DEWA");
    assert.equal((await act.invoke({})).uiMode, "MATA_DEWA"); // activate again
    assert.equal((await deact.invoke({})).uiMode, "NORMAL");
    assert.equal((await deact.invoke({})).uiMode, "NORMAL"); // deactivate again
});

test("MD-011 actuator: arbitrary JS / unknown UI command / mismatched mode rejected", async () => {
    const service = new MataDewaService({ clock: { nowMs: () => NOW } });
    const { registerMataDewaUiModeActuator } = require("../../src/mataDewa/capabilities/uiModeActuator");
    const binding = registerMataDewaUiModeActuator({
        actuatorRegistry: fakeRegistry(), capabilityId: MATA_DEWA_MODE_ACTIVATE,
        capabilityIncarnationId: `inc-${"0".repeat(32)}`, resolveService: () => service
    });
    // parameters.mode must MATCH the operation's fixed target — an arbitrary
    // UI command injection ("mode": anything else) is rejected.
    const hostile = await binding.invoke({ parameters: { mode: "hacked" } });
    assert.equal(hostile.ok, false);
    // The actuator never evaluates code — arbitrary JS in parameters is just
    // a mismatched value, never executed.
    const js = await binding.invoke({ parameters: { mode: "process.exit(1)" } });
    assert.equal(js.ok, false);
    // Service-level unknown UI mode rejected by the canonical service itself.
    assert.equal(service.setUiMode("SOMETHING_ELSE").ok, false);
});

// ---------------------------------------------------------------------------
// 4. E2E — Manager → Authority → Actuation → MataDewaService → telemetry
//    (capability + actuator installation from PRODUCTION wiring code)
// ---------------------------------------------------------------------------

test("MD-011 E2E: Manager production composition executes Mata Dewa mode change via production wiring (trusted test principal)", async () => {
    const events = [];
    const telemetry = { publish(type, payload) { events.push({ type, payload }); return { id: events.length }; } };
    const service = new MataDewaService({ clock: { nowMs: () => NOW }, telemetry });

    // Authority + actuation via the TEST trust domain, but capability and
    // actuator installation via the PRODUCTION wiring module (A9 mandate).
    const lane3 = await makeActuationHarness({
        scopeBindings: VISUAL_MODE_SCOPE_BINDINGS,
        authenticate: (evidence) =>
            evidence && typeof evidence.sessionId === "string" && evidence.sessionId.startsWith("ses_owner")
                ? { principal: "owner" } : null
    });
    const wiring = wireMataDewaVisualModeCapabilities({ registrar: lane3.lane2.registrars.core });
    for (const [capabilityId, op] of [
        [MATA_DEWA_MODE_ACTIVATE, "activate"], [MATA_DEWA_MODE_DEACTIVATE, "deactivate"]
    ]) {
        const incarnationId = wiring[op].incarnationId;
        await lane3.lane2.registry.observeAvailability(capabilityId, "AVAILABLE",
            { generation: 1, incarnationId });
        await lane3.lane2.grantAuthority({
            capabilityId, subject: "owner", actions: [op],
            identityBinding: { principals: ["owner"] }
        });
    }
    wireMataDewaVisualModeActuators({
        actuatorRegistry: { register: lane3.registerActuator },
        wiring,
        resolveService: () => service
    });

    const { createDamarManagerComposition } = require("../../src/manager/internal/managerBootstrap");
    const { createMediaContextAuthority } = require("../../src/manager/internal/mediaContext");
    const { CHANNEL_ADAPTERS } = require("../../src/manager/channels");
    const { VERIFICATION_STATE } = require("../../src/action/verification/errors");
    const ib = require("../../src/runtime/interactionBus");
    const { createManagerInteractionIngress } = require("../../src/runtime/interactionBus/managerIngressInternal");

    const mediaContextAuthority = createMediaContextAuthority();
    const manager = createDamarManagerComposition({
        mediaContextAuthority,
        deps: {
            lane2: {
                admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate,
                authenticate: lane3.lane2.authDomain.authenticate, session: lane3.lane2.session
            },
            lane3: { execute: lane3.execute },
            lane4: {
                verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v-md11" }),
                compensate: async () => ({})
            },
            planner: async ({ request }) => {
                const text = String(request?.payload?.text ?? "").toLowerCase();
                if (text.includes("mata dewa") && (text.includes("aktifkan") || text.includes("buka"))) {
                    return { actionProposal: { capabilityId: MATA_DEWA_MODE_ACTIVATE, operation: "activate", arguments: {} } };
                }
                if (text.includes("kembali") || (text.includes("matikan") && text.includes("mata dewa"))) {
                    return { actionProposal: { capabilityId: MATA_DEWA_MODE_DEACTIVATE, operation: "deactivate", arguments: {} } };
                }
                return null;
            }
        },
        trustedChannelAdapters: CHANNEL_ADAPTERS.slice()
    });
    const bus = ib.createInteractionBus({ clock: () => NOW, idFactory: ib.createSequentialIdFactory() });
    const ingress = createManagerInteractionIngress({ bus, manager, mediaContextMint: mediaContextAuthority.mint });

    // activate → activate → deactivate → deactivate (repeat cycles safe).
    for (const [text, capabilityId, operation, expectedMode] of [
        ["Damar, aktifkan mode Mata Dewa", MATA_DEWA_MODE_ACTIVATE, "activate", "MATA_DEWA"],
        ["Damar, aktifkan mode Mata Dewa", MATA_DEWA_MODE_ACTIVATE, "activate", "MATA_DEWA"],
        ["Damar, kembali", MATA_DEWA_MODE_DEACTIVATE, "deactivate", "NORMAL"],
        ["Damar, matikan mata dewa", MATA_DEWA_MODE_DEACTIVATE, "deactivate", "NORMAL"]
    ]) {
        const result = await manager.handle({
            channelType: "voice", channelId: "channel.voice",
            sessionId: "ses_owner_voice", correlationId: `corr-md11-${operation}-${expectedMode}`,
            receivedAtMs: NOW, payload: { text },
            // Deklaratif intent seam (post-STT): teks saja = advisory
            // (MODEL OUTPUT != AUTHORITY); eksekusi lewat requestedOperation.
            requestedOperation: { capabilityId, operation, arguments: {} }
        });
        assert.equal(result.outcome, "COMPLETED", `${text}: ${result.detail ?? ""}`);
        assert.equal(service.uiMode, expectedMode);
    }
    // Four canonical ui.mode.set deliveries on the EXISTING telemetry stream.
    const cmds = events.filter(e => e.type === "damar:ui-command");
    assert.equal(cmds.length, 4);
    assert.deepEqual(cmds.map(c => c.payload.args.mode),
        ["mata-dewa", "mata-dewa", "normal", "normal"]);

    // Renderer allowlist mirror accepts exactly the canonical commands.
    const renderer = await import("../../apps/console/renderer/views/mataDewa/uiCommands.js");
    const applied = renderer.applyUiCommandEvent(cmds[0].payload, { navigate: () => {} });
    assert.equal(applied.ok, true);
    assert.equal(applied.mode, "mata-dewa");
});

test("MD-011 E2E: forged identity in the same composition fails closed (no delivery)", async () => {
    const events = [];
    const telemetry = { publish(type, payload) { events.push({ type, payload }); return { id: events.length }; } };
    const service = new MataDewaService({ clock: { nowMs: () => NOW }, telemetry });

    const lane3 = await makeActuationHarness({
        scopeBindings: VISUAL_MODE_SCOPE_BINDINGS,
        authenticate: (evidence) =>
            evidence && typeof evidence.sessionId === "string" && evidence.sessionId.startsWith("ses_owner")
                ? { principal: "owner" } : null
    });
    const wiring = wireMataDewaVisualModeCapabilities({ registrar: lane3.lane2.registrars.core });
    for (const [capabilityId, op] of [
        [MATA_DEWA_MODE_ACTIVATE, "activate"], [MATA_DEWA_MODE_DEACTIVATE, "deactivate"]
    ]) {
        await lane3.lane2.registry.observeAvailability(capabilityId, "AVAILABLE",
            { generation: 1, incarnationId: wiring[op].incarnationId });
        await lane3.lane2.grantAuthority({
            capabilityId, subject: "owner", actions: [op],
            identityBinding: { principals: ["owner"] }
        });
    }
    wireMataDewaVisualModeActuators({
        actuatorRegistry: { register: lane3.registerActuator },
        wiring, resolveService: () => service
    });

    const { createDamarManagerComposition } = require("../../src/manager/internal/managerBootstrap");
    const { createMediaContextAuthority } = require("../../src/manager/internal/mediaContext");
    const { CHANNEL_ADAPTERS } = require("../../src/manager/channels");
    const { VERIFICATION_STATE } = require("../../src/action/verification/errors");

    const manager = createDamarManagerComposition({
        mediaContextAuthority: createMediaContextAuthority(),
        deps: {
            lane2: {
                admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate,
                authenticate: lane3.lane2.authDomain.authenticate, session: lane3.lane2.session
            },
            lane3: { execute: lane3.execute },
            lane4: {
                verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v-md11x" }),
                compensate: async () => ({})
            },
            planner: async () => ({ actionProposal: { capabilityId: MATA_DEWA_MODE_ACTIVATE, operation: "activate", arguments: {} } })
        },
        trustedChannelAdapters: CHANNEL_ADAPTERS.slice()
    });

    // Forged principal (ses_attacker does not map to owner) → denied.
    const result = await manager.handle({
        channelType: "voice", channelId: "channel.voice",
        sessionId: "ses_attacker", correlationId: "corr-md11-forge",
        receivedAtMs: NOW, payload: { text: "Damar, aktifkan mode Mata Dewa" },
        requestedOperation: undefined
    });
    assert.notEqual(result.outcome, "COMPLETED");
    assert.equal(service.uiMode, "NORMAL");
    assert.equal(events.filter(e => e.type === "damar:ui-command").length, 0);
});

test("MD-011 E2E: forged capability incarnation cannot execute (cross-registry misuse rejected)", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: VISUAL_MODE_SCOPE_BINDINGS });
    const wiring = wireMataDewaVisualModeCapabilities({ registrar: lane3.lane2.registrars.core });
    // A DIFFERENT registry's incarnation (mimicking Registry B) must not
    // satisfy Registry A's admission → admit binds the CURRENT incarnation
    // only; an intent carrying a foreign incarnation is denied at evaluate.
    const foreignIncarnation = `inc-${"f".repeat(32)}`;
    assert.notEqual(wiring.activate.incarnationId, foreignIncarnation);
    const intent = lane3.lane2.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: MATA_DEWA_MODE_ACTIVATE,
        operation: "activate", arguments: {}
    }));
    assert.equal(intent.capabilityIncarnationId, wiring.activate.incarnationId);
    const session = lane3.lane2.session("owner", { sessionId: "ses_owner_1" });
    const tampered = { ...intent, capabilityIncarnationId: foreignIncarnation };
    const verdict = await lane3.lane2.evaluate(tampered, session);
    assert.equal(verdict.decision, "DENY");
    assert.match(verdict.reasonCode ?? "", /INCARNATION|IDENTITY/i);
});

// ---------------------------------------------------------------------------
// 5. WIRING FAILURE — composition misconfiguration is LOUD
// ---------------------------------------------------------------------------

test("MD-011 wiring failure: broken registrar → loud MATA_DEWA_WIRING_FAILED (not silent)", () => {
    assert.throws(() => wireMataDewaVisualModeCapabilities({ registrar: null }),
        /MATA_DEWA_WIRING_INVALID|MATA_DEWA_WIRING_FAILED|wajib/i);
    assert.throws(() => wireMataDewaVisualModeCapabilities({ registrar: { register: () => ({}) } }),
        /MATA_DEWA_WIRING_FAILED/);
});

test("MD-011 wiring: service unavailability never crashes composition (lazy only)", () => {
    // The canonical resolver returns null gracefully when Mata Dewa is not
    // composed — proven by the production facade composing WITHOUT a service.
    const facade = bootstrap.createCanonicalActionFacade();
    assert.ok(typeof facade.admit === "function");
});
