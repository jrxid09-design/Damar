"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { types: utilTypes } = require("node:util");
const { sniffMime, mediaKind } = require("./mime");
const { CODES, MediaIngressError } = require("./errors");

const DEFAULT_LIMITS = Object.freeze({
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxAttachmentsPerInteraction: 8,
  maxAggregateBytes: 50 * 1024 * 1024,
  maxFilenameLength: 180,
  maxMetadataBytes: 2048,
  maxMetadataKeys: 24,
  maxSniffBytes: 8192
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const CHANNELS = new Set(["console", "cli", "telegram", "whatsapp", "companion", "camera", "audio", "http", "api"]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fail(code, message, details) { throw new MediaIngressError(code, message, details); }
function safeObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  return Object.getOwnPropertyNames(value).every((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && Object.prototype.hasOwnProperty.call(d, "value");
  });
}
function own(value, key) {
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && Object.prototype.hasOwnProperty.call(d, "value") ? d.value : undefined;
}
function resolveLimits(input) {
  if (input !== undefined && !safeObject(input)) fail(CODES.INVALID_INPUT, "limits must be inert data");
  const limits = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    const value = input === undefined ? undefined : own(input, key);
    if (value !== undefined) limits[key] = value;
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) fail(CODES.INVALID_INPUT, "invalid media bound", { field: key });
  }
  return Object.freeze(limits);
}
function validateName(value, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\\/\u0000-\u001f\u007f]/u.test(value) || value === "." || value === ".." || value.endsWith(".") || value.endsWith(" ") || RESERVED.test(value) || path.isAbsolute(value)) {
    fail(CODES.INVALID_FILENAME, "filename metadata is unsafe");
  }
  return value.normalize("NFC");
}
function validateMetadata(value, limits) {
  if (value === undefined) return Object.freeze({});
  if (!safeObject(value)) fail(CODES.INVALID_METADATA, "metadata must be inert data");
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > limits.maxMetadataKeys) fail(CODES.INVALID_METADATA, "metadata exceeds key bound");
  const out = Object.create(null);
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) fail(CODES.INVALID_METADATA, "metadata key rejected");
    const item = own(value, key);
    if (!(item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))) fail(CODES.INVALID_METADATA, "metadata value rejected");
    out[key] = item;
  }
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > limits.maxMetadataBytes) fail(CODES.INVALID_METADATA, "metadata exceeds byte bound");
  return Object.freeze(out);
}
function safeDescriptor(source, values) {
  return Object.freeze({
    attachmentId: values.attachmentId,
    kind: values.kind,
    declaredMimeType: values.declaredMimeType,
    detectedMimeType: values.detectedMimeType,
    fileName: values.fileName,
    sizeBytes: values.sizeBytes,
    sha256: values.sha256,
    sourceChannel: source,
    storageRef: values.storageRef,
    metadata: values.metadata,
    ingestedAt: values.ingestedAt,
    detectionConfidence: values.detectedMimeType === "application/octet-stream" ? "unknown" : "signature"
  });
}

function createMediaIngress(options) {
  if (!safeObject(options)) fail(CODES.INVALID_INPUT, "media ingress options must be inert data");
  const rootValue = own(options, "storageRoot");
  if (typeof rootValue !== "string" || !path.isAbsolute(rootValue)) fail(CODES.INVALID_INPUT, "storageRoot must be an absolute Damar-controlled path");
  const storageRoot = path.resolve(rootValue);
  const limits = resolveLimits(own(options, "limits"));
  const references = new WeakSet();
  const diagnostics = [];
  const now = typeof own(options, "clock") === "function" ? own(options, "clock") : Date.now;
  const idFactory = typeof own(options, "idFactory") === "function" ? own(options, "idFactory") : () => crypto.randomUUID().replace(/-/g, "");

  function record(result, detail) {
    diagnostics.push(Object.freeze({ at: now(), result, ...detail }));
    while (diagnostics.length > 100) diagnostics.shift();
  }
  async function init() { await fsp.mkdir(path.join(storageRoot, "objects"), { recursive: true }); await fsp.mkdir(path.join(storageRoot, "tmp"), { recursive: true }); }
  function sourceIterable(source) {
    if (Buffer.isBuffer(source)) return (async function* () { yield Buffer.from(source); }());
    if (source && typeof source[Symbol.asyncIterator] === "function") return source;
    fail(CODES.UNSUPPORTED_SOURCE, "source must be a Buffer or async iterable");
  }
  async function ingest(spec) {
    const started = now();
    if (!safeObject(spec)) fail(CODES.INVALID_INPUT, "ingress spec must be inert data");
    const fileName = validateName(own(spec, "fileName"), limits.maxFilenameLength);
    const sourceChannel = own(spec, "sourceChannel");
    if (typeof sourceChannel !== "string" || !CHANNELS.has(sourceChannel.toLowerCase())) fail(CODES.INVALID_INPUT, "sourceChannel rejected");
    const declared = own(spec, "declaredMimeType");
    if (declared !== undefined && declared !== null && (typeof declared !== "string" || !MIME_RE.test(declared))) fail(CODES.INVALID_INPUT, "declared MIME rejected");
    const metadata = validateMetadata(own(spec, "metadata"), limits);
    const expectedSize = own(spec, "expectedSizeBytes");
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > limits.maxAttachmentBytes)) fail(CODES.OVERSIZE, "declared size exceeds attachment bound");
    await init();
    const tempId = idFactory();
    if (typeof tempId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(tempId)) fail(CODES.STORAGE_FAILURE, "internal id generation failed");
    const tempPath = path.join(storageRoot, "tmp", `${tempId}.partial`);
    const hash = crypto.createHash("sha256");
    const sniff = [];
    let sniffLength = 0;
    let size = 0;
    let handle;
    let phase = "storage";
    try {
      handle = await fsp.open(tempPath, "wx", 0o600);
      phase = "reading";
      for await (const rawChunk of sourceIterable(own(spec, "source"))) {
        if (!(Buffer.isBuffer(rawChunk) || rawChunk instanceof Uint8Array)) fail(CODES.PARTIAL_READ, "stream yielded non-byte data");
        const chunk = Buffer.from(rawChunk);
        size += chunk.length;
        if (size > limits.maxAttachmentBytes) fail(CODES.OVERSIZE, "attachment exceeds byte bound");
        if (sniffLength < limits.maxSniffBytes) {
          const part = chunk.subarray(0, limits.maxSniffBytes - sniffLength);
          sniff.push(Buffer.from(part)); sniffLength += part.length;
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) fail(CODES.PARTIAL_READ, "partial storage write");
          offset += bytesWritten;
        }
      }
      phase = "storage";
      if (expectedSize !== undefined && size !== expectedSize) fail(CODES.PARTIAL_READ, "received size differs from declared size");
      await handle.sync();
      const stored = await handle.stat();
      if (!stored.isFile() || stored.size !== size) fail(CODES.PARTIAL_READ, "stored byte count mismatch");
      await handle.close(); handle = undefined;
      const sha256 = hash.digest("hex");
      const detectedMimeType = sniffMime(Buffer.concat(sniff));
      const objectDir = path.join(storageRoot, "objects", sha256.slice(0, 2));
      const finalPath = path.join(objectDir, sha256);
      await fsp.mkdir(objectDir, { recursive: true });
      try { await fsp.rename(tempPath, finalPath); }
      catch (error) {
        if (error.code === "EEXIST") await fsp.unlink(tempPath);
        else throw error;
      }
      const descriptor = safeDescriptor(sourceChannel.toLowerCase(), {
        attachmentId: `att_${tempId}`,
        kind: mediaKind(detectedMimeType), declaredMimeType: declared || null, detectedMimeType,
        fileName, sizeBytes: size, sha256, storageRef: `media:sha256:${sha256}`,
        metadata, ingestedAt: now()
      });
      references.add(descriptor);
      record("accepted", { attachmentId: descriptor.attachmentId, sizeBytes: size, kind: descriptor.kind, sha256, sourceChannel: descriptor.sourceChannel, durationMs: Math.max(0, now() - started) });
      return descriptor;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fsp.unlink(tempPath).catch(() => {});
      const wrapped = error instanceof MediaIngressError ? error : new MediaIngressError(phase === "reading" ? CODES.PARTIAL_READ : CODES.STORAGE_FAILURE, phase === "reading" ? "media read interrupted" : "media storage failed");
      record("rejected", { failureClass: wrapped.code, durationMs: Math.max(0, now() - started) });
      throw wrapped;
    }
  }
  async function ingestMany(specs) {
    if (!Array.isArray(specs) || utilTypes.isProxy(specs) || specs.length > limits.maxAttachmentsPerInteraction) fail(CODES.AGGREGATE_EXCEEDED, "attachment count exceeds bound");
    let aggregate = 0; const out = [];
    for (const spec of specs) {
      const expected = safeObject(spec) ? own(spec, "expectedSizeBytes") : undefined;
      if (Number.isSafeInteger(expected) && aggregate + expected > limits.maxAggregateBytes) fail(CODES.AGGREGATE_EXCEEDED, "aggregate bytes exceed bound");
      const descriptor = await ingest(spec); aggregate += descriptor.sizeBytes;
      if (aggregate > limits.maxAggregateBytes) fail(CODES.AGGREGATE_EXCEEDED, "aggregate bytes exceed bound");
      out.push(descriptor);
    }
    return Object.freeze(out);
  }
  function isCanonicalMediaReference(value) { return value !== null && typeof value === "object" && references.has(value); }
  function assertCanonicalMediaReference(value) { if (!isCanonicalMediaReference(value)) fail(CODES.FOREIGN_REFERENCE, "foreign media reference rejected"); return value; }
  function openReadStream(value) {
    const ref = assertCanonicalMediaReference(value);
    const finalPath = path.join(storageRoot, "objects", ref.sha256.slice(0, 2), ref.sha256);
    return fs.createReadStream(finalPath, { flags: "r" });
  }
  function getDiagnostics() { return Object.freeze(diagnostics.slice()); }
  return Object.freeze({ limits, ingest, ingestMany, isCanonicalMediaReference, assertCanonicalMediaReference, openReadStream, getDiagnostics });
}

module.exports = { createMediaIngress, DEFAULT_LIMITS, MediaIngressError, CODES };
