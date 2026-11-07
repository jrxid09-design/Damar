"use strict";

const { types } = require("node:util");

const DEFAULT_LIMITS = Object.freeze({
    maxAttachments: 8,
    maxAttachmentBytes: 25 * 1024 * 1024,
    maxAggregateBytes: 50 * 1024 * 1024,
    processorTimeoutMs: 15_000
});

const PROCESSABLE = new Set(["image", "document", "audio", "video"]);

function fail(code) {
    throw Object.assign(new Error(code), { code });
}

function plain(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function boundedLimits(input) {
    if (input === undefined) return DEFAULT_LIMITS;
    if (!plain(input)) fail("MULTIMODAL_LIMITS_INVALID");
    const out = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(out)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor) {
            if (!("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value <= 0) {
                fail("MULTIMODAL_LIMITS_INVALID");
            }
            out[key] = descriptor.value;
        }
    }
    return Object.freeze(out);
}

function starts(bytes, signature) {
    if (bytes.length < signature.length) return false;
    for (let i = 0; i < signature.length; i += 1) if (bytes[i] !== signature[i]) return false;
    return true;
}

function ascii(bytes, offset, length) {
    return bytes.length >= offset + length ? bytes.subarray(offset, offset + length).toString("ascii") : "";
}

function validateFormat(descriptor, bytes) {
    const mime = descriptor.detectedMimeType;
    if (descriptor.kind === "image") {
        if (mime === "image/jpeg") return starts(bytes, [0xff, 0xd8, 0xff]);
        if (mime === "image/png") return starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        if (mime === "image/gif") return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
        if (mime === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
        return false;
    }
    if (descriptor.kind === "document") {
        if (mime === "application/pdf") return ascii(bytes, 0, 5) === "%PDF-";
        if (mime === "application/json") {
            try { JSON.parse(bytes.toString("utf8")); return true; } catch { return false; }
        }
        if (mime === "text/plain" || mime === "text/csv") return !bytes.includes(0);
        if (mime === "application/msword") return starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        return false;
    }
    if (descriptor.kind === "audio") {
        if (mime === "audio/wav" || mime === "audio/x-wav") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
        if (mime === "audio/mpeg") return ascii(bytes, 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
        if (mime === "audio/ogg") return ascii(bytes, 0, 4) === "OggS";
        if (mime === "audio/flac") return ascii(bytes, 0, 4) === "fLaC";
        if (mime === "audio/mp4" || mime === "audio/aac") return ascii(bytes, 4, 4) === "ftyp";
        return false;
    }
    if (descriptor.kind === "video") {
        if (mime === "video/mp4" || mime === "video/quicktime") return ascii(bytes, 4, 4) === "ftyp";
        if (mime === "video/webm" || mime === "video/x-matroska") return starts(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
        return false;
    }
    return false;
}

function frozenResult(attachmentId, kind, status, code) {
    return Object.freeze({ attachmentId, kind, status, code });
}

async function boundedOperation(operation, signal, timeoutMs) {
    if (signal?.aborted) fail("MULTIMODAL_CANCELLED");
    let timer;
    let onAbort;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("MULTIMODAL_TIMEOUT"), { code: "MULTIMODAL_TIMEOUT" })), timeoutMs);
        timer.unref?.();
    });
    const aborted = signal ? new Promise((_, reject) => {
        onAbort = () => reject(Object.assign(new Error("MULTIMODAL_CANCELLED"), { code: "MULTIMODAL_CANCELLED" }));
        signal.addEventListener("abort", onAbort, { once: true });
    }) : new Promise(() => {});
    try {
        const observed = Promise.resolve().then(operation).then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error })
        );
        const outcome = await Promise.race([observed, timeout, aborted]);
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
    }
    finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

function createRealtimeMultimodalProcessor({ processors = {}, limits } = {}) {
    if (!plain(processors)) fail("MULTIMODAL_PROCESSORS_INVALID");
    const configured = Object.create(null);
    for (const kind of PROCESSABLE) {
        const descriptor = Object.getOwnPropertyDescriptor(processors, kind);
        if (descriptor) {
            if (!("value" in descriptor) || typeof descriptor.value !== "function") fail("MULTIMODAL_PROCESSORS_INVALID");
            configured[kind] = descriptor.value;
        }
    }
    const bounds = boundedLimits(limits);

    return async function processRealtimeMedia({ mediaContext, request, signal } = {}) {
        if (!mediaContext || !Array.isArray(mediaContext.attachments) || !Object.isFrozen(mediaContext.attachments)) {
            fail("MULTIMODAL_CONTEXT_INVALID");
        }
        if (mediaContext.attachments.length > bounds.maxAttachments) fail("MULTIMODAL_ATTACHMENT_LIMIT");
        let aggregate = 0;
        const results = [];
        for (const attachment of mediaContext.attachments) {
            if (signal?.aborted) fail("MULTIMODAL_CANCELLED");
            const read = Object.getOwnPropertyDescriptor(attachment, "read");
            const id = Object.getOwnPropertyDescriptor(attachment, "attachmentId");
            if (!read || !("value" in read) || typeof read.value !== "function" || !id || !("value" in id)) {
                fail("MULTIMODAL_CONTEXT_INVALID");
            }
            const content = await boundedOperation(read.value, signal, bounds.processorTimeoutMs);
            if (!content || !plain(content.descriptor) || !Buffer.isBuffer(content.bytes)) fail("MULTIMODAL_READ_INVALID");
            const descriptor = content.descriptor;
            if (descriptor.attachmentId !== id.value) fail("MULTIMODAL_DESCRIPTOR_MISMATCH");
            if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes !== content.bytes.length || descriptor.sizeBytes > bounds.maxAttachmentBytes) {
                fail("MULTIMODAL_ATTACHMENT_LIMIT");
            }
            aggregate += descriptor.sizeBytes;
            if (aggregate > bounds.maxAggregateBytes) fail("MULTIMODAL_AGGREGATE_LIMIT");
            if (descriptor.kind === "archive" || descriptor.kind === "binary") {
                results.push(frozenResult(id.value, descriptor.kind, "DEGRADED", "INERT_UNSUPPORTED"));
                continue;
            }
            if (!PROCESSABLE.has(descriptor.kind) || !validateFormat(descriptor, content.bytes)) {
                results.push(frozenResult(id.value, descriptor.kind, "DEGRADED", "FORMAT_INVALID_OR_UNSUPPORTED"));
                continue;
            }
            const provider = configured[descriptor.kind];
            if (!provider) {
                results.push(frozenResult(id.value, descriptor.kind, "DEGRADED", "PROCESSOR_UNAVAILABLE"));
                continue;
            }
            if (signal?.aborted) fail("MULTIMODAL_CANCELLED");
            const scopedBytes = Buffer.from(content.bytes);
            try {
                await boundedOperation(
                    () => provider(Object.freeze({ descriptor, bytes: scopedBytes, request, signal })),
                    signal,
                    bounds.processorTimeoutMs
                );
            }
            finally {
                scopedBytes.fill(0);
            }
            results.push(frozenResult(id.value, descriptor.kind, "PROCESSED", "OK"));
        }
        return Object.freeze(results);
    };
}

module.exports = Object.freeze({ createRealtimeMultimodalProcessor, DEFAULT_LIMITS, validateFormat });
