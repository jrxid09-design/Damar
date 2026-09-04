"use strict";

/**
 * OWNER TRUST INITIALIZATION ANCHOR (Wave 5 Lane 4 repair, OT-002).
 *
 * An independent durable marker recording the fact that this installation
 * HAS successfully enrolled a first Owner.  It exists so that loss,
 * deletion, or corruption of the PRIMARY mutable trust snapshot can never
 * recreate a false "fresh install" (NEVER_INITIALIZED) state.
 *
 * STATE MACHINE (domain level):
 *   NEVER_INITIALIZED   — no anchor exists and no snapshot exists.
 *   ACTIVE              — anchor present+valid AND snapshot loaded ok.
 *   RECOVERY_REQUIRED   — anchor present (or malformed) but the primary
 *                         snapshot is missing/corrupt; or the anchor itself
 *                         is malformed / carries an unknown version
 *                         (fail closed either way).
 *
 * Properties:
 *   - created ATOMICALLY (write-temp + rename, fsync) during first
 *     successful enrollment — never before the Owner commit;
 *   - independent from the primary snapshot file (separate file, separate
 *     content, own digest);
 *   - durable across restart;
 *   - NO deletion / reset API exists here.  Normal application code cannot
 *     remove the anchor except through the OS filesystem itself.  There is
 *     deliberately no "reset owner" convenience.
 *
 * HONEST BOUNDARY: this defends against accidental/partial state loss and
 * ordinary application access.  It does NOT defend against an omnipotent
 * machine administrator deleting every file on disk.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ANCHOR_VERSION = 1;
const ANCHOR_KIND = "damar-owner-trust-initialized";

function anchorError(code, message) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    return error;
}

/** The anchor file ALWAYS lives next to the primary snapshot. */
function anchorPathFor(snapshotPath) {
    const dir = path.dirname(snapshotPath);
    return path.join(dir, "ownertrust-initialized.json");
}

function readAnchorFile(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return { present: false, valid: false, reason: "ABSENT" };
        }
        return { present: true, valid: false, reason: "UNREADABLE" };
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return { present: true, valid: false, reason: "MALFORMED" };
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return { present: true, valid: false, reason: "MALFORMED" };
    }
    // Unknown version => fail closed.
    if (data.version !== ANCHOR_VERSION) {
        return { present: true, valid: false, reason: "VERSION_UNKNOWN" };
    }
    if (data.kind !== ANCHOR_KIND || typeof data.initializedAtMs !== "number" ||
        typeof data.anchorDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(data.anchorDigest)) {
        return { present: true, valid: false, reason: "MALFORMED" };
    }
    // Self-integrity: the recorded digest must match the record fields.
    const expect = crypto.createHash("sha256")
        .update(`${data.kind}|${data.version}|${data.initializedAtMs}|${data.principalId ?? ""}`)
        .digest("hex");
    if (expect !== data.anchorDigest) {
        return { present: true, valid: false, reason: "DIGEST_MISMATCH" };
    }
    return {
        present: true,
        valid: true,
        reason: "OK",
        principalId: typeof data.principalId === "string" ? data.principalId : null,
        initializedAtMs: data.initializedAtMs
    };
}

/**
 * Durable domain-state resolution over BOTH files.
 *   { state: NEVER_INITIALIZED | ACTIVE | RECOVERY_REQUIRED, ... }
 * `snapshotOk` is the caller's verified outcome of loading the primary
 * snapshot (true: loaded or genuinely absent; false: corrupt/invalid).
 * `snapshotExists` is whether the primary snapshot file exists at all —
 * an existing-but-unusable snapshot is evidence of prior initialization
 * even without an anchor (pre-anchor installs), so it never reads as a
 * fresh install.
 */
function resolveDomainState({ snapshotPath, snapshotOk, snapshotExists = null }) {
    if (snapshotExists === null) {
        snapshotExists = fs.existsSync(snapshotPath);
    }
    const anchor = readAnchorFile(anchorPathFor(snapshotPath));
    if (!snapshotOk) {
        // Corrupt/unusable primary state: recovery — never a fresh install.
        return Object.freeze({ state: "RECOVERY_REQUIRED", anchor });
    }
    if (!anchor.present && !snapshotExists) {
        return Object.freeze({ state: "NEVER_INITIALIZED", anchor });
    }
    if (anchor.present && !anchor.valid) {
        // Malformed/unknown anchor: fail closed, never a fresh install.
        return Object.freeze({ state: "RECOVERY_REQUIRED", anchor });
    }
    if (!anchor.present && snapshotExists) {
        // Snapshot exists but the anchor never did (legacy/pre-anchor state)
        // — treat as initialized-but-degraded: recovery, not fresh install.
        return Object.freeze({ state: "RECOVERY_REQUIRED", anchor });
    }
    return Object.freeze({ state: "ACTIVE", anchor });
}

/**
 * Atomically create the anchor.  Called ONLY after a first-Owner commit has
 * durably persisted the Owner.  Writing an anchor when one already exists
 * fails (the ceremony must never re-initialize).
 */
function writeAnchor(snapshotPath, { principalId, now }) {
    const filePath = anchorPathFor(snapshotPath);
    const existing = readAnchorFile(filePath);
    if (existing.present) {
        throw anchorError("OT_ANCHOR_EXISTS", "initialization anchor already exists");
    }
    const initializedAtMs = Math.floor(Number(now));
    const anchorDigest = crypto.createHash("sha256")
        .update(`${ANCHOR_KIND}|${ANCHOR_VERSION}|${initializedAtMs}|${principalId ?? ""}`)
        .digest("hex");
    const payload = JSON.stringify({
        version: ANCHOR_VERSION,
        kind: ANCHOR_KIND,
        initializedAtMs,
        principalId: typeof principalId === "string" ? principalId : null,
        anchorDigest
    }, null, 2);
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filePath);
    return Object.freeze({ path: filePath, initializedAtMs, principalId: principalId ?? null });
}

/** Diagnostics only — no mutation surface. */
function describeAnchor(snapshotPath) {
    const a = readAnchorFile(anchorPathFor(snapshotPath));
    return Object.freeze({
        path: anchorPathFor(snapshotPath),
        present: a.present,
        valid: a.valid,
        reason: a.reason
    });
}

module.exports = Object.freeze({
    ANCHOR_VERSION,
    ANCHOR_KIND,
    anchorPathFor,
    resolveDomainState,
    writeAnchor,
    describeAnchor
});
