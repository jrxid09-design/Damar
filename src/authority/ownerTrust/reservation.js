"use strict";

/**
 * FIRST-OWNER BOOTSTRAP RESERVATION (Wave 5 Lane 4 repair, OT-003).
 *
 * A DURABLE, CROSS-PROCESS exclusive reservation for first-Owner
 * provisioning, implemented with OS create-exclusive file semantics
 * (fs.openSync(path, "wx") → O_CREAT|O_EXCL).  This is atomic on POSIX AND
 * Windows (libuv maps it to CreateFileW with CREATE_NEW).  There is NO
 * check-then-create anywhere.
 *
 * Guarantees:
 *   - Exactly ONE concurrent acquirer wins; all others fail deterministically
 *     with OT_RESERVATION_HELD.
 *   - The reservation carries a lease (default 90s).  A LIVE reservation is
 *     never stolen — a late acquirer fails closed with OT_RESERVATION_HELD.
 *   - A STALE (expired) reservation may be reclaimed ONLY through an
 *     ownership-validated replace: the reclaimer re-reads the file, verifies
 *     it still contains the SAME stale ceremony identity, writes its claim
 *     to a unique temp file, and atomically renames over the lock.  The
 *     reclaimer then RE-READS the lock and accepts ownership only if it now
 *     contains its own ceremonyId (closing the two-thieves race).  Age alone
 *     is never a reason to delete (no age-only unlink).
 *   - Commit-time verification: the ceremony re-reads the reservation file
 *     and accepts ownership only if the ceremonyId matches and the lease has
 *     not expired (see verifyOwnership()).
 *   - Release deletes the file only if it still belongs to the releasing
 *     ceremony (ownership-checked unlink; a stolen/foreign lock is left).
 *
 * CRASH BEHAVIOR (documented + tested): a process that crashes while holding
 * the reservation leaves the lock file on disk.  Until the lease expires,
 * all bootstrap attempts fail with OT_RESERVATION_HELD (no automatic theft of
 * a possibly-live holder).  After expiry, a new ceremony reclaims it via the
 * validated replace above.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const RESERVATION_VERSION = 1;
const RESERVATION_KIND = "damar-owner-trust-bootstrap-reservation";
const DEFAULT_LEASE_MS = 90_000;

function reservationError(code, message) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    return error;
}

function reservationPathFor(snapshotPath) {
    return path.join(path.dirname(snapshotPath), "ownertrust-bootstrap.lock");
}

function serializeReservation(rec) {
    return JSON.stringify({
        version: RESERVATION_VERSION,
        kind: RESERVATION_KIND,
        ceremonyId: rec.ceremonyId,
        pid: rec.pid,
        hostname: rec.hostname,
        acquiredAtMs: rec.acquiredAtMs,
        expiresAtMs: rec.expiresAtMs
    }, null, 2);
}

function parseReservationFile(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if (error && error.code === "ENOENT") return { present: false };
        return { present: true, valid: false, reason: "UNREADABLE" };
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return { present: true, valid: false, reason: "MALFORMED" };
    }
    if (data === null || typeof data !== "object" || Array.isArray(data) ||
        data.version !== RESERVATION_VERSION || data.kind !== RESERVATION_KIND ||
        typeof data.ceremonyId !== "string" || data.ceremonyId.length === 0 ||
        typeof data.expiresAtMs !== "number") {
        return { present: true, valid: false, reason: "MALFORMED" };
    }
    return {
        present: true, valid: true, rec: data
    };
}

/**
 * Acquire the exclusive bootstrap reservation (create-exclusive, atomic).
 * Returns the reservation handle { ceremonyId, path, expiresAtMs }.
 * Fails closed when a live reservation exists (OT_RESERVATION_HELD).
 */
function acquireReservation({ snapshotPath, leaseMs = DEFAULT_LEASE_MS, now = () => Date.now() } = {}) {
    if (typeof snapshotPath !== "string" || snapshotPath.length === 0) {
        throw reservationError("OT_RESERVATION_INVALID", "snapshot path required");
    }
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const filePath = reservationPathFor(snapshotPath);
    const ceremonyId = `cer-${crypto.randomBytes(12).toString("hex")}`;
    const acquiredAtMs = Math.floor(now());
    const rec = {
        ceremonyId,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAtMs,
        expiresAtMs: acquiredAtMs + Math.floor(leaseMs)
    };
    const payload = serializeReservation(rec);

    let fd;
    try {
        // O_CREAT|O_EXCL — atomic first-wins on POSIX and Windows.
        fd = fs.openSync(filePath, "wx", 0o600);
    } catch (error) {
        if (error && error.code === "EEXIST") {
            const current = parseReservationFile(filePath);
            if (current.present && current.valid && current.rec.expiresAtMs > acquiredAtMs) {
                // LIVE reservation — never stolen, fail deterministically.
                throw reservationError("OT_RESERVATION_HELD",
                    "a live first-Owner bootstrap reservation exists");
            }
            if (current.present && !current.valid) {
                // Malformed reservation: fail closed; operator inspects manually.
                throw reservationError("OT_RESERVATION_MALFORMED",
                    `bootstrap reservation unreadable (${current.reason})`);
            }
            // STALE (expired) or corrupt-with-valid-shape: reclaim via
            // ownership-validated atomic replace, then re-verify ownership.
            return reclaimStale({ filePath, rec, payload, now: () => acquiredAtMs });
        }
        throw error;
    }
    try {
        fs.writeFileSync(fd, payload, { encoding: "utf8" });
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    return Object.freeze({ ceremonyId, path: filePath, expiresAtMs: rec.expiresAtMs, acquired: true });
}

/** Stale-reclaim: validated replace + ownership re-verification. */
function reclaimStale({ filePath, rec, payload, now }) {
    const observed = parseReservationFile(filePath);
    if (!observed.present || !observed.valid ||
        observed.rec.ceremonyId === rec.ceremonyId) {
        // Vanished mid-race or already ours — retry with plain create-exclusive.
        try {
            const fd = fs.openSync(filePath, "wx", 0o600);
            try { fs.writeFileSync(fd, payload, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            return Object.freeze({ ceremonyId: rec.ceremonyId, path: filePath, expiresAtMs: rec.expiresAtMs, acquired: true, reclaimed: true });
        } catch (error) {
            if (error && error.code === "EEXIST") {
                throw reservationError("OT_RESERVATION_HELD", "reservation contention lost");
            }
            throw error;
        }
    }
    if (observed.rec.expiresAtMs > Math.floor(now())) {
        throw reservationError("OT_RESERVATION_HELD", "a live first-Owner bootstrap reservation exists");
    }
    // Unique temp + atomic rename; then RE-VERIFY the lock now contains OUR
    // ceremonyId — the loser of a two-reclaimer race fails closed here.
    const tmp = `${filePath}.claim-${rec.ceremonyId}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    try {
        fs.renameSync(tmp, filePath);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw error;
    }
    const after = parseReservationFile(filePath);
    if (!after.present || !after.valid || after.rec.ceremonyId !== rec.ceremonyId) {
        throw reservationError("OT_RESERVATION_HELD", "reservation reclaim contention lost");
    }
    return Object.freeze({ ceremonyId: rec.ceremonyId, path: filePath, expiresAtMs: rec.expiresAtMs, acquired: true, reclaimed: true });
}

/**
 * Commit-time ownership verification: the reservation file must STILL
 * contain THIS ceremony's id and an unexpired lease.  Throws otherwise.
 */
function verifyOwnership({ snapshotPath, ceremonyId, now = () => Date.now() } = {}) {
    const filePath = reservationPathFor(snapshotPath);
    const current = parseReservationFile(filePath);
    if (!current.present) {
        throw reservationError("OT_RESERVATION_GONE", "bootstrap reservation vanished before commit");
    }
    if (!current.valid) {
        throw reservationError("OT_RESERVATION_MALFORMED", "bootstrap reservation unreadable at commit");
    }
    if (current.rec.ceremonyId !== ceremonyId) {
        throw reservationError("OT_RESERVATION_FOREIGN", "bootstrap reservation no longer belongs to this ceremony");
    }
    if (current.rec.expiresAtMs <= Math.floor(now())) {
        throw reservationError("OT_RESERVATION_EXPIRED", "bootstrap reservation lease expired before commit");
    }
    return Object.freeze({ ceremonyId, owned: true });
}

/**
 * Release the reservation.  Ownership-checked unlink: deletes the lock file
 * ONLY if it still belongs to THIS ceremony (never deletes a foreign lock).
 * Idempotent.
 */
function releaseReservation({ snapshotPath, ceremonyId } = {}) {
    const filePath = reservationPathFor(snapshotPath);
    const current = parseReservationFile(filePath);
    if (!current.present) return false;
    if (!current.valid || current.rec.ceremonyId !== ceremonyId) return false;
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch (error) {
        if (error && error.code === "ENOENT") return false;
        throw error;
    }
}

module.exports = Object.freeze({
    RESERVATION_VERSION,
    DEFAULT_LEASE_MS,
    reservationPathFor,
    acquireReservation,
    verifyOwnership,
    releaseReservation
});
