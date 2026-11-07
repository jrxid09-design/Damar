"use strict";

/**
 * OWNER TRUST REGISTRY — the ONE narrow missing trust domain (Wave 5 Lane 4).
 *
 * Responsibility ONLY (hard scope):
 *   - human Owner principal record (stable, Authority-compatible, independent
 *     of deviceId / Telegram ID / WhatsApp JID / Console process / dsc id);
 *   - Admin membership / delegation trust state (OWNER-DELEGATED, never a
 *     second root);
 *   - credential descriptors (public verifier refs; private material lives in
 *     the Vault, NEVER here);
 *   - trust generations;
 *   - principal ↔ device membership;
 *   - principal ↔ transport bindings;
 *   - revocation state;
 *   - bootstrap state.
 *
 * NOT (explicitly out of scope — these belong to other owners):
 *   - secret storage            (Vault owns that);
 *   - permission grants         (Authority owns that — the sole decision maker);
 *   - session / conversation    (SessionStore owns that);
 *   - continuity engine         (Session Continuity owns that);
 *   - device identity/pairing   (DeviceIdentityService owns that).
 *
 * LAWS (binding):
 *   OWNER != DEVICE.  OWNER != CHANNEL PEER.  OWNER != SESSION.
 *   ADMIN != OWNER ROOT.  DEVICE IDENTITY != AUTHORITY.  PAIRING != AUTHORITY.
 *   TRANSPORT ID != DAMAR PRINCIPAL.  SESSION CONTINUITY != AUTHENTICATION.
 *   RESTORED SESSION != LIVE AUTHORITY.  PERSISTED TRUST != LIVE AUTHENTICATION.
 *   PROOF != AUTHORITY.  AUTHENTICATION != AUTHORIZATION.
 *   MODEL OUTPUT != AUTHORITY.  MODEL OUTPUT != TRUST MUTATION.
 *   PUBLIC DI != TRUST.  PUBLIC IMPORT != TRUST.  PUBLIC FACTORY != ROOT AUTHORITY.
 *
 * STATE SEMANTICS:
 *   UNENROLLED        — no Owner has ever been enrolled.
 *   ACTIVE            — an Owner (and possibly Admins) is enrolled and live.
 *   RECOVERY_REQUIRED — durable state is corrupt/missing AFTER having been
 *                       initialized; it must NEVER silently become UNENROLLED.
 *
 * REVOKED is recorded for credentials/bindings/admins/devices only where safe
 * successor/recovery semantics exist; the Owner PRINCIPAL itself is stable and
 * is not silently deleted.
 */

const OWNER_STATES = Object.freeze({
    UNENROLLED: "UNENROLLED",
    ACTIVE: "ACTIVE",
    RECOVERY_REQUIRED: "RECOVERY_REQUIRED"
});

const PRINCIPAL_KINDS = Object.freeze({
    OWNER: "owner",
    ADMIN: "admin"
});

const BINDING_KINDS = Object.freeze({
    DEVICE: "device",
    TRANSPORT: "transport"
});

const RECORD_VERSION = 1;

module.exports = Object.freeze({
    OWNER_STATES,
    PRINCIPAL_KINDS,
    BINDING_KINDS,
    RECORD_VERSION
});
