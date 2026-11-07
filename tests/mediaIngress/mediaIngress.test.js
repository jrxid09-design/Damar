"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const ib = require("../../src/runtime/interactionBus");
const { createMediaIngress } = require("../../src/runtime/mediaIngress/subsystem");

async function fixture(t, limits) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "damar-media-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let id = 0;
  const ingress = createMediaIngress({ storageRoot: root, limits, clock: () => 1000, idFactory: () => `fixture_${++id}`, testMode: true });
  return { root, ingress };
}
function spec(source, extra) {
  return { source, fileName: "note.txt", declaredMimeType: "text/plain", sourceChannel: "console", metadata: { messageId: "m1" }, ...extra };
}

test("media ingress: text becomes immutable integrity-addressed canonical media", async (t) => {
  const { ingress } = await fixture(t);
  const source = Buffer.from("hello damar");
  const ref = await ingress.ingest(spec(source));
  assert.equal(ref.kind, "document");
  assert.equal(ref.detectedMimeType, "text/plain");
  assert.equal(ref.sizeBytes, source.length);
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ref.storageRef, `media:${ref.mediaId}`);
  assert.equal(Object.isFrozen(ref), true);
  assert.equal(ingress.isCanonicalMediaReference(ref), true);
  assert.equal(ingress.isCanonicalMediaReference({ ...ref }), false);
});

test("media ingress: magic bytes defeat MIME and extension claims", async (t) => {
  const { ingress } = await fixture(t);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const ref = await ingress.ingest(spec(png, { fileName: "report.pdf", declaredMimeType: "application/pdf", sourceChannel: "telegram" }));
  assert.equal(ref.detectedMimeType, "image/png");
  assert.equal(ref.declaredMimeType, "application/pdf");
  assert.equal(ref.kind, "image");
});

test("media ingress: unknown binary is bounded inert data", async (t) => {
  const { ingress } = await fixture(t);
  const ref = await ingress.ingest(spec(Buffer.from([0, 1, 2, 3]), { fileName: "sample.bin", declaredMimeType: "application/octet-stream" }));
  assert.equal(ref.kind, "binary");
  assert.equal(ref.detectedMimeType, "application/octet-stream");
});

test("media ingress: per-file and aggregate bounds fail closed", async (t) => {
  const { ingress } = await fixture(t, { maxAttachmentBytes: 4, maxAggregateBytes: 6 });
  await assert.rejects(ingress.ingest(spec(Buffer.alloc(5))), (e) => e.code === "MEDIA_OVERSIZE");
  await assert.rejects(ingress.ingestMany([spec(Buffer.alloc(4)), spec(Buffer.alloc(3), { fileName: "b.txt" })]), (e) => e.code === "MEDIA_AGGREGATE_EXCEEDED");
});

test("media ingress: dangerous filenames and hostile coercion are rejected without invocation", async (t) => {
  const { ingress } = await fixture(t);
  for (const fileName of ["../evil", "..\\evil", "C:\\evil", "CON", "NUL.txt", "trail. "]) {
    await assert.rejects(ingress.ingest(spec(Buffer.from("x"), { fileName })), (e) => e.code === "MEDIA_INVALID_FILENAME");
  }
  let calls = 0;
  await assert.rejects(ingress.ingest(spec(Buffer.from("x"), { fileName: { toString() { calls += 1; return "ok.txt"; } } })), (e) => e.code === "MEDIA_INVALID_FILENAME");
  assert.equal(calls, 0);
});

test("media ingress: hostile metadata getters and proxies reject before access", async (t) => {
  const { ingress } = await fixture(t);
  let calls = 0;
  const metadata = {};
  Object.defineProperty(metadata, "trusted", { enumerable: true, get() { calls += 1; return true; } });
  await assert.rejects(ingress.ingest(spec(Buffer.from("x"), { metadata })), (e) => e.code === "MEDIA_INVALID_METADATA");
  await assert.rejects(ingress.ingest(spec(Buffer.from("x"), { metadata: new Proxy({}, {}) })), (e) => e.code === "MEDIA_INVALID_METADATA");
  assert.equal(calls, 0);
});

test("media ingress: partial stream leaves no published reference", async (t) => {
  const { root, ingress } = await fixture(t);
  async function* broken() { yield Buffer.from("part"); throw new Error("transport stopped"); }
  const source = ingress.testOnly.createTrustedByteSource(broken());
  await assert.rejects(ingress.ingest(spec(source)), (e) => e.code === "MEDIA_PARTIAL_READ");
  assert.deepEqual(await fsp.readdir(path.join(root, "staging")), []);
});

test("media ingress: duplicate bytes share storage identity but not descriptor provenance", async (t) => {
  const { ingress } = await fixture(t);
  const a = await ingress.ingest(spec(Buffer.from("same")));
  const b = await ingress.ingest(spec(Buffer.from("same"), { sourceChannel: "whatsapp" }));
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.storageRef, b.storageRef);
  assert.notEqual(a.attachmentId, b.attachmentId);
  assert.equal(ingress.isCanonicalMediaReference(a), true);
  assert.equal(ingress.isCanonicalMediaReference(b), true);
});

test("media ingress: executable and archive bytes are stored and never executed or extracted", async (t) => {
  const { root, ingress } = await fixture(t);
  let executions = 0;
  const script = Buffer.from("#!/bin/sh\nexit 99\n");
  const executable = await ingress.ingest(spec(script, { fileName: "payload.sh", declaredMimeType: "application/octet-stream", metadata: { execute: true } }));
  const archive = await ingress.ingest(spec(Buffer.from("504b030400000000", "hex"), { fileName: "bundle.zip", declaredMimeType: "application/zip" }));
  assert.equal(executions, 0);
  assert.equal(executable.kind, "document");
  assert.equal(archive.kind, "archive");
  assert.equal((await fsp.readdir(path.join(root, "objects"))).includes(`${archive.sha256}.blob`), true);
});

test("media ingress + InteractionBus: only owning ingress references cross attachment boundary", async (t) => {
  const { ingress } = await fixture(t);
  const foreign = (await fixture(t)).ingress;
  const media = await ingress.ingest(spec(Buffer.from("trusted"), { sourceChannel: "companion" }));
  const ids = ib.createSequentialIdFactory();
  const bus = ib.createInteractionBus({ clock: () => 1000, idFactory: ids, mediaIngress: ingress });
  bus.registerTransport({ transportId: "console.primary", origin: "CONSOLE", capabilities: { acceptsText: true } });
  const seen = [];
  bus.registerHandler({ route: "CONVERSATION", supportedKinds: ["MESSAGE"], handler: (env) => seen.push(env) });
  const submit = (attachment) => bus.submit({ transportId: "console.primary", sessionId: "ses_media", kind: "MESSAGE", payload: { text: "inspect", attachments: [attachment] } });
  assert.equal(submit({ ...media, trusted: true }).reason, "FOREIGN_MEDIA_REFERENCE");
  assert.equal(submit({ ...media }).reason, "FOREIGN_MEDIA_REFERENCE");
  const foreignRef = await foreign.ingest(spec(Buffer.from("trusted")));
  assert.equal(submit(foreignRef).reason, "FOREIGN_MEDIA_REFERENCE");
  const ok = submit(media);
  assert.equal(ok.accepted, true);
  assert.equal(seen[0].payload.attachments[0].sourceChannel, "companion");
  assert.notEqual(seen[0].payload.attachments[0], media);
  assert.equal(Object.isFrozen(seen[0].payload.attachments[0]), true);
});

test("media ingress: all channel sources use identical canonical semantics", async (t) => {
  const { ingress } = await fixture(t);
  for (const sourceChannel of ["console", "cli", "telegram", "whatsapp", "companion"]) {
    const ref = await ingress.ingest(spec(Buffer.from("same"), { sourceChannel }));
    assert.equal(ref.sha256.length, 64);
    assert.equal(ref.sourceChannel, sourceChannel);
    assert.equal(ref.kind, "document");
  }
});
