"use strict";

const {
    coerceRecoveryCapsuleId,
    coerceRecoveryEpochId,
    coerceRuntimeGenerationId,
    coerceSectionId
} = require("./ids");
const { CAPSULE_FORMAT_VERSION, CAPSULE_STATUS } = require("./manifest");
const { canonicalBytes } = require("./canonicalJson");
const { sha256Hex, isValidDigestFormat } = require("./digest");
const { isClassification } = require("./classification");
const { DiagnosticCollector } = require("./diagnostics");

/**
 * Structural + integrity validation of an UNTRUSTED wire capsule (R4).
 *
 * Every check fails closed. Unknown fields are rejected. Digests are
 * re-derived from payload bytes — a stored manifest hash is never trusted
 * as-is. Semantic validation delegates to the registered provider.
 */

function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(obj, expected) {
    const got = Object.keys(obj).sort();
    const want = [...expected].sort();
    return got.length === want.length && want.every((k, i) => got[i] === k);
}

function validateCapsule(wire, registry, config) {
    const diags = new DiagnosticCollector(config.maxDiagnostics);
    const ctx = { capsuleId: null };

    if (!isPlainObject(wire) || !isPlainObject(wire.manifest) || !isPlainObject(wire.sections)) {
        return { ok: false, capsuleId: null, diagnostics: finish(diags, "MALFORMED_SECTION", {}) };
    }

    const m = wire.manifest;
    if (
        !exactKeys(m, [
            "capsuleFormatVersion", "capsuleId", "parentCapsuleId", "epochId",
            "runtimeGenerationId", "createdAtMs", "reason", "status", "sections",
            "manifestDigest"
        ])
    ) {
        return { ok: false, capsuleId: null, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "manifest field set mismatch" }) };
    }
    if (!exactKeys(wire, ["manifest", "sections"])) {
        return { ok: false, capsuleId: null, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "capsule field set mismatch" }) };
    }
    if (!Array.isArray(m.sections)) {
        return { ok: false, capsuleId: null, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "sections must be array" }) };
    }

    try {
        ctx.capsuleId = coerceRecoveryCapsuleId(m.capsuleId);
        if (m.parentCapsuleId !== null) {
            coerceRecoveryCapsuleId(m.parentCapsuleId);
        }
        coerceRecoveryEpochId(m.epochId);
        coerceRuntimeGenerationId(m.runtimeGenerationId);
    } catch (err) {
        return { ok: false, capsuleId: null, diagnostics: finish(diags, "MALFORMED_ID", { message: err.message }) };
    }

    if (m.capsuleFormatVersion !== CAPSULE_FORMAT_VERSION) {
        return {
            ok: false,
            capsuleId: ctx.capsuleId,
            incompatible: true,
            diagnostics: finish(diags, "UNSUPPORTED_VERSION", {
                message: `capsuleFormatVersion ${JSON.stringify(m.capsuleFormatVersion)}`
            })
        };
    }
    if (m.status !== CAPSULE_STATUS.COMPLETE) {
        return {
            ok: false,
            capsuleId: ctx.capsuleId,
            diagnostics: finish(diags, "INCOMPLETE_CAPSULE", { message: `status=${String(m.status)}` })
        };
    }
    if (!Number.isSafeInteger(m.createdAtMs) || m.createdAtMs <= 0) {
        return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "createdAtMs" }) };
    }
    if (typeof m.reason !== "string" || m.reason.length === 0 || m.reason.length > config.maxCheckpointReasonLength) {
        return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "reason" }) };
    }

    if (m.sections.length > config.maxSections) {
        return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "TOO_MANY_SECTIONS", {}) };
    }

    const seenIds = new Set();
    let prevId = "";
    for (const entry of m.sections) {
        if (!isPlainObject(entry)) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "section entry" }) };
        }
        if (!exactKeys(entry, ["sectionId", "schemaVersion", "classification", "required", "byteLength", "digest"])) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "section entry field set" }) };
        }
        let sectionId;
        try {
            sectionId = coerceSectionId(entry.sectionId);
        } catch {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_ID", { sectionId: String(entry.sectionId) }) };
        }
        if (seenIds.has(sectionId)) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId, message: "duplicate section" }) };
        }
        seenIds.add(sectionId);
        if (!(sectionId > prevId)) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId, message: "sections not canonically ordered" }) };
        }
        prevId = sectionId;

        const provider = registry.lookupFromSerialized(sectionId);
        if (!provider) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "UNKNOWN_PROVIDER", { sectionId }) };
        }
        if (!Number.isSafeInteger(entry.schemaVersion)) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId, message: "schemaVersion" }) };
        }
        if (!isClassification(entry.classification) || entry.classification !== provider.classification) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId, message: "classification mismatch" }) };
        }
        if (entry.required !== provider.required) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId, message: "required flag mismatch" }) };
        }
    }

    const sectionIds = [...seenIds];
    for (const sectionId of sectionIds) {
        const raw = wire.sections[sectionId];
        const entry = m.sections.find((s) => s.sectionId === sectionId);
        if (!isPlainObject(raw) || !entry) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId, message: "missing section payload" }) };
        }
        if (!exactKeys(raw, ["schemaVersion", "data"])) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId, message: "payload field set" }) };
        }
    }
    if (wire.sections && Object.keys(wire.sections).length !== sectionIds.length) {
        return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { message: "extraneous section payload" }) };
    }

    for (const entry of m.sections) {
        const provider = registry.lookupFromSerialized(entry.sectionId);
        if (!provider) {
            continue;
        }
        const raw = wire.sections[entry.sectionId];
        if (raw.schemaVersion !== entry.schemaVersion) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "MALFORMED_SECTION", { sectionId: entry.sectionId, message: "schemaVersion mismatch between manifest and payload" }) };
        }
        if (raw.schemaVersion !== provider.schemaVersion) {
            return {
                ok: false,
                capsuleId: ctx.capsuleId,
                incompatible: true,
                diagnostics: finish(diags, "UNSUPPORTED_VERSION", { sectionId: entry.sectionId, message: `schemaVersion ${raw.schemaVersion}` })
            };
        }

        let bytes;
        try {
            bytes = canonicalBytes(raw);
        } catch (err) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "SCHEMA_INVALID", { sectionId: entry.sectionId, message: err.message }) };
        }
        if (bytes.byteLength !== entry.byteLength) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "INVALID_DIGEST", { sectionId: entry.sectionId, message: "byteLength mismatch" }) };
        }
        if (bytes.byteLength > config.maxSectionBytes) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "SECTION_TOO_LARGE", { sectionId: entry.sectionId }) };
        }
        const actualDigest = sha256Hex(bytes);
        if (!isValidDigestFormat(entry.digest) || actualDigest !== entry.digest) {
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "INVALID_DIGEST", { sectionId: entry.sectionId }) };
        }

        const verdict = provider.validateSection(raw.data);
        if (verdict !== true) {
            const message = verdict && typeof verdict === "object" ? verdict.message : "provider rejected section";
            return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "PROVIDER_REJECTED", { sectionId: entry.sectionId, message }) };
        }
    }

    // Whole-capsule canonical size bound over the exact durable material
    // (manifest including its digest + every section payload).
    const totalBytes = canonicalBytes({ manifest: m, sections: wire.sections }).byteLength;
    if (totalBytes > config.maxCapsuleBytes) {
        return {
            ok: false,
            capsuleId: ctx.capsuleId,
            diagnostics: finish(diags, "CAPSULE_TOO_LARGE", { message: `canonical capsule is ${totalBytes} bytes` })
        };
    }

    const material = buildMaterialForDigest(m);
    const actualManifestDigest = sha256Hex(canonicalBytes(material));
    if (!isValidDigestFormat(m.manifestDigest) || actualManifestDigest !== m.manifestDigest) {
        return { ok: false, capsuleId: ctx.capsuleId, diagnostics: finish(diags, "INVALID_DIGEST", { message: "manifest digest mismatch" }) };
    }

    return { ok: true, capsuleId: ctx.capsuleId, diagnostics: Object.freeze([]), manifest: m };
}

function buildMaterialForDigest(m) {
    const { buildManifestMaterial } = require("./manifest");
    return buildManifestMaterial({
        capsuleId: m.capsuleId,
        parentCapsuleId: m.parentCapsuleId,
        epochId: m.epochId,
        runtimeGenerationId: m.runtimeGenerationId,
        createdAtMs: m.createdAtMs,
        reason: m.reason,
        status: m.status,
        sections: m.sections
    });
}

function finish(collector, code, details) {
    collector.add(code, details);
    return collector.snapshot();
}

module.exports = Object.freeze({ validateCapsule });
