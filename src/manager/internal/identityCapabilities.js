"use strict";

/**
 * W8-IW1 embodiment identity persistence capability.
 *
 * The file store is an adapter only. This Manager-owned module is the sole
 * production owner of the consequential snapshot mutation driver. Registration
 * is availability, never authority; without a live owner-ratified grant the
 * driver is not entered.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sqlite3 = require("sqlite3");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const { DeviceIdentityService } = require("../../embodiment/identity/service");
const { CanonicalCapabilityExecution, OUTCOME } = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");
const { createCanonicalReplayLedger } = require("./canonicalReplayLedger");

const CAPABILITY_ID = "embodiment.identity.snapshot.write";
const OPERATION = "save";
const STATE = Object.freeze({
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    AUTHORIZED: "AUTHORIZED"
});
const runtimeGate = new WeakSet();

function cleanupTmp(file) { try { fs.unlinkSync(file); } catch { /* best effort */ } }

function sql(db, statement) {
    return new Promise((resolve, reject) => db.exec(statement, (error) => error ? reject(error) : resolve()));
}

async function acquireSnapshotLock(filePath) {
    const db = new sqlite3.Database(`${filePath}.lock.sqlite`);
    try {
        await sql(db, "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
        return db;
    } catch (error) {
        try { db.close(); } catch { /* best effort */ }
        if (error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")) return null;
        throw error;
    }
}

async function releaseSnapshotLock(db) {
    if (!db) return;
    try { await sql(db, "COMMIT"); }
    catch { try { await sql(db, "ROLLBACK"); } catch { /* closing releases the OS lock */ } }
    await new Promise((resolve) => db.close(() => resolve()));
}

/**
 * The revision-less format predates the snapshot fence.  It is deliberately
 * narrow: a missing revision is legacy only when the durable payload is an
 * identity snapshot we would otherwise be willing to restore.  In
 * particular, a malformed or partially-written file is never treated as a
 * revision-zero snapshot.
 */
function isTrustedLegacySnapshot(snapshot) {
    const shaped = snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot) &&
        snapshot.version === 1 && Array.isArray(snapshot.devices) &&
        Array.isArray(snapshot.transactions) &&
        !Object.prototype.hasOwnProperty.call(snapshot, "snapshotRevision");
    if (!shaped) return false;
    try {
        // This is the canonical restore validator, not a writer-local guess.
        DeviceIdentityService.restore(snapshot);
        return true;
    } catch {
        return false;
    }
}

function durableSnapshotRevision(filePath) {
    let durable;
    try {
        durable = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return { revision: 0, legacy: false, exists: false };
        return { error: "PID_SNAPSHOT_CORRUPT" };
    }
    if (durable === null || typeof durable !== "object" || Array.isArray(durable)) {
        return { error: "PID_SNAPSHOT_CORRUPT" };
    }
    if (!Object.prototype.hasOwnProperty.call(durable, "snapshotRevision")) {
        return isTrustedLegacySnapshot(durable)
            ? { revision: 0, legacy: true, exists: true }
            : { error: "PID_SNAPSHOT_CORRUPT" };
    }
    return Number.isSafeInteger(durable.snapshotRevision) && durable.snapshotRevision >= 0
        ? { revision: durable.snapshotRevision, legacy: false, exists: true }
        : { error: "PID_SNAPSHOT_CORRUPT" };
}

function createIdentityCapabilityRuntime({ authorityStore = null, acknowledge = null, replayStore = null } = {}) {
    const bridge = new CanonicalCapabilityExecution({ replayStore });
    bridge.installAuditAcknowledger(acknowledge ?? createCanonicalAuditAcknowledger());
    let invocations = 0;

    bridge.registerCapability({
        capabilityId: CAPABILITY_ID,
        operation: OPERATION,
        consequential: true,
        driverId: "embodiment.identity.snapshot.write",
        driver: async ({ parameters }) => {
            invocations++;
            const filePath = parameters.filePath;
            const payload = parameters.payload;
            const fsync = true;
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            let lockDb = null;
            try {
                lockDb = await acquireSnapshotLock(filePath);
                if (!lockDb) return { ok: false, code: "PID_SNAPSHOT_BUSY" };
                const next = JSON.parse(payload);
                if (next === null || typeof next !== "object" || Array.isArray(next)) return { ok:false, code:"PID_SNAPSHOT_CORRUPT" };
                const durable = durableSnapshotRevision(filePath);
                if (durable.error) return { ok:false, code:durable.error };
                const current = durable.revision;
                // A revision-less payload is accepted only for a genuinely new
                // snapshot or to upgrade a validated legacy durable snapshot.
                // Once a versioned snapshot exists, every writer must present
                // the exact durable claim; this is the stale-write fence.
                if (next.snapshotRevision === undefined && (!durable.exists || durable.legacy)) next.snapshotRevision = 0;
                if (!Number.isSafeInteger(next.snapshotRevision) || next.snapshotRevision !== current) return { ok:false, code:"PID_SNAPSHOT_STALE" };
                next.snapshotRevision = current + 1;
                fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
                if (fsync) {
                    const fd = fs.openSync(tmp, "r+");
                    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                }
                fs.renameSync(tmp, filePath);
                if (fsync && process.platform !== "win32") {
                    const dirFd = fs.openSync(path.dirname(filePath), "r");
                    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
                }
                return { ok: true, filePath, snapshotRevision: current + 1 };
            } catch (error) {
                cleanupTmp(tmp);
                return { ok: false, error: `gagal menulis snapshot identitas: ${error.message}` };
            } finally { await releaseSnapshotLock(lockDb); }
        }
    });
    // Internal verifier — NOT exported, owned exclusively by this capability module.
    bridge.registerVerifier(CAPABILITY_ID, async (_parameters, result) => ({ checks: [
        { name: "driver-returned-result", passed: result !== null && typeof result === "object" },
        // The adapter uses this deterministic refusal code to report a typed
        // commit conflict; canonical execution still cannot publish raw data
        // on a failed verification.
        { name: "snapshot-commit-succeeded", passed: result?.ok === true, code: result?.code ?? null }
    ] }));

    async function authorize({ identity = {}, scope = [], nowMs = Date.now() } = {}) {
        if (!authorityStore) return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_UNAVAILABLE" };
        try {
            const evaluation = await loadAndEvaluateAuthority(authorityStore, {
                capabilityId: CAPABILITY_ID, action: "execute", scope, identity, nowMs
            });
            return evaluation?.allowed === true
                ? { allowed: true, state: STATE.AUTHORIZED, reason: "AUTHORIZED", evaluation }
                : { allowed: false, state: STATE.AVAILABLE_BUT_NOT_AUTHORIZED, reason: evaluation?.reasonCode ?? "DENIED" };
        } catch (error) {
            return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_ERROR", detail: error.message };
        }
    }

    const runtime = Object.freeze({
        async execute({ operation, parameters = {}, requestId, identity = {}, scope = [], nowMs = Date.now(), signal = null } = {}) {
            const id = canonicalCapabilityId(CAPABILITY_ID);
            if (operation !== OPERATION) return { outcome: OUTCOME.REFUSED, reason: "OPERATION_UNBOUND", capabilityId: id, operation };
            const auth = await authorize({ identity, scope, nowMs });
            if (!auth.allowed) return { outcome: OUTCOME.DENIED, denied: true, state: auth.state, reason: auth.reason, capabilityId: id, operation };
            return bridge.execute({ capabilityId: id, operation, parameters, evaluation: auth.evaluation, requestId, signal });
        },
        invocationCount() { return invocations; },
        ratificationProposal({ principal = "owner", scope = [] } = {}) {
            const body = { capabilityId: CAPABILITY_ID, operation: OPERATION, family: "embodiment.identity", consequenceClass: "filesystem-mutation", principal, requestedScope: scope, status: "UNSIGNED_NOT_ACTIVE" };
            return Object.freeze({ kind: "OWNER_RATIFICATION_PROPOSAL", status: "UNSIGNED_NOT_ACTIVE", proposalDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"), ...body });
        }
    });
    runtimeGate.add(runtime);
    return runtime;
}

let installed = null;
function installIdentityCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) throw new TypeError("identity capability runtime was not created by this module");
    if (installed !== null) throw new Error("identity capability runtime already installed");
    installed = runtime;
    return true;
}
function identityRuntime() {
    if (installed === null) installed = createIdentityCapabilityRuntime({ replayStore: createCanonicalReplayLedger() });
    return installed;
}
function isIdentityCapabilityRuntime(runtime) { return runtimeGate.has(runtime); }

module.exports = {
    CAPABILITY_ID, OPERATION, STATE, createIdentityCapabilityRuntime,
    installIdentityCapabilityRuntime, identityRuntime, isIdentityCapabilityRuntime
};
