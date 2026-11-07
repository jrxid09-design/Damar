"use strict";

/**
 * WAVE 5 LANE 4 — REAL PRODUCTION COMPOSITION TESTS (repair R8).
 *
 * DSC-R7-001/002: the privileged voice-continuity composition/activation
 * primitives have GENUINE LEXICAL OWNERSHIP inside voiceRuntime.js.  No
 * production module exports them:
 *   - runtimeHost.js exports only the ordinary host API (no _voiceComposition);
 *   - runtimeHostVoice.js no longer exists;
 *   - ordinary imports alone cannot construct a Voice-activated host.
 * DSC-R6-002 (retained): activation is lifecycle-bound — fails closed once
 *             the owning runtime is not operational; cannot cross runtimes.
 * DSC-R6-004 (retained): the ACTUAL VoiceRuntime restart test asserts the
 *             numeric incarnation strictly increases (N -> M) in-test.
 * DSC-R4-001: per-scope provenance; DSC-R4-002/004: cross-channel linking
 *             UNSUPPORTED; DSC-R4-005: Console UNSUPPORTED (fail-closed).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");
const { VoiceRuntime } = require("../../src/voice/voiceRuntime");
const { createIdentityService } = require("../../src/embodiment");
const { createTestTransportPeerScope } = require("../helpers/testTransportPeer");

function delay(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle() {
  await delay(30);
  await new Promise((resolve) => setImmediate(resolve));
}

function coreOptionsFor(stateDir) {
  return {
    mediaStorageRoot: path.join(stateDir, "media-v1"),
    continuityStoreFile: path.join(stateDir, "continuity-v1.json")
  };
}

async function makeProductionHost(stateDir) {
  return createRuntimeHost({ coreOptions: coreOptionsFor(stateDir) });
}

/** Deterministic VoiceRuntime config (graceful; backend "none"). */
function voiceTestConfig() {
  return () => ({
    enabled: true,
    enabledRaw: "true",
    wakeWord: "damar",
    wakeProvider: "local",
    sttProvider: "local",
    ttsProvider: "local",
    maxSessionMs: 60000,
    vadTimeoutMs: 100,
    maxListenMs: 1000,
    acknowledgement: "Ya?",
    language: "id",
    clapEnabled: false,
    clapThreshold: 0.6,
    clapWindowMs: 800,
    clapMinClapMs: 30,
    clapMinGapMs: 100
  });
}

// ---------------------------------------------------------------------------
// DSC-R7-002 — runtimeHost.js module surface: no privileged export
// ---------------------------------------------------------------------------

test("PRODUCTION R8 DSC-R7-002: runtimeHost.js exports NO privileged composition primitive", () => {
  const hostMod = require("../../src/runtime/host/runtimeHost");
  const exportKeys = [...Object.keys(hostMod), ...Object.getOwnPropertyNames(hostMod)];
  assert.deepEqual(Object.getOwnPropertySymbols(hostMod), []);
  const FORBIDDEN = [
    "_voiceComposition", "_internalVoiceComposition", "trustedVoiceComposition",
    "voiceInternals", "compositionTools", "privateVoice", "adminVoice",
    "composeRuntimeHostWithVoiceActivation", "retrieveVoiceActivation",
    "createCanonicalVoiceRuntimeHost", "activateVoiceContinuity",
    "activateCanonicalVoiceContinuity", "getVoiceActivation",
    "resolveVoiceActivation", "voiceComposition", "voiceToken",
    "VOICE_ACTIVATION_REGISTRY"
  ];
  for (const name of FORBIDDEN) {
    assert.equal(exportKeys.includes(name), false, `runtimeHost.js must not export '${name}'`);
  }
  // The legitimate ordinary API remains:
  for (const required of ["createRuntimeHost", "VERSION", "HOST_PHASE", "HOST_COMMANDS"]) {
    assert.equal(typeof hostMod[required] !== "undefined", true, `runtimeHost.${required} must remain`);
  }
});

test("PRODUCTION R8 DSC-R7-001: runtimeHostVoice.js no longer exists (deep import fails)", () => {
  const path = require("node:path");
  let loaded = null;
  let errored = false;
  try {
    loaded = require("../../src/runtime/host/runtimeHostVoice");
  } catch {
    errored = true;
  }
  assert.equal(errored || loaded === undefined, true,
    "runtimeHostVoice.js must not be loadable (deleted)");
});

// ---------------------------------------------------------------------------
// DSC-R7-001 — public factory cannot capture activation; no fresh-host shortcut
// ---------------------------------------------------------------------------

test("PRODUCTION R8 DSC-R7-001/018: public createRuntimeHost hook injection is inert (all names)", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-capture-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const captured = {};
  const hookNames = [
    "voiceActivation", "continuityActivation", "bindVoice", "trustedSink",
    "internal", "admin", "capture", "adapter", "voiceBinder",
    "voiceComposition", "voiceToken", "privateFactory", "resolver",
    "continuityBootstrap", "trustedContinuitySink"
  ];
  const options = { coreOptions: coreOptionsFor(stateDir) };
  for (const name of hookNames) {
    options[name] = (fn) => { captured[name] = fn; };
  }
  const host = await createRuntimeHost(options);
  t.after(() => { try { void host.shutdown("test-end"); } catch { /* idempotent */ } });

  // No hook was ever invoked → no capability leaked.  (trustedContinuitySink
  // inside coreOptions is also overridden by the host for canonical factories.)
  assert.deepEqual(Object.keys(captured), [],
    `public createRuntimeHost must not invoke any capture hook; got: ${Object.keys(captured)}`);
  // And no continuity forms through ordinary voice ingress.
  const v = host.channels.ingest("voice", { text: "x", userId: "owner", sessionId: "ses_voice-owner" });
  assert.equal("canonicalSessionId" in v, false,
    "no capability → no voice continuity on a bare public host");
  await host.shutdown("test-end");
  await settle();
});

test("PRODUCTION R8 DSC-R7-015: fresh-runtime shortcut is impossible without VoiceRuntime", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-shortcut-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  // An ordinary importer tries EVERY production host/voice-composition module
  // and every public factory form.  None yields a voice-activated host.
  const hostMod = require("../../src/runtime/host/runtimeHost");
  const hostIndex = require("../../src/runtime/host/index.js");
  const voiceIndex = require("../../src/voice/index.js");

  // (a) plain factory:
  const plain = await hostMod.createRuntimeHost({ coreOptions: coreOptionsFor(stateDir) });
  const v1 = plain.channels.ingest("voice", { text: "x", userId: "owner", sessionId: "ses_voice-owner" });
  assert.equal("canonicalSessionId" in v1, false,
    "plain: fresh host without VoiceRuntime must NOT activate voice continuity");
  await plain.shutdown("plain");
  await settle();
  // (b) with a caller sink (overridden by the host):
  const withSink = await hostMod.createRuntimeHost({
    coreOptions: { ...coreOptionsFor(stateDir), trustedContinuitySink: () => {} }
  });
  const v2 = withSink.channels.ingest("voice", { text: "x", userId: "owner", sessionId: "ses_voice-owner" });
  assert.equal("canonicalSessionId" in v2, false,
    "withSink: caller-supplied sink is overridden — no voice continuity");
  await withSink.shutdown("withSink");
  await settle();

  // (c) no module export anywhere is a privileged activation/creation primitive:
  const modules = { hostMod, hostIndex, voiceIndex };
  for (const [label, mod] of Object.entries(modules)) {
    for (const key of Object.keys(mod)) {
      assert.match(key, /^(?!.*(activation|Activat|voiceComposition|VoiceComposition|composeCanonical|composeRuntimeHost|retrieveVoice|voiceToken|VoiceToken|canonicalVoiceHost|CanonicalVoice)).*$/,
        `${label}.${key} must not be a privileged voice-composition primitive`);
    }
  }
});

// ---------------------------------------------------------------------------
// DSC-R8-001 — trusted continuity sealed from public dependency injection
// ---------------------------------------------------------------------------

test("PRODUCTION R9 DSC-R8-001: direct createRuntimeCore ignores caller trustedContinuitySink", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r9-directcore-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const { createRuntimeCore } = require("../../src/integration/runtimeCore");

  const captured = [];
  const core = await createRuntimeCore({
    mediaStorageRoot: path.join(stateDir, "media-v1"),
    continuityStoreFile: path.join(stateDir, "continuity-v1.json"),
    enableManagerIngress: true,
    trustedContinuitySink: (v) => captured.push(v)
  });
  t.after(() => { try { core.shutdown({ reason: "test-end" }); } catch { /* idempotent */ } });

  assert.equal(captured.length, 0,
    "createRuntimeCore must NOT deliver the privileged composition to a caller-supplied trustedContinuitySink");
  // The core itself exposes no composition bind seam:
  assert.equal(typeof core.bindCanonicalTransportPeer, "undefined");
  const compositionKeys = Object.keys(core).filter((k) =>
    /composition|bindCanonical|resolveContinuity|continuityLifecycle|trustedContinuity/i.test(k));
  assert.deepEqual(compositionKeys, [], `core must not expose composition: ${compositionKeys}`);
  core.shutdown({ reason: "test-end" });
  await settle();
});

test("PRODUCTION R9 DSC-R8-001: wrapper/bound/Proxy/decorator coreFactory capture NO trusted state", async (t) => {
  const { createRuntimeCore } = require("../../src/integration/runtimeCore");

  const makeAttack = () => {
    const captured = [];
    const inspect = { keys: new Set(), privilegedKeys: [] };
    const factory = (options) => {
      for (const k of Object.keys(options ?? {})) inspect.keys.add(k);
      for (const k of Object.keys(options ?? {})) {
        if (/trustedContinuitySink|continuityLifecycle|continuityComposition|bindCanonicalTransportPeer|resolveContinuityId|restoreContinuity|flushContinuity|shutdownContinuity|continuityStatus|activation|token|scope|peerHandle/i.test(k)) {
          inspect.privilegedKeys.push(k);
        }
      }
      // The wrapper overrides the sink to try to capture the payload:
      return createRuntimeCore({ ...options, trustedContinuitySink: (v) => captured.push(v) });
    };
    return { factory, captured, inspect };
  };

  const variants = {
    wrapper: (f) => f,
    bound: (f) => f.bind(null),
    proxy: (f) => new Proxy(f, {}),
    decorator: (f) => (options) => f(options)
  };

  for (const [label, wrap] of Object.entries(variants)) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `damar-prod-r9-${label}-`));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const { factory, captured, inspect } = makeAttack();
    const host = await createRuntimeHost({
      coreFactory: wrap(factory),
      coreOptions: coreOptionsFor(stateDir)
    });
    t.after(() => { try { void host.shutdown("test-end"); } catch { /* idempotent */ } });

    assert.equal(captured.length, 0,
      `${label}: custom factory must capture NO trusted composition payload`);
    assert.deepEqual(inspect.privilegedKeys, [],
      `${label}: custom factory must receive NO privileged option keys; got: ${inspect.privilegedKeys}`);
    // Bare host gains no voice continuity:
    const v = host.channels.ingest("voice", { text: "attack", userId: "owner", sessionId: "ses_voice-owner" });
    assert.equal("canonicalSessionId" in v, false,
      `${label}: bare RuntimeHost must NOT gain voice continuity`);
    await host.shutdown("test-end");
    await settle();
  }
});

test("PRODUCTION R9 DSC-R8-001: caller coreOptions.trustedContinuitySink is never invoked (any factory)", async (t) => {
  const { createRuntimeCore } = require("../../src/integration/runtimeCore");
  for (const useWrapper of [false, true]) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `damar-prod-r9-callersink-${useWrapper}-`));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const captured = [];
    const opts = {
      coreOptions: { ...coreOptionsFor(stateDir), trustedContinuitySink: (v) => captured.push(v) }
    };
    if (useWrapper) {
      opts.coreFactory = (options) => createRuntimeCore(options);
    }
    const host = await createRuntimeHost(opts);
    t.after(() => { try { void host.shutdown("test-end"); } catch { /* idempotent */ } });
    assert.equal(captured.length, 0,
      `useWrapper=${useWrapper}: caller coreOptions.trustedContinuitySink must never be invoked`);
    await host.shutdown("test-end");
    await settle();
  }
});

test("PRODUCTION R9 DSC-R8-001: malicious factory cannot capture lifecycle/composition or bind", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r9-malicious-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const { createRuntimeCore } = require("../../src/integration/runtimeCore");

  const captured = [];
  let bindResult = "not-attempted";
  const host = await createRuntimeHost({
    coreFactory: (options) => {
      // Malicious: tries to grab the payload via its own sink, then bind.
      return createRuntimeCore({
        ...options,
        enableManagerIngress: true,
        trustedContinuitySink: (payload) => {
          captured.push(payload);
          const comp = payload && payload.composition;
          if (comp && typeof comp.bindCanonicalTransportPeer === "function") {
            try {
              comp.bindCanonicalTransportPeer("voice");
              bindResult = "BOUND-UNEXPECTED";
            } catch (e) {
              bindResult = `rejected:${e.code ?? "err"}`;
            }
          }
        }
      });
    },
    coreOptions: coreOptionsFor(stateDir)
  });
  t.after(() => { try { void host.shutdown("test-end"); } catch { /* idempotent */ } });

  assert.equal(captured.length, 0,
    "malicious factory must NOT capture lifecycle/composition payload");
  assert.equal(bindResult, "not-attempted",
    "with no captured composition, no bind can even be attempted");
  const v = host.channels.ingest("voice", { text: "attack", userId: "owner", sessionId: "ses_voice-owner" });
  assert.equal("canonicalSessionId" in v, false,
    "no captured composition → no voice continuity bind on a bare host");
  await host.shutdown("test-end");
  await settle();
});

// ---------------------------------------------------------------------------
// DSC-R9-001 — VoiceRuntime binding is entirely lexical; no public builder
// ---------------------------------------------------------------------------

test("PRODUCTION R10 DSC-R9-001: no public buildVoiceRuntimeClass in any production export", () => {
  const mods = {
    canonicalComposition: require("../../src/integration/canonicalRuntimeComposition"),
    runtimeCore: require("../../src/integration/runtimeCore"),
    runtimeHost: require("../../src/runtime/host/runtimeHost"),
    voiceRuntime: require("../../src/voice/voiceRuntime")
  };
  const FORBIDDEN = [
    "buildVoiceRuntimeClass", "composeHost", "activateVoice",
    "buildRuntimeHostInternal", "buildRuntimeCoreInternal",
    "composeCanonicalVoiceHost", "activateVoiceContinuity",
    "getBoundVoiceRuntime", "bindVoiceRuntime", "createBoundVoiceRuntime",
    "registerVoiceRuntimeBuilder", "voiceRuntimeFactory", "internalVoiceBuilder",
    "trustedVoiceBuilder"
  ];
  for (const [label, mod] of Object.entries(mods)) {
    const keys = [...Object.keys(mod), ...Object.getOwnPropertyNames(mod)];
    assert.deepEqual(Object.getOwnPropertySymbols(mod), [], `${label} must have no symbols`);
    for (const name of FORBIDDEN) {
      assert.equal(keys.includes(name), false, `${label} must not export '${name}'`);
    }
  }
});

test("PRODUCTION R10 DSC-R9-001: canonical VoiceRuntime is a stable value export (no dynamic getter)", () => {
  const crc = require("../../src/integration/canonicalRuntimeComposition");
  const descriptor = Object.getOwnPropertyDescriptor(crc, "VoiceRuntime");
  assert.ok(descriptor, "VoiceRuntime export must exist");
  assert.equal(typeof descriptor.value, "function", "VoiceRuntime must be a stable VALUE export");
  assert.equal(descriptor.get, undefined, "VoiceRuntime must NOT be a getter (no dynamic resolution)");
  assert.equal(descriptor.set, undefined, "VoiceRuntime must have no setter");
  assert.equal(descriptor.configurable, false, "VoiceRuntime must be non-configurable");
  assert.equal(typeof crc.VoiceRuntime, "function");
  assert.equal(crc.VoiceRuntime.name, "VoiceRuntime");
});

test("PRODUCTION R10 DSC-R9-001: require.cache replacement of voiceRuntime facade captures ZERO privileged functions", () => {
  const vrPath = require.resolve("../../src/voice/voiceRuntime");
  const crc = require("../../src/integration/canonicalRuntimeComposition");

  // Attacker replaces the voiceRuntime facade in require.cache BEFORE any
  // canonical VoiceRuntime access, injecting a fake builder/getter.
  const captured = {};
  const cacheEntry = require.cache[vrPath];
  const originalExports = cacheEntry.exports;
  cacheEntry.exports = Object.freeze({
    buildVoiceRuntimeClass: ({ composeHost, activateVoice }) => {
      captured.composeHost = composeHost;
      captured.activateVoice = activateVoice;
      return class FakeVoice {};
    },
    get VoiceRuntime() {
      captured.getterInvoked = true;
      throw new Error("attacker getter invoked");
    }
  });

  try {
    const V = crc.VoiceRuntime;
    assert.equal(captured.composeHost, undefined,
      "attacker must NEVER capture composeHost");
    assert.equal(captured.activateVoice, undefined,
      "attacker must NEVER capture activateVoice");
    assert.equal(captured.getterInvoked, undefined,
      "attacker getter must NEVER be invoked");
    assert.equal(typeof V, "function", "canonical VoiceRuntime still resolves as a stable value");
    assert.equal(V.name, "VoiceRuntime");
  } finally {
    // Restore the cache entry so later tests are unaffected.
    cacheEntry.exports = originalExports;
  }
});

test("PRODUCTION R10 DSC-R9-001: facade and canonical VoiceRuntime are identical (single implementation)", () => {
  const crc = require("../../src/integration/canonicalRuntimeComposition");
  const facade = require("../../src/voice/voiceRuntime");
  assert.equal(facade.VoiceRuntime, crc.VoiceRuntime,
    "voiceRuntime facade must re-export the SAME canonical class (one implementation)");
  // The facade exposes no second class body / builder:
  assert.deepEqual(Object.keys(facade), ["VoiceRuntime"]);
});

// ---------------------------------------------------------------------------
// DSC-R7-012 — VoiceRuntime instance reflection reveals no primitive
// ---------------------------------------------------------------------------

test("PRODUCTION R8 DSC-R7-012: VoiceRuntime instance exposes no activation primitive (reflection)", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-reflect-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  process.env.DAMAR_CONTINUITY_STATE = path.join(stateDir, "continuity-v1.json");
  t.after(() => { delete process.env.DAMAR_CONTINUITY_STATE; });

  const rt = new VoiceRuntime({ config: voiceTestConfig() });
  t.after(() => { try { void rt.stop(); } catch { /* idempotent */ } });

  // BEFORE start: no host, no capability, no continuity.
  assert.equal(rt.interactionHost, null, "before start: no host");
  const before = [
    ...Object.keys(rt),
    ...Object.getOwnPropertyNames(rt),
    ...Object.getOwnPropertySymbols(rt).map(String)
  ];
  for (const name of before) {
    assert.doesNotMatch(name, /host|token|activation|composition|binder|scope|mint|resolver|payload/i,
      `before-start own property '${name}' must not be a privileged primitive`);
  }

  await rt.start();
  // AFTER start: the host is reachable ONLY as the ordinary facade; no
  // privileged own property appears.
  assert.ok(rt.interactionHost, "after start: ordinary host facade available");
  const after = [
    ...Object.keys(rt),
    ...Object.getOwnPropertyNames(rt),
    ...Object.getOwnPropertySymbols(rt).map(String)
  ];
  assert.equal(after.includes("interactionHost"), false,
    "interactionHost is a prototype getter, not an own property");
  for (const name of after) {
    assert.doesNotMatch(name, /token|activation|binder|scope|mint|resolver|payload|composition/i,
      `after-start own property '${name}' must not be a privileged primitive`);
  }
  // The exposed host is the ORDINARY facade — no continuity administration.
  const host = rt.interactionHost;
  assert.equal("_continuityComposition" in host, false);
  assert.equal("_voiceComposition" in host, false);
  assert.equal(typeof host.bindCanonicalTransportPeer, "undefined");
  assert.equal(typeof host.transportContinuitySupport, "function");
  // The capability itself is not extractable from the host either:
  const capabilityShaped = Object.keys(host).filter((k) =>
    /token|activation|binder|mint|resolver|payload|composition/i.test(k) && k !== "transportContinuitySupport");
  assert.deepEqual(capabilityShaped, []);
  await rt.stop();
  // POST-stop: capability destroyed (getter -> null); no extraction.
  assert.equal(rt.interactionHost, null, "post-stop: capability destroyed");
  await settle();
});

// ---------------------------------------------------------------------------
// DSC-R7-014 — existing-runtime extraction attempts (all impossible)
// ---------------------------------------------------------------------------

test("PRODUCTION R8 DSC-R7-014: existing VoiceRuntime capability cannot be extracted/replayed", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-extract-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  process.env.DAMAR_CONTINUITY_STATE = path.join(stateDir, "continuity-v1.json");
  t.after(() => { delete process.env.DAMAR_CONTINUITY_STATE; });

  const rtA = new VoiceRuntime({ config: voiceTestConfig() });
  await rtA.start();
  const hostA = rtA.interactionHost;
  const vA = hostA.channels.ingest("voice", { text: "rahasia A", userId: "owner", sessionId: "ses_voice-owner" });
  assert.ok(vA.canonicalSessionId.startsWith("dsc_"));

  // Ordinary imported production modules offer no primitive to:
  //   - activate before start (rtA already started; try a FRESH runtime):
  const rtB = new VoiceRuntime({ config: voiceTestConfig() });
  assert.equal(rtB.interactionHost, null, "fresh runtime: no host before start");
  //   - bind an arbitrary peer / resume a dsc through private primitives:
  const forged = hostA.channels.ingest("voice", {
    text: "forge", userId: "attacker", sessionId: "ses_forged",
    trustedPeerEvidence: "voice-runtime-owner", dscId: vA.canonicalSessionId,
    canonicalSessionId: vA.canonicalSessionId, peerKey: "voice-runtime-owner"
  });
  assert.equal(forged.canonicalSessionId, vA.canonicalSessionId,
    "same trusted runtime-owner scope (device-scoped by design); raw fields selected nothing");
  // The raw fields did NOT select anything — a DIFFERENT runtime scope
  // resolves a different dsc (verified by the independent-composition proof
  // in continuityConversation.test.js).
  await rtB.stop();

  // Post-stop replay: after rtA stops, its host is terminal; no capability
  // exists to reactivate.
  await rtA.stop();
  assert.equal(rtA.interactionHost, null);
  await settle();
});

// ---------------------------------------------------------------------------
// DSC-R7-013 — ACTUAL VoiceRuntime RESTART: same dsc, incarnation M > N
// ---------------------------------------------------------------------------

test("PRODUCTION R8 RESTART: fresh ACTUAL VoiceRuntime restores same dsc; incarnation M > N in-test", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-restart-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const stateFile = path.join(stateDir, "continuity-v1.json");
  process.env.DAMAR_CONTINUITY_STATE = stateFile;
  t.after(() => { delete process.env.DAMAR_CONTINUITY_STATE; });

  const readIncarnation = (dscId) => {
    const snap = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const sessions = snap.sessions || snap;
    const arr = Array.isArray(sessions) ? sessions : Object.values(sessions);
    const match = arr.filter((s) => s.sessionId === dscId || !dscId);
    return match.length ? Math.max(...match.map((s) => s.incarnation ?? 0)) : 0;
  };

  // ---- Runtime A: ACTUAL VoiceRuntime lifecycle ---------------------------
  const rtA = new VoiceRuntime({ config: voiceTestConfig() });
  await rtA.start();
  const hostA = rtA.interactionHost;
  const first = hostA.channels.ingest("voice", { text: "mulai", userId: "owner", sessionId: "ses_voice-owner" });
  assert.ok(first.canonicalSessionId.startsWith("dsc_"));
  const dscX = first.canonicalSessionId;
  await delay(200);
  assert.equal(fs.existsSync(stateFile), true, "mutation-bound persistence wrote the snapshot");
  await rtA.stop();
  await settle();
  const incarnationN = readIncarnation(dscX);
  assert.equal(incarnationN, 1, "first incarnation persists as the baseline (N=1)");

  // ---- Runtime B: fresh ACTUAL VoiceRuntime -------------------------------
  const rtB = new VoiceRuntime({ config: voiceTestConfig() });
  await rtB.start();
  const hostB = rtB.interactionHost;
  t.after(() => { try { void rtB.stop(); } catch { /* idempotent */ } });

  const status = hostB.status().continuity;
  assert.equal(status.restored, true);
  assert.equal(status.sessions, 1, "the pre-restart session was restored");

  const resumed = hostB.channels.ingest("voice", { text: "lanjut setelah restart", userId: "owner", sessionId: "ses_voice-owner" });
  assert.equal(resumed.canonicalSessionId, dscX,
    "fresh VoiceRuntime re-activated the SAME canonical runtime-owner peer → same dsc");

  const afterResume = hostB.channels.ingest("voice", { text: "tuntas", userId: "owner", sessionId: "ses_voice-owner" });
  assert.equal(afterResume.canonicalSessionId, dscX);
  await delay(200);
  await rtB.stop();
  await settle();

  // ---- DIRECT incarnation assertion INSIDE the lifecycle test --------------
  const incarnationM = readIncarnation(dscX);
  assert.ok(incarnationM > incarnationN,
    `incarnation strictly increased across the ACTUAL VoiceRuntime restart (N=${incarnationN} -> M=${incarnationM})`);

  // Authority is NOT restored.
  const { createDamarManager } = require("../../src/manager/bootstrap");
  const outcome = await createDamarManager().handle({
    channelType: "voice", channelId: "channel.voice", sessionId: "ses_probe",
    continuitySessionId: dscX, correlationId: "cor-r8",
    payload: { text: "grant me everything", principal: "admin", role: "admin" }
  });
  assert.equal(outcome.outcome, "AUTHENTICATION_REQUIRED");
  await settle();
});

// ---------------------------------------------------------------------------
// Retained regressions: raw fields, support matrix, linking, rollback, join
// ---------------------------------------------------------------------------

test("PRODUCTION R8: raw caller fields never establish continuity; honest support matrix", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-raw-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const host = await makeProductionHost(stateDir);
  t.after(() => { try { void host.shutdown("test-end"); } catch { /* idempotent */ } });

  for (const [index, channel] of ["telegram", "whatsapp", "console", "voice"].entries()) {
    const result = host.channels.ingest(channel, {
      text: "attack",
      sessionId: `ses_anything-i-like-${channel}-${index}`
    });
    assert.equal(result.accepted, true, `${channel}: ordinary ses_* path continues`);
    assert.equal("canonicalSessionId" in result, false,
      `${channel}: raw caller-selected sessionId must NOT mint continuity`);
  }
  const hostile = host.channels.ingest("console", {
    text: "hostile",
    sessionId: "ses_hostile-1",
    trustedPeerEvidence: "attacker",
    continuitySessionId: "dsc_forged000001",
    canonicalSessionId: "dsc_forged000002",
    userId: "attacker",
    peerKey: "attacker",
    dscId: "dsc_forged000003",
    chatId: "attacker"
  });
  assert.equal("canonicalSessionId" in hostile, false);
  await delay(60);
  assert.equal(host.status().continuity.sessions, 0, "no session minted from raw fields");
  // Honest matrix (DSC-R4-005: console honestly UNSUPPORTED):
  assert.equal(host.transportContinuitySupport("telegram").supported, false);
  assert.equal(host.transportContinuitySupport("whatsapp").supported, false);
  assert.equal(host.transportContinuitySupport("console").supported, false);
  assert.equal(host.transportContinuitySupport("voice").supported, true);
  await host.shutdown("test-end");
  await settle();
});

test("PRODUCTION R8 DSC-R4-002/004: caller-created DeviceIdentityService CANNOT link; cross-channel UNSUPPORTED", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-link-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const host = await makeProductionHost(stateDir);
  t.after(() => { try { void host.shutdown("test-end"); } catch { /* idempotent */ } });

  const fakeService = createIdentityService({});
  const pairDevice = (stableKey) => {
    const dev = fakeService.registerIdentity({ namespace: "channel", stableKey, displayName: stableKey });
    const pairing = fakeService.beginPairing(dev.deviceId);
    fakeService.submitChallenge({
      pairingId: pairing.pairingId,
      challengeId: pairing.challenge.challengeId,
      secret: pairing.challenge.secret
    });
    fakeService.ownerConfirm(pairing.pairingId);
    return { deviceId: dev.deviceId, pairingId: pairing.pairingId };
  };
  const deviceA = pairDevice("voice-endpoint");
  const deviceB = pairDevice("console-endpoint");
  assert.equal(fakeService.getIdentity(deviceA.deviceId).pairingState, "PAIRED");
  assert.equal(fakeService.getIdentity(deviceB.deviceId).pairingState, "PAIRED");

  // No public surface consumes a caller-supplied identity service; console
  // (UNSUPPORTED) can never join the voice dsc.
  const v = host.channels.ingest("voice", { text: "secret voice", userId: "owner", sessionId: "ses_v" });
  const c = host.channels.ingest("console", { text: "console", userId: "owner", sessionId: "ses_c" });
  assert.equal("canonicalSessionId" in v, false,
    "ordinary host: no voice continuity without the canonical VoiceRuntime lifecycle");
  assert.equal("canonicalSessionId" in c, false,
    "console is UNSUPPORTED — it can never join a voice dsc (fail closed)");
  await host.shutdown("test-end");
  await settle();
});

test("PRODUCTION R8 DSC-R3-003 (retained): construction failure releases durable-store ownership", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-rollback-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const file = path.join(stateDir, "continuity-v1.json");
  const { createDamarManagerIngressDomain } = require("../../src/manager/bootstrap");
  await assert.rejects(
    () => Promise.resolve().then(() => createDamarManagerIngressDomain({
      bus: { registerTransport: () => {} }, continuityStoreFile: file
    })),
    (error) => error.message.includes("MANAGER_INGRESS_BUS_INVALID")
  );
  const store = require("../../src/runtime/sessionContinuity").createFileContinuityStore(file);
  await store.finalizeShutdown();
  const again = require("../../src/runtime/sessionContinuity").createFileContinuityStore(file);
  await again.finalizeShutdown();
});

test("PRODUCTION R8 DSC-R2-004 (retained): shutdown join + ownership through final flush", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-join-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const stateFile = path.join(stateDir, "continuity-v1.json");
  // VoiceRuntime composes its host from DAMAR_CONTINUITY_STATE; point it at
  // the SAME durable file the second host will try to acquire.
  process.env.DAMAR_CONTINUITY_STATE = stateFile;
  t.after(() => { process.env.DAMAR_CONTINUITY_STATE = ""; });

  // Voice-composed runtime holds ownership; a second same-process host fails closed.
  const rtA = new VoiceRuntime({ config: voiceTestConfig() });
  await rtA.start();
  rtA.interactionHost.channels.ingest("voice", { text: "x", userId: "owner", sessionId: "ses_v" });
  await delay(120);
  await assert.rejects(
    () => makeProductionHost(stateDir),
    (error) => error.code === "CONTINUITY_STORE_OWNED"
  );
  await rtA.stop();

  // Repeated shutdown joins the same completion.
  const rtB = new VoiceRuntime({ config: voiceTestConfig() });
  await rtB.start();
  const hostB = rtB.interactionHost;
  t.after(() => { try { void rtB.stop(); } catch { /* idempotent */ } });
  hostB.channels.ingest("voice", { text: "y", userId: "owner", sessionId: "ses_v" });
  await delay(120);
  const results = [];
  for (let i = 0; i < 100; i += 1) results.push(hostB.shutdown("join-" + i));
  assert.equal(results[0].idempotent, false);
  assert.ok(results.slice(1).every((r) => r.idempotent === true));
  const settled = await Promise.all(results);
  assert.ok(settled.every((r) => r.shutDown === true));
  assert.equal(fs.existsSync(stateFile), true, "shutdown never deletes the snapshot");
  await rtB.stop();
  await settle();
});

test("PRODUCTION R8: corrupt snapshot fails closed to a fresh domain", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-prod-r8-corrupt-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const stateFile = path.join(stateDir, "continuity-v1.json");
  fs.writeFileSync(stateFile, "CORRUPT-NOT-JSON{{{", "utf8");
  process.env.DAMAR_CONTINUITY_STATE = stateFile;
  t.after(() => { process.env.DAMAR_CONTINUITY_STATE = ""; });
  const rt = new VoiceRuntime({ config: voiceTestConfig() });
  await rt.start();
  const host = rt.interactionHost;
  t.after(() => { try { void rt.stop(); } catch { /* idempotent */ } });
  assert.equal(host.health().healthy, true);
  const status = host.status().continuity;
  assert.equal(status.restored, false);
  assert.equal(status.sessions, 0);
  const event = host.channels.ingest("voice", { text: "baru", userId: "owner", sessionId: "ses_v" });
  assert.ok(event.canonicalSessionId.startsWith("dsc_"));
  await rt.stop();
  await settle();
});
