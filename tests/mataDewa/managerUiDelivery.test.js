"use strict";

/**
 * Sertifikasi MD-001 — END-TO-END: kanonik request → InteractionBus →
 * Manager (komposisi PRODUKSI, autentikasi uji) → Mata Dewa capability →
 * delivery perintah UI → renderer (allowlist) → UI berubah.
 *
 * Produksi: Manager gagal tertutup pada autentikasi sampai Lane 4 —
 * jalur ini dibuktikan utuh dengan komposisi produksi + auth uji, dan
 * seam delivery-nya identik dengan yang dipakai produksi.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");
const { createManagerInteractionIngress } = require("../../src/runtime/interactionBus/managerIngressInternal");
const { createMediaContextAuthority } = require("../../src/manager/internal/mediaContext");
const { createDamarManagerComposition } = require("../../src/manager/internal/managerBootstrap");
const { CHANNEL_ADAPTERS } = require("../../src/manager/channels");
const { VERIFICATION_STATE } = require("../../src/action/verification/errors");
const { makeActuationHarness } = require("../actuation/harness");
const { MataDewaService, UI_MODE } = require("../../src/mataDewa/service");
const { registerMataDewaUiModeActuator } = require("../../src/mataDewa/capabilities/uiModeActuator");
const { validateUiCommand, UI_COMMANDS } = require("../../src/mataDewa/uiCommands");

const CAP_ID_ACTIVATE = "mata_dewa.mode.activate";
const CAP_ID_DEACTIVATE = "mata_dewa.mode.deactivate";

/** Modul renderer (ESM) — dimuat sekali untuk file tes ini. */
let rendererModule = null;
async function rendererCmds() {
    if (!rendererModule) {
        rendererModule = await import("../../apps/console/renderer/views/mataDewa/uiCommands.js");
    }
    return rendererModule;
}

/** Renderer module ESM — dimuat sekali untuk semua tes di file ini. */
let renderer = null;
async function rendererCmds() {
    if (!renderer) {
        renderer = await import("../../apps/console/renderer/views/mataDewa/uiCommands.js");
    }
    return renderer;
}

function makeFakeTelemetry() {
    const events = [];
    let seq = 0;
    return {
        events,
        publish(type, payload) {
            const event = { id: ++seq, type, payload };
            events.push(event);
            return event;
        }
    };
}

/** Harness komposisi Manager produksi + auth uji + capability Mata Dewa. */
async function makeE2eHarness() {
    const telemetry = makeFakeTelemetry();
    // Service dengan publisher terpasang — konfigurasi yang SAMA dengan
    // produksi (server.js mem-passing telemetry Damar).
    const service = new MataDewaService({ clock: { nowMs: () => 1_700_000_000_000 }, telemetry });

    const lane3 = await makeActuationHarness({
        scopeBindings: {
            [CAP_ID_ACTIVATE]: { activate: () => [] },
            [CAP_ID_DEACTIVATE]: { deactivate: () => [] }
        },
        authenticate: (evidence) => {
            // Trusted infra binding: sesi uji "ses_owner" → principal pemilik.
            if (evidence && typeof evidence.sessionId === "string" && evidence.sessionId.startsWith("ses_owner")) {
                return { principal: "owner" };
            }
            return null; // fail closed
        }
    });

    const capActivate = await lane3.lane2.registerCapability({
        id: CAP_ID_ACTIVATE, operations: ["activate"]
    });
    await lane3.lane2.registry.observeAvailability(CAP_ID_ACTIVATE, "AVAILABLE",
        { generation: 1, incarnationId: capActivate.incarnationId });
    await lane3.lane2.grantAuthority({
        capabilityId: CAP_ID_ACTIVATE, subject: "owner", actions: ["activate"],
        identityBinding: { principals: ["owner"] }
    });

    const capDeactivate = await lane3.lane2.registerCapability({
        id: CAP_ID_DEACTIVATE, operations: ["deactivate"]
    });
    await lane3.lane2.registry.observeAvailability(CAP_ID_DEACTIVATE, "AVAILABLE",
        { generation: 1, incarnationId: capDeactivate.incarnationId });
    await lane3.lane2.grantAuthority({
        capabilityId: CAP_ID_DEACTIVATE, subject: "owner", actions: ["deactivate"],
        identityBinding: { principals: ["owner"] }
    });

    // Actuator Mata Dewa — jalur yang SAMA dengan produksi.
    registerMataDewaUiModeActuator({
        actuatorRegistry: { register: lane3.registerActuator },
        capabilityId: CAP_ID_ACTIVATE,
        capabilityIncarnationId: capActivate.incarnationId,
        service,
        telemetry
    });
    registerMataDewaUiModeModeDeactivate(lane3, capDeactivate.incarnationId, service, telemetry);

    const mediaContextAuthority = createMediaContextAuthority();
    const manager = createDamarManagerComposition({
        mediaContextAuthority,
        deps: {
            lane2: {
                admit: lane3.lane2.admit,
                evaluate: lane3.lane2.evaluate,
                authenticate: lane3.lane2.authDomain.authenticate,
                session: lane3.lane2.session
            },
            lane3: { execute: lane3.execute },
            lane4: {
                verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v-ui" }),
                compensate: async () => ({})
            },
            // Pemetaan frasa → proposal deklaratif (PLAN != AUTHORITY):
            // Manager tetap menjalankan admit → evaluate → execute penuh.
            planner: async ({ request }) => {
                const text = String(request?.payload?.text ?? "").toLowerCase();
                if (text.includes("mata dewa") && (text.includes("aktifkan") || text.includes("buka"))) {
                    return { actionProposal: { capabilityId: CAP_ID_ACTIVATE, operation: "activate", arguments: {} } };
                }
                if (text.includes("kembali") || (text.includes("matikan") && text.includes("mata dewa"))) {
                    return { actionProposal: { capabilityId: CAP_ID_DEACTIVATE, operation: "deactivate", arguments: {} } };
                }
                return null;
            }
        },
        trustedChannelAdapters: CHANNEL_ADAPTERS.slice()
    });

    const bus = ib.createInteractionBus({ clock: () => 1000, idFactory: ib.createSequentialIdFactory() });
    const ingress = createManagerInteractionIngress({
        bus, manager,
        mediaContextMint: mediaContextAuthority.mint
    });

    return { service, telemetry, manager, ingress, bus };
}

function registerMataDewaUiModeModeDeactivate(lane3, incarnationId, service, telemetry) {
    registerMataDewaUiModeActuator({
        actuatorRegistry: { register: lane3.registerActuator },
        capabilityId: CAP_ID_DEACTIVATE,
        capabilityIncarnationId: incarnationId,
        service,
        telemetry
    });
}

async function tick() {
    await new Promise((resolve) => setImmediate(resolve));
}

const VOICE_REQUEST = (text, overrides = {}) => ({
    text,
    userId: "owner",
    sessionId: "ses_owner_voice",
    ...overrides
});

test("MD-001 E2E leg 1: frasa via voice seam → Manager kognisi advisory — TANPA aksi (MODEL OUTPUT != AUTHORITY)", async () => {
    const { service, telemetry, ingress } = await makeE2eHarness();
    (await rendererCmds()).resetUiCommandSequence();
    assert.equal(service.uiMode, UI_MODE.NORMAL);

    // Leg transport kanonik: host.channels.request("voice", { text }) —
    // frasa MURNI lewat InteractionBus. Hukum Manager: frasa tanpa material
    // intent deklaratif = kognisi advisory, TIDAK pernah dieksekusi.
    const result = await ingress.channels.request("voice", VOICE_REQUEST(
        "Damar, aktifkan mode Mata Dewa"
    ));
    await tick();

    assert.equal(result.outcome, "COMPLETED");
    assert.match(String(result.detail ?? ""), /non-action|advisory/i);
    // TIDAK ada aksi: state tetap, tidak ada perintah UI.
    assert.equal(service.uiMode, UI_MODE.NORMAL);
    assert.equal(telemetry.events.filter(e => e.type === "damar:ui-command").length, 0);
});

test("MD-001 E2E leg 2: intent deklaratif 'aktifkan mode Mata Dewa' → Manager fabric → actuator → perintah UI → renderer allowlist → UI berubah", async () => {
    const { service, telemetry, manager } = await makeE2eHarness();
    (await rendererCmds()).resetUiCommandSequence();
    assert.equal(service.uiMode, UI_MODE.NORMAL);

    // Leg intent kanonik (seam post-STT yang dipakai komposisi voice
    // setelah intent terkonfirmasi): requestedOperation deklaratif →
    // Manager admit → Lane 2 evaluate → Lane 3 execute → actuator Mata
    // Dewa → batas perintah UI → renderer.
    const result = await manager.handle({
        channelType: "voice",
        channelId: "channel.voice",
        sessionId: "ses_owner_voice",
        correlationId: "corr-md-1",
        receivedAtMs: 1_000_000,
        payload: { text: "Damar, aktifkan mode Mata Dewa" },
        requestedOperation: { capabilityId: CAP_ID_ACTIVATE, operation: "activate", arguments: {} }
    });

    // 1. Manager menyelesaikan aksi secara kanonik.
    assert.equal(result.outcome, "COMPLETED", `Manager harus menyelesaikan: ${result.detail}`);

    // 2. State service berubah.
    assert.equal(service.uiMode, UI_MODE.MATA_DEWA);

    // 3. Perintah UI terbitkan pada aliran event Damar yang SUDAH ADA.
    const uiCmds = telemetry.events.filter(e => e.type === "damar:ui-command");
    assert.equal(uiCmds.length, 1);
    assert.equal(uiCmds[0].payload.command, UI_COMMANDS.UI_MODE_SET);
    assert.deepEqual(uiCmds[0].payload.args, { mode: "mata-dewa" });
    assert.equal(uiCmds[0].payload.visualOnly, true);

    // 4. Renderer apply allowlist → navigasi mode di aplikasi yang SAMA.
    const applied = (await rendererCmds()).applyUiCommandEvent(uiCmds[0].payload, { navigate: () => {} });
    assert.equal(applied.ok, true);
    assert.equal(applied.mode, "mata-dewa");
});

test("MD-001 E2E leg 2: 'Damar, kembali' → Manager fabric → delivery → UI kembali normal", async () => {
    const { service, telemetry, manager } = await makeE2eHarness();
    (await rendererCmds()).resetUiCommandSequence();
    service.activateMode(); // mulai dari Mata Dewa (setup — event setup sendiri)
    telemetry.events.length = 0; // bersihkan event setup; fokus ke interaksi kanonik

    const result = await manager.handle({
        channelType: "voice",
        channelId: "channel.voice",
        sessionId: "ses_owner_voice",
        correlationId: "corr-md-2",
        receivedAtMs: 1_000_000,
        payload: { text: "Damar, kembali" },
        requestedOperation: { capabilityId: CAP_ID_DEACTIVATE, operation: "deactivate", arguments: {} }
    });

    assert.equal(result.outcome, "COMPLETED", result.detail ?? "");
    assert.equal(service.uiMode, UI_MODE.NORMAL);
    const uiCmds = telemetry.events.filter(e => e.type === "damar:ui-command");
    assert.equal(uiCmds.length, 1);
    assert.deepEqual(uiCmds[0].payload.args, { mode: "normal" });
    const applied = (await rendererCmds()).applyUiCommandEvent(uiCmds[0].payload, { navigate: () => {} });
    assert.equal(applied.ok, true);
    assert.equal(applied.mode, "normal");
});

test("MD-001: produksi tanpa trust Lane 4 → Manager gagal tertutup (jujur, POST-LANE4)", async () => {
    const { createDamarManager } = require("../../src/manager/bootstrap");
    const manager = createDamarManager(); // komposisi produksi asli
    const result = await manager.handle({
        channelType: "voice",
        channelId: "channel.voice",
        sessionId: "ses_owner_voice",
        correlationId: "corr-x",
        receivedAtMs: 1_000_000,
        payload: { text: "Damar, aktifkan mode Mata Dewa" },
        requestedOperation: { capabilityId: CAP_ID_ACTIVATE, operation: "activate", arguments: {} }
    });
    assert.equal(result.outcome, "AUTHENTICATION_REQUIRED");
});

test("MD-001: allowlist menolak perintah arbitrer / argumen asing / non-visual", () => {
    assert.equal(validateUiCommand("ui.mode.set", { mode: "mata-dewa" }).ok, true);
    assert.equal(validateUiCommand("eval.js", { code: "process.exit()" }).ok, false);
    assert.equal(validateUiCommand("ui.mode.set", { mode: "hacked" }).ok, false);
    assert.equal(validateUiCommand("ui.mode.set", {}).ok, false);
    assert.equal(validateUiCommand("ui.mode.set", { mode: "normal", extra: 1 }).ok, false);
    assert.equal(validateUiCommand(null, {}).ok, false);
    // Perintah konsekuensial TIDAK BOLEH ada di kosakata UI:
    const vocabulary = Object.values(UI_COMMANDS);
    assert.equal(vocabulary.includes("mata_dewa.watch.create"), false);
    assert.equal(vocabulary.includes("mata_dewa.asset.import"), false);
});

test("MD-001: renderer allowlist mirror menolak payload hostil", async () => {
    const { applyUiCommandEvent: apply } = await rendererCmds();
    const surface = { navigate: () => assert.fail("tidak boleh navigasi") };
    assert.equal(apply({ command: "eval", args: {}, visualOnly: true }, surface).ok, false);
    assert.equal(apply({ command: "ui.mode.set", args: { mode: "mata-dewa" }, visualOnly: false }, surface).ok, false);
    assert.equal(apply({ command: "ui.mode.set", args: { mode: "x" }, visualOnly: true }, surface).ok, false);
    assert.equal(apply(null, surface).ok, false);
});

test("MD-001: tanpa publisher terpasang → state berubah, delivery jujur false", () => {
    const service = new MataDewaService({ clock: { nowMs: () => 0 } });
    const r = service.activateMode();
    assert.equal(r.ok, true);
    assert.equal(r.delivered, false);
    assert.equal(service.uiMode, UI_MODE.MATA_DEWA);
});

test("MD-001: actuator menolak kapabilitas konsekuensial yang diselundupkan", () => {
    // Kosakata perintah UI hanya visual — kapabilitas governed tidak bisa
    // diselundupkan lewat jalur ui.mode.set (sudah diuji), dan actuator UI
    // hanya menerima mode wire yang dikenal.
    const { MataDewaService } = require("../../src/mataDewa/service");
    const service = new MataDewaService({ clock: { nowMs: () => 0 } });
    assert.equal(service.setUiMode("SOMETHING_ELSE").ok, false);
});
