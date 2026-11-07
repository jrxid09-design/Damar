"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const ib = require("../../src/runtime/interactionBus");
const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");
const { createMediaSubsystem, CODES } = require("../../src/runtime/mediaIngress/subsystem");
const { createManagerInteractionIngress } = require("../../src/runtime/interactionBus/managerIngressInternal");
const { makeManagerHarness } = require("../manager/productionHarness");
const { createMediaContextAuthority } = require("../../src/manager/internal/mediaContext");

const CHANNELS = ["console", "cli", "telegram", "whatsapp", "companion"];
const TEST_DOMAINS = new WeakMap();
const TEST_CONTEXT_AUTHORITIES = new WeakMap();
const spec = (source, extra = {}) => ({ source, fileName: "item.bin", declaredMimeType: "application/octet-stream", sourceChannel: "console", ...extra });
const delay = () => new Promise((resolve) => setTimeout(resolve, 25));

async function fixture(t, limits = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "damar-lane2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const domain = createMediaSubsystem({ storageRoot: root, limits, testMode: true, atomicDomain: true, busOptions: { clock: () => 1_000, idFactory: ib.createSequentialIdFactory() } });
  const media = domain.media;
  await media.ready;
  TEST_DOMAINS.set(media, domain);
  TEST_CONTEXT_AUTHORITIES.set(media, createMediaContextAuthority());
  return { root, media };
}

function composeIngress(media, manager, mediaRuntimePair = TEST_DOMAINS.get(media), mediaContextMint = TEST_CONTEXT_AUTHORITIES.get(media).mint) {
  const bus = mediaRuntimePair.bus;
  return { bus, ingress: createManagerInteractionIngress({ bus, manager, mediaSubsystem: media, mediaContextMint }) };
}

const fakeManager = (onHandle = async () => ({ managerRequestId: "r", outcome: "COMPLETED", lifecycleState: "COMPLETED", detail: "ok" })) => Object.freeze({ handle: onHandle });

test("Lane 2 general media facade has no active processing authority", async (t) => {
  const { media } = await fixture(t);
  const names = [...Object.keys(media), ...Object.getOwnPropertyNames(media), ...Object.getOwnPropertySymbols(media).map(String), ...Object.getOwnPropertyNames(Object.getPrototypeOf(media))];
  for (const forbidden of ["bindAcceptedInteraction", "issueAccess", "issueScopedAccess", "readAccess", "readScopedAccess", "restore", "resume", "restart", "continuation", "privatePorts", "canonicalOwner"]) assert.equal(names.includes(forbidden), false, `${forbidden} leaked`);
  assert.equal(typeof media.ingest, "function");
  assert.equal(typeof media.isCanonicalMediaReference, "function");
});

test("default atomic domain constructs a usable isolated Bus and completes A/A ingestion", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "damar-r10-default-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const domain = createMediaSubsystem({ storageRoot: root, testMode: true, atomicDomain: true });
  await domain.media.ready;
  assert.equal(typeof domain.bus.submit, "function");
  assert.deepEqual(Object.keys(domain).sort(), ["bus", "media"]);
  const surface = (value) => [...Object.keys(value), ...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value).map(String), ...Object.getOwnPropertyNames(Object.getPrototypeOf(value))];
  for (const value of [domain, domain.media, domain.bus]) for (const forbidden of ["runtimePortReceiver", "pairWithBus", "attachBus", "bindBus", "joinBus", "privatePorts", "mediaPorts", "capabilityPorts"]) assert.equal(surface(value).includes(forbidden), false);
  const authority = createMediaContextAuthority();
  const ingress = createManagerInteractionIngress({ bus: domain.bus, manager: fakeManager(), mediaSubsystem: domain.media, mediaContextMint: authority.mint });
  const result = await ingress.channels.ingestAttachments("console", { text: "default", sessionId: "ses_r10_default" }, [spec(Buffer.from("DAMAR-R10-DEFAULT"))]);
  assert.equal(result.accepted, true);
  await delay();
});

test("default same-root domains remain isolated without a post-construction join", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "damar-r10-same-root-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const a = createMediaSubsystem({ storageRoot: root, atomicDomain: true });
  const b = createMediaSubsystem({ storageRoot: root, atomicDomain: true });
  await Promise.all([a.media.ready, b.media.ready]);
  const aa = createManagerInteractionIngress({ bus: a.bus, manager: fakeManager(), mediaSubsystem: a.media, mediaContextMint: createMediaContextAuthority().mint });
  const bb = createManagerInteractionIngress({ bus: b.bus, manager: fakeManager(), mediaSubsystem: b.media, mediaContextMint: createMediaContextAuthority().mint });
  assert.equal((await aa.channels.ingestAttachments("console", { text: "A", sessionId: "ses_r10_a" }, [spec(Buffer.from("A"))])).accepted, true);
  assert.equal((await bb.channels.ingestAttachments("console", { text: "B", sessionId: "ses_r10_b" }, [spec(Buffer.from("B"))])).accepted, true);
  assert.equal(typeof a.media.pairWithBus, "undefined");
  assert.equal(typeof b.media.pairWithBus, "undefined");
});

test("canonical reference is inert and fabricated envelope cannot bind", async (t) => {
  const { root, media } = await fixture(t);
  const descriptor = await media.ingest(spec(Buffer.from("inert")));
  assert.equal(media.isCanonicalMediaReference(descriptor), true);
  assert.equal(media.isCanonicalMediaReference({ ...descriptor }), false);
  composeIngress(media, fakeManager());
  assert.equal(typeof require("../../src/runtime/mediaIngress/subsystem").takePrivatePorts, "undefined");
  assert.deepEqual(await fsp.readdir(path.join(root, "relations")), []);
});

test("accepted active processing gets a scoped lazy reader and exact bytes", async (t) => {
  const { media } = await fixture(t); let reads = 0; let bytes = null;
  const { ingress } = composeIngress(media, fakeManager(async (_input, context) => {
    reads += 1; bytes = (await context.mediaContext.attachments[0].read()).bytes;
    return { managerRequestId: "r", outcome: "COMPLETED", lifecycleState: "COMPLETED", detail: "ok" };
  }));
  const result = await ingress.channels.ingestAttachments("console", { text: "read", sessionId: "ses_lane2" }, [spec(Buffer.from("DAMAR-LANE2-MEDIA-CONTRACT"))]);
  assert.equal(result.accepted, true); await delay(); assert.equal(reads, 1); assert.deepEqual(bytes, Buffer.from("DAMAR-LANE2-MEDIA-CONTRACT"));
});

test("real Manager composition consumes branded lazy mediaContext after test-only authentication", async (t) => {
  const { media } = await fixture(t); const seen = [];
  const harness = await makeManagerHarness({ authenticate: (e) => e && e.sessionId === "ses_contract" ? { principal: "lane2-contract" } : null, mediaProcessor: async ({ mediaContext }) => seen.push((await mediaContext.attachments[0].read()).bytes) });
  const { ingress } = composeIngress(media, harness.manager, undefined, harness.mediaContextMint);
  const accepted = await ingress.channels.ingestAttachments("console", { text: "media", sessionId: "ses_contract" }, [spec(Buffer.from("DAMAR-LANE2-MEDIA-CONTRACT"))]);
  assert.equal(accepted.accepted, true); await delay(); assert.deepEqual(seen, [Buffer.from("DAMAR-LANE2-MEDIA-CONTRACT")]);
});

test("lazy hook does not read media unless it requests attachment.read", async (t) => {
  const { media } = await fixture(t); let hooks = 0;
  const harness = await makeManagerHarness({ authenticate: () => ({ principal: "lane2-contract" }), mediaProcessor: async () => { hooks += 1; } });
  const { ingress } = composeIngress(media, harness.manager, undefined, harness.mediaContextMint);
  const accepted = await ingress.channels.ingestAttachments("console", { text: "no-read", sessionId: "ses_contract" }, [spec(Buffer.from("not-read"))]);
  assert.equal(accepted.accepted, true); await delay(); assert.equal(hooks, 1);
});

test("foreign mediaContext shapes fail before traversal", async () => {
  const harness = await makeManagerHarness({ authenticate: () => ({ principal: "lane2-contract" }) });
  const base = { channelType: "console", channelId: "console", sessionId: "ses_context", payload: { text: "x" } };
  const foreign = createMediaContextAuthority().mint(Object.freeze([]));
  for (const context of [{}, new Proxy({}, {}), Object.create(foreign), { attachments: [{ attachmentId: "att_x", read: () => Buffer.from("x") }] }]) await assert.rejects(harness.manager.handle({ ...base, correlationId: `ctx-${Math.random()}` }, { mediaContext: context }), /MEDIA_CONTEXT_INVALID/);
});

test("terminal success revokes reader while durable relation remains", async (t) => {
  const { root, media } = await fixture(t); let reader;
  const composed = composeIngress(media, fakeManager(async (_input, context) => { reader = context.mediaContext.attachments[0].read; await reader(); return { managerRequestId: "r", outcome: "COMPLETED", lifecycleState: "COMPLETED", detail: "ok" }; }));
  const { ingress } = composed;
  const accepted = await ingress.channels.ingestAttachments("console", { text: "terminal", sessionId: "ses_terminal" }, [spec(Buffer.from("terminal"))]);
  assert.equal(accepted.accepted, true); await delay(); await assert.rejects(reader(), (error) => error.code === CODES.FOREIGN_REFERENCE); assert.equal((await fsp.readdir(path.join(root, "relations"))).length, 1);
});

test("voice attachment crosses actual MediaIngress and terminal handling revokes its scoped reader", async (t) => {
  const { media } = await fixture(t); let reader; let observed;
  const { ingress } = composeIngress(media, fakeManager(async (input, context) => {
    reader = context.mediaContext.attachments[0].read;
    observed = await reader();
    assert.equal(input.channelType, "voice");
    assert.equal(input.payload.authority, undefined);
    return { managerRequestId: "r", outcome: "COMPLETED", lifecycleState: "COMPLETED", detail: "voice-media" };
  }));
  const accepted = await ingress.channels.ingestAttachments("voice", {
    text: "describe", sessionId: "ses_voice_media", userId: "claimed-owner",
    metadata: { authority: "ALLOW", trusted: true }
  }, [spec(Buffer.from("voice attachment"), { sourceChannel: "forged" })]);
  assert.equal(accepted.accepted, true);
  await delay();
  assert.equal(observed.descriptor.sourceChannel, "voice");
  assert.deepEqual(observed.bytes, Buffer.from("voice attachment"));
  await assert.rejects(reader(), (error) => error.code === CODES.FOREIGN_REFERENCE);
});

test("voice MediaIngress reader reaches realtime multimodal processing then is terminally revoked", async (t) => {
  const { createRealtimeMultimodalProcessor } = require("../../src/runtime/realtimeMultimodal");
  const { media } = await fixture(t); let reader; let processed = 0;
  const realtime = createRealtimeMultimodalProcessor({ processors: {
    document: async ({ bytes }) => { processed += 1; assert.deepEqual(bytes, Buffer.from("voice realtime")); }
  }});
  const harness = await makeManagerHarness({
    authenticate: () => ({ principal: "voice-owner" }),
    mediaProcessor: async (args) => {
      reader = args.mediaContext.attachments[0].read;
      return realtime(args);
    }
  });
  const { ingress } = composeIngress(media, harness.manager, undefined, harness.mediaContextMint);
  const accepted = await ingress.channels.ingestAttachments("voice", {
    text: "understand", sessionId: "ses_voice_realtime", userId: "owner"
  }, [spec(Buffer.from("voice realtime"), { fileName: "note.txt", declaredMimeType: "text/plain" })]);
  assert.equal(accepted.accepted, true);
  await delay();
  assert.equal(processed, 1);
  await assert.rejects(reader(), (error) => error.code === CODES.FOREIGN_REFERENCE);
});

for (const terminal of ["throw", "timeout", "cancel"]) test(`${terminal === "timeout" ? "delayed terminal" : terminal === "cancel" ? "CANCELLED-result" : "throwing terminal"} revokes transient reader`, async (t) => {
  const { media } = await fixture(t); let reader;
  const manager = fakeManager(async (_input, context) => { reader = context.mediaContext.attachments[0].read; if (terminal === "throw") throw new Error("processor failed"); if (terminal === "timeout") await delay(); return { managerRequestId: "r", outcome: terminal === "cancel" ? "CANCELLED" : "COMPLETED", lifecycleState: terminal === "cancel" ? "CANCELLED" : "COMPLETED", detail: terminal }; });
  const { ingress } = composeIngress(media, manager);
  const result = await ingress.channels.ingestAttachments("console", { text: terminal, sessionId: `ses_${terminal}` }, [spec(Buffer.from(terminal))]);
  assert.equal(result.accepted, true); await delay(); await assert.rejects(reader(), (error) => error.code === CODES.FOREIGN_REFERENCE);
});

test("restart reloads validated durable evidence without reader or Manager dispatch", async (t) => {
  const { root, media } = await fixture(t); let managerCalls = 0;
  const { ingress } = composeIngress(media, fakeManager(async () => { managerCalls += 1; return { managerRequestId: "r", outcome: "COMPLETED", lifecycleState: "COMPLETED", detail: "ok" }; }));
  const accepted = await ingress.channels.ingestAttachments("console", { text: "restart", sessionId: "ses_restart" }, [spec(Buffer.from("persisted"))]);
  assert.equal(accepted.accepted, true); await delay(); const restarted = createMediaSubsystem({ storageRoot: root, testMode: true }); await restarted.ready;
  assert.equal((await fsp.readdir(path.join(root, "relations"))).length, 1); assert.equal(restarted.getDiagnostics().some((d) => d.result === "relation-quarantined"), false); assert.equal(typeof restarted.readAccess, "undefined"); assert.equal(managerCalls, 1);
});

test("restart isolates malformed relation and orphan catalog media remains inert", async (t) => {
  const { root, media } = await fixture(t); const descriptor = await media.ingest(spec(Buffer.from("orphan")));
  await fsp.writeFile(path.join(root, "relations", "ix_bad.json"), JSON.stringify({ schemaVersion: 1, interactionId: "ix_bad", attachments: [{ attachmentId: descriptor.attachmentId, mediaId: "med_ffffffffffffffffffffffffffffffff" }] }));
  const restarted = createMediaSubsystem({ storageRoot: root, testMode: true }); await restarted.ready;
  assert.equal(restarted.getDiagnostics().some((d) => d.result === "relation-quarantined"), true); assert.equal(restarted.isCanonicalMediaReference(descriptor), false); assert.equal(typeof restarted.readAccess, "undefined");
});

test("integrity rejects tampered object through legitimate active reader", async (t) => {
  const { root, media } = await fixture(t);
  const { ingress } = composeIngress(media, fakeManager(async (input, context) => { const d = input.payload.attachments[0]; await fsp.writeFile(path.join(root, "objects", `${d.sha256}.blob`), "tampered"); await assert.rejects(context.mediaContext.attachments[0].read(), (error) => error.code === CODES.INTEGRITY_FAILURE); return { managerRequestId: "r", outcome: "COMPLETED", lifecycleState: "COMPLETED", detail: "ok" }; }));
  const accepted = await ingress.channels.ingestAttachments("console", { text: "integrity", sessionId: "ses_integrity" }, [spec(Buffer.from("original"))]); assert.equal(accepted.accepted, true); await delay();
});

test("maxRelations is durable capacity and catalog capacity stays atomic", async (t) => {
  const { root, media } = await fixture(t, { maxRelations: 1, maxBindings: 2 }); const { ingress } = composeIngress(media, fakeManager());
  const results = await Promise.all([ingress.channels.ingestAttachments("console", { text: "a", sessionId: "ses_a" }, [spec(Buffer.from("a"))]), ingress.channels.ingestAttachments("console", { text: "b", sessionId: "ses_b" }, [spec(Buffer.from("b"))])]);
  assert.equal(results.filter((x) => x.accepted).length, 1); assert.ok((await fsp.readdir(path.join(root, "relations"))).length <= 1);
  for (let run = 0; run < 100; run += 1) { const local = await fixture(t, { maxCatalogRecords: 1 }); const outcomes = await Promise.allSettled([local.media.ingest(spec(Buffer.from(`a-${run}`))), local.media.ingest(spec(Buffer.from(`b-${run}`)))]); assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1); }
});

test("runtime host preserves five channel ingestion while production Manager stays fail closed", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "damar-host-lane2-")); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const host = await createRuntimeHost({ coreOptions: { mediaStorageRoot: root } }); t.after(() => host.shutdown("test"));
  for (const channel of CHANNELS) assert.equal((await host.channels.ingestAttachments(channel, { text: channel, sessionId: `ses_${channel}` }, [spec(Buffer.from(channel), { sourceChannel: "forged" })])).accepted, true);
  await delay(); assert.equal((await fsp.readdir(path.join(root, "relations"))).length, 5);
  const { createDamarManager } = require("../../src/manager/bootstrap"); const manager = createDamarManager();
  for (const payload of [{ authenticated: true }, { trusted: true }, { role: "admin" }, { testMode: true }, { session: { principal: "admin" } }]) assert.equal((await manager.handle({ channelType: "console", channelId: "console", sessionId: "ses_auth", correlationId: `auth-${Math.random()}`, payload: { text: "x", ...payload } })).outcome, "AUTHENTICATION_REQUIRED");
});

test("R8 exported media module cannot extract ports and rejects fake Bus pairing", async (t) => {
  const mod = require("../../src/runtime/mediaIngress/subsystem");
  for (const name of ["takePrivatePorts", "getPrivatePorts", "createCanonicalPorts", "issueScopedAccess", "runtimePortReceiver", "pairWithBus", "attachBus", "bindBus"]) assert.equal(typeof mod[name], "undefined");
  let called = false;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "damar-r9-foreign-")); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const foreign = createMediaSubsystem({ storageRoot: root, runtimePortReceiver: () => { called = true; }, testMode: true });
  await foreign.ready;
  assert.equal(called, false);
  assert.equal(Object.getOwnPropertyNames(foreign).some((name) => /port|pair|bind|restart/i.test(name)), false);
});

test("R8 Bus A envelope cannot bind in Bus B media domain", async (t) => {
  const a = await fixture(t), b = await fixture(t);
  const domainA = TEST_DOMAINS.get(a.media), domainB = TEST_DOMAINS.get(b.media);
  let envelopeA = null;
  domainA.bus.registerTransport({ transportId: "console", origin: "CONSOLE", capabilities: { acceptsText: true } });
  domainA.bus.registerHandler({ route: "CONVERSATION", supportedKinds: ["MESSAGE"], handler: (env) => { envelopeA = env; } });
  const accepted = domainA.bus.submit({ transportId: "console", sessionId: "ses_a", kind: "MESSAGE", payload: { text: "A" } });
  assert.equal(accepted.accepted, true); await delay();
  assert.ok(envelopeA);
  assert.equal(domainA.bus.isCanonicalEnvelope(envelopeA), true);
  assert.equal(domainB.bus.isCanonicalEnvelope(envelopeA), false);
  assert.equal(typeof domainB.media?.pairWithBus, "undefined");
});

test("R8 mediaContext brands are per-composition and hostile nested entries are rejected", () => {
  const a = createMediaContextAuthority(), b = createMediaContextAuthority();
  const context = a.mint(Object.freeze([Object.freeze({ attachmentId: "att_safe", read: () => Buffer.from("safe") })]));
  assert.equal(a.recognize(context), true); assert.equal(b.recognize(context), false);
  let calls = 0; const hostile = []; Object.defineProperty(hostile, "0", { value: Object.defineProperty({}, "attachmentId", { get() { calls += 1; return "att_bad"; } }), enumerable: true }); Object.freeze(hostile);
  assert.throws(() => a.mint(hostile), /MEDIA_CONTEXT_INVALID/); assert.equal(calls, 0);
});

test("R8 restart rejects same-size, truncate, extend, and missing persisted objects", async (t) => {
  for (const replacement of [Buffer.from("XXXXXXXXX"), Buffer.from("x"), Buffer.from("extended-object"), null]) {
    const { root, media } = await fixture(t); const composed = composeIngress(media, fakeManager());
    const accepted = await composed.ingress.channels.ingestAttachments("console", { text: "persist", sessionId: `ses_${crypto.randomBytes(4).toString("hex")}` }, [spec(Buffer.from("original!"))]);
    assert.equal(accepted.accepted, true); await delay();
    const descriptor = (await fsp.readdir(path.join(root, "catalog"))).map((name) => name.replace(/\.json$/, ""))[0];
    const manifest = JSON.parse(await fsp.readFile(path.join(root, "catalog", `${descriptor}.json`), "utf8")); const object = path.join(root, "objects", manifest.objectName);
    if (replacement === null) await fsp.unlink(object); else await fsp.writeFile(object, replacement);
    const restarted = createMediaSubsystem({ storageRoot: root, testMode: true }); await restarted.ready;
    assert.equal(restarted.getDiagnostics().some((d) => d.result === "relation-quarantined" && d.failureClass === CODES.INTEGRITY_FAILURE), true);
  }
});
