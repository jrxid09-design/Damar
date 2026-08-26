/**
 * DeviceIdentityService (I§3) — canonical identity + pairing lifecycle.
 *
 * ISOLATION CONTRACT (proven by tests/pairingIsolation.test.js):
 *   - this module requires ONLY node builtins and sibling embodiment
 *     modules. It never loads src/authority, src/channels, src/database,
 *     tooling, or transport.
 *   - owner confirmation creates a pairing/trust relationship ONLY. It
 *     never mints grants, ratifies actions, or authorizes control.
 *   - sessions are bound through a one-time binding credential issued at
 *     confirm time; a forged session claiming an existing deviceId is
 *     rejected and counted, never auto-bound.
 *   - revocation is terminal: old challenges die, sessions close, and no
 *     recovery generation may resurrect REVOKED -> TRUSTED without the
 *     persisted canonical truth saying so (restore is fail-closed).
 */

const crypto = require("node:crypto");
const { fail, sha256Hex, realClock, digestOf, deepFreeze } = require("../core/util");
const { validateDeviceId, canonicalDeviceId } = require("../core/identity");
const { ChallengeBroker } = require("./challenge");
const {
    PAIRING_STATES, PAIRING_TRANSITIONS, canTransition,
    TRUST_BY_PAIRING_STATE, BODY_RELATIONS, OBSERVED_CAPABILITIES,
    SESSION_STATES, PRESENCE_STATES
} = require("./types");

const DEFAULTS = Object.freeze({
    maxDevices: 256,
    maxPendingTransactions: 8,
    maxHistoryPerDevice: 16,
    maxSessionsPerDevice: 8,
    maxObservedCapabilities: 8,
    maxDisplayNameLength: 120,
    maxMetadataFields: 32,
    maxMetadataValueLength: 200,
    challengeTtlMs: 120_000,
    challengeCapacity: 16,
    maxChallengeAttempts: 5,
    pairingTtlMs: 600_000,         // whole transaction must finish in 10 min
    maxArchivedTransactions: 512,  // terminal-tx tombstones reclaimed
    maxTotalSessions: 1024         // incl. disconnected history
});

const DEVICE_ID_PATTERN_KEYS = Object.freeze(
    new Set(["__proto__", "constructor", "prototype"]));

/** Own-property vocabulary set — immune to prototype-chain lookups. */
const CAPABILITY_VOCABULARY = Object.freeze(new Set(
    Object.getOwnPropertyNames(OBSERVED_CAPABILITIES)));

function nowHex(n) {
    return crypto.randomBytes(n).toString("hex");
}

class DeviceIdentityService {

    constructor({ clock = realClock(), config = {}, entropy = null, body = null } = {}) {
        this.clock = clock;
        this.body = body;                       // read-only BodySchema link
        this.config = Object.freeze({ ...DEFAULTS, ...config });

        /** deviceId -> record */
        this._devices = new Map();
        /** pairingId -> transaction */
        this._transactions = new Map();
        /** sessionId -> session */
        this._sessions = new Map();
        this._forgedSessionCount = 0;
        this._identityConflicts = 0;
        this.challenges = new ChallengeBroker({
            clock, entropy,
            config: {
                ttlMs: this.config.challengeTtlMs,
                capacity: this.config.challengeCapacity,
                maxAttempts: this.config.maxChallengeAttempts
            }
        });
    }

    /* ------------------------- identity records ------------------------ */

    /**
     * Canonical identity registration. Idempotent on deviceId: calling
     * again with the same namespace/stableKey returns the SAME identity —
     * display metadata never forks identity.
     */
    registerIdentity({ namespace, stableKey, displayName, deviceClass = "UNKNOWN", platform = null, metadata = null } = {}) {
        const deviceId = canonicalDeviceId({ namespace, stableKey });
        if (this._devices.has(deviceId)) {
            return { deviceId, created: false, identity: this.getIdentity(deviceId) };
        }
        if (this._devices.size >= this.config.maxDevices) {
            throw fail("PID_TOO_MANY_DEVICES",
                `batas perangkat tercapai (${this.config.maxDevices})`);
        }
        const name = sanitizeDisplayName(displayName, this.config.maxDisplayNameLength);
        const meta = sanitizeMetadata(metadata, this.config);

        this._devices.set(deviceId, {
            deviceId,
            displayName: name,
            deviceClass: String(deviceClass).slice(0, 40),
            platform: platform == null ? null : String(platform).slice(0, 80),
            instanceKeyDigest: null,       // bound at first pairing evidence
            observedCapabilities: [],
            pairingState: PAIRING_STATES.UNPAIRED,
            trustState: TRUST_BY_PAIRING_STATE[PAIRING_STATES.UNPAIRED],
            bodyRelation: BODY_RELATIONS.UNKNOWN,
            presence: PRESENCE_STATES.UNKNOWN,
            createdAtMs: this.clock.nowMs(),
            lastSeenAtMs: this.clock.nowMs(),
            activeTxId: null,
            bindingDigest: null,           // set once at ownerConfirm
            history: []
        });
        return { deviceId, created: true, identity: this.getIdentity(deviceId) };
    }

    /**
     * Rename is metadata-only. Identity survives; duplicates allowed.
     */
    rename(deviceId, displayName) {
        const rec = this._mustGet(deviceId);
        rec.displayName = sanitizeDisplayName(displayName,
            this.config.maxDisplayNameLength);
        rec.lastSeenAtMs = this.clock.nowMs();
        return this.getIdentity(deviceId);
    }

    setBodyRelation(deviceId, relation) {
        const rec = this._mustGet(deviceId);
        if (!BODY_RELATIONS[relation]) {
            throw fail("PID_UNKNOWN_BODY_RELATION", `relasi tubuh tak dikenal: '${relation}'`);
        }
        rec.bodyRelation = relation;
        return this.getIdentity(deviceId);
    }

    setPresence(deviceId, state) {
        const rec = this._mustGet(deviceId);
        if (!PRESENCE_STATES[state]) {
            throw fail("PID_UNKNOWN_PRESENCE", `presensi tak dikenal: '${state}'`);
        }
        // Observational only: presence NEVER mutates pairing/trust.
        rec.presence = state;
        rec.lastSeenAtMs = this.clock.nowMs();
        return this.getIdentity(deviceId);
    }

    /**
     * Observe advertised capabilities. Whitelist + bounded. This records
     * what a device CLAIMS to have — it grants nothing.
     */
    observeCapabilities(deviceId, names) {
        const rec = this._mustGet(deviceId);
        if (!Array.isArray(names)) {
            throw fail("PID_INVALID_CAPABILITY_LIST", "daftar kemampuan wajib array");
        }
        const next = new Set(rec.observedCapabilities);
        for (const raw of names.slice(0, this.config.maxObservedCapabilities * 4)) {
            const name = String(raw ?? "");
            if (!CAPABILITY_VOCABULARY.has(name)) continue;   // non-vocabulary ignored
            next.add(name);
        }
        rec.observedCapabilities = [...next].sort().slice(0, this.config.maxObservedCapabilities);
        rec.lastSeenAtMs = this.clock.nowMs();
        return this.getIdentity(deviceId);
    }

    /* --------------------------- pairing flow -------------------------- */

    /** Step 1: owner-side intent. Issues a bound, short-lived challenge. */
    beginPairing(deviceId, { instancePublicKey = null } = {}) {
        this._sweepExpired();
        const rec = this._mustGet(deviceId);
        if (rec.pairingState === PAIRING_STATES.REVOKED) {
            throw fail("PID_REVOKED", "pairing telah dicabut; mulai ulang tidak diizinkan lewat jalur ini");
        }
        if (rec.pairingState !== PAIRING_STATES.UNPAIRED) {
            throw fail("PID_INVALID_STATE",
                `transaksi tidak dapat dimulai dari ${rec.pairingState}`);
        }
        const pending = [...this._transactions.values()]
            .filter(t => t.state === "CHALLENGE_ISSUED"
                || t.state === "AWAITING_OWNER_CONFIRMATION").length;
        if (pending >= this.config.maxPendingTransactions) {
            throw fail("PID_TOO_MANY_TRANSACTIONS",
                `batas transaksi menggantung tercapai (${this.config.maxPendingTransactions})`);
        }
        const now = this.clock.nowMs();
        // Bind/verify instance key BEFORE any state mutation (atomicity).
        if (instancePublicKey != null) {
            this._bindInstanceKey(rec, instancePublicKey);
        }
        const pairingId = `pair-${nowHex(12)}`;
        const challenge = this.challenges.issue({ pairingId, deviceId });
        const tx = {
            pairingId,
            deviceId,
            state: "CHALLENGE_ISSUED",
            createdAtMs: now,
            expiresAtMs: now + this.config.pairingTtlMs,
            challengeId: challenge.challengeId,
            confirmedBy: null
        };
        this._transactions.set(pairingId, tx);
        rec.activeTxId = pairingId;
        rec.pairingState = PAIRING_STATES.CHALLENGE_ISSUED;
        rec.lastSeenAtMs = now;
        return {
            pairingId,
            challenge,
            transactionExpiresAtMs: tx.expiresAtMs
        };
    }

    /** Step 2: device proves possession of the challenge secret. */
    submitChallenge({ pairingId, challengeId, secret, instancePublicKey = null } = {}) {
        this._sweepExpired();
        const tx = this._mustGetTx(pairingId);
        if (tx.state !== "CHALLENGE_ISSUED") {
            throw fail("PID_INVALID_STATE",
                `transaksi dalam keadaan ${tx.state}, bukan CHALLENGE_ISSUED`);
        }
        const rec = this._mustGet(tx.deviceId);
        this.challenges.consume({
            challengeId, secret,
            pairingId, deviceId: tx.deviceId
        });   // throws coded errors: expired / replayed / wrong device / wrong tx / malformed

        if (rec.instanceKeyDigest == null && instancePublicKey != null) {
            this._bindInstanceKey(rec, instancePublicKey);
        }
        if (instancePublicKey != null
            && sha256Hex(String(instancePublicKey)) !== rec.instanceKeyDigest) {
            this._failTransaction(tx, rec);
            this._identityConflicts++;
            throw fail("PID_IDENTITY_CONFLICT",
                "identitas kriptografis instansi berbenturan dengan yang terikat");
        }
        tx.state = "AWAITING_OWNER_CONFIRMATION";
        rec.pairingState = PAIRING_STATES.AWAITING_OWNER_CONFIRMATION;
        rec.lastSeenAtMs = this.clock.nowMs();
        return { pairingId, awaitingOwnerConfirmation: true };
    }

    /**
     * Step 3: OWNER confirms. Creates the pairing/trust relationship and
     * NOTHING else — zero Authority mutation, zero capability grant.
     * Returns a ONE-TIME binding credential for future session binds.
     */
    ownerConfirm(pairingId, { actor = "owner" } = {}) {
        this._sweepExpired();
        const tx = this._mustGetTx(pairingId);
        if (tx.state === "CONFIRMED") {
            throw fail("PID_ALREADY_CONFIRMED",
                "konfirmasi ganda ditolak: transaksi sudah dikonfirmasi");
        }
        if (tx.state !== "AWAITING_OWNER_CONFIRMATION") {
            throw fail("PID_NOT_CONFIRMABLE",
                `transaksi dalam keadaan ${tx.state}; konfirmasi pemilik tidak berlaku`);
        }
        const rec = this._mustGet(tx.deviceId);
        const bindingSecret = nowHex(24);
        rec.bindingDigest = sha256Hex(bindingSecret);
        tx.state = "CONFIRMED";
        tx.confirmedBy = String(actor).slice(0, 80);
        this._transition(rec, PAIRING_STATES.PAIRED);
        rec.activeTxId = null;
        rec.lastSeenAtMs = this.clock.nowMs();
        return {
            pairingId,
            deviceId: rec.deviceId,
            pairingState: rec.pairingState,
            trustState: rec.trustState,
            // Shown exactly once; only its digest is retained:
            bindingCredential: { secret: bindingSecret, issuedAtMs: this.clock.nowMs() }
        };
    }

    cancelPairing(pairingId, { reason = "cancelled" } = {}) {
        const tx = this._mustGetTx(pairingId);
        if (tx.state === "CONFIRMED") {
            throw fail("PID_ALREADY_CONFIRMED", "transaksi terkonfirmasi tidak dapat dibatalkan");
        }
        const rec = this._devices.get(tx.deviceId);
        this.challenges.invalidatePairing(pairingId);
        tx.state = "FAILED";
        tx.failReason = String(reason).slice(0, 120);
        if (rec && rec.activeTxId === pairingId) {
            rec.activeTxId = null;
            // Cancellation returns the device to its UNPAIRED baseline
            // (retryable), unlike FAILED which is terminal for the tx row.
            rec.pairingState = PAIRING_STATES.UNPAIRED;
            rec.trustState = TRUST_BY_PAIRING_STATE[PAIRING_STATES.UNPAIRED];
        }
        return { pairingId, state: "FAILED" };
    }

    /** Owner promotes/demotes trust WITHIN the relationship. Still not permission. */
    setTrust(deviceId, level) {
        const rec = this._mustGet(deviceId);
        if (!["PAIRED", "TRUSTED", "LIMITED"].includes(level)) {
            throw fail("PID_INVALID_TRUST_LEVEL",
                `level kepercayaan tidak sah untuk operasi ini: '${level}'`);
        }
        this._transition(rec, level);
        return this.getIdentity(deviceId);
    }

    /**
     * Revocation: canonical, deterministic, terminal for the live
     * relationship. Kills challenges + sessions. Does NOT touch any
     * other subsystem (Authority policy is a future layer's job).
     */
    revoke(deviceId, { reason = "revoked" } = {}) {
        const rec = this._mustGet(deviceId);
        if (!["PAIRED", "TRUSTED", "LIMITED"].includes(rec.pairingState)) {
            throw fail("PID_NOT_PAIRED",
                `perangkat dalam keadaan ${rec.pairingState}; tidak ada pairing untuk dicabut`);
        }
        this._transition(rec, PAIRING_STATES.REVOKED);
        rec.activeTxId = null;
        rec.bindingDigest = null;              // rebind impossible
        this.challenges.invalidateDevice(deviceId);
        let closed = 0;
        for (const [sid, s] of this._sessions) {
            if (s.deviceId === deviceId && s.state === SESSION_STATES.ACTIVE) {
                s.state = SESSION_STATES.DISCONNECTED;
                s.closedReason = "revoked";
                s.closedAtMs = this.clock.nowMs();
                closed++;
            }
        }
        this._archive(rec, { kind: "REVOKED", reason: String(reason).slice(0, 120) });
        return { deviceId, pairingState: rec.pairingState, sessionsClosed: closed };
    }

    /* ----------------------------- sessions ---------------------------- */

    /**
     * Trusted binding path: a session may attach to a device ONLY with
     * the one-time binding credential minted at ownerConfirm (digest
     * match). Any other claim of a deviceId is FORGERY: rejected, counted,
     * and never auto-bound.
     */
    openSession({ deviceId, bindingSecret, sessionId = null } = {}) {        this._sweepExpired();
        const rec = this._mustGet(deviceId);
        if (!["PAIRED", "TRUSTED", "LIMITED"].includes(rec.pairingState)) {
            this._forgedSessionCount++;
            throw fail("PID_SESSION_FORGED",
                `perangkat ${rec.pairingState}: tidak ada relasi untuk mengikat sesi`);
        }
        if (typeof bindingSecret !== "string" || !rec.bindingDigest
            || sha256Hex(bindingSecret) !== rec.bindingDigest) {
            this._forgedSessionCount++;
            throw fail("PID_SESSION_FORGED",
                "kredensial pengikatan tidak cocok; sesi tidak terikat");
        }
        const sid = sessionId == null ? `sess-${nowHex(12)}`
            : String(sessionId).slice(0, 80);
        if (this._sessions.has(sid)) {
            throw fail("PID_SESSION_EXISTS", `sesi sudah ada: '${sid}'`);
        }
        this._capSessions(rec.deviceId);
        const session = {
            sessionId: sid,
            deviceId,
            state: SESSION_STATES.ACTIVE,
            openedAtMs: this.clock.nowMs(),
            closedAtMs: null,
            closedReason: null
        };
        // Mutable internal record; callers receive a detached frozen copy.
        this._sessions.set(sid, Object.assign({}, session));
        rec.lastSeenAtMs = this.clock.nowMs();
        return frozenView(session);
    }

    closeSession(sessionId, { reason = "closed" } = {}) {
        const s = this._sessions.get(String(sessionId ?? ""));
        if (!s) throw fail("PID_SESSION_UNKNOWN", `sesi tidak dikenal: '${sessionId}'`);
        if (s.state === SESSION_STATES.ACTIVE) {
            s.state = SESSION_STATES.DISCONNECTED;
            s.closedAtMs = this.clock.nowMs();
            s.closedReason = String(reason).slice(0, 80);
        }
        return frozenView(s);
    }

    getSession(sessionId) {
        const s = this._sessions.get(String(sessionId ?? ""));
        return s ? frozenView({ ...s }) : null;
    }

    listSessions(deviceId) {
        return deepFreeze([...this._sessions.values()]
            .filter(s => !deviceId || s.deviceId === deviceId)
            .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
            .map(s => frozenView({ ...s })));
    }

    /* ------------------------------ queries ---------------------------- */

    getIdentity(deviceId) {
        this._sweepExpired();
        const rec = this._devices.get(deviceId);
        if (!rec) return null;
        const view = frozenView({
            deviceId: rec.deviceId,
            displayName: rec.displayName,
            deviceClass: rec.deviceClass,
            platform: rec.platform,
            instanceKeyDigest: rec.instanceKeyDigest,
            observedCapabilities: Object.freeze([...rec.observedCapabilities]),
            pairingState: rec.pairingState,
            trustState: rec.trustState,
            bodyRelation: rec.bodyRelation,
            presence: rec.presence,
            createdAtMs: rec.createdAtMs,
            lastSeenAtMs: rec.lastSeenAtMs,
            hasActiveTransaction: rec.activeTxId != null,
            body: this.body ? (this.body.getDevice(deviceId)
                ? { linked: true, deviceClass: this.body.getDevice(deviceId).descriptor.deviceClass }
                : { linked: false })
                : null
        });
        return view;
    }

    listIdentities(filter = {}) {
        return deepFreeze([...this._devices.keys()].sort()
            .map(id => this.getIdentity(id))
            .filter(v => v != null)
            .filter(v => filter.trustState == null || v.trustState === filter.trustState)
            .filter(v => filter.bodyRelation == null || v.bodyRelation === filter.bodyRelation));
    }

    stats() {
        this._sweepExpired();
        const byPairingState = {};
        for (const s of Object.values(PAIRING_STATES)) byPairingState[s] = 0;
        for (const r of this._devices.values()) byPairingState[r.pairingState]++;
        const activeSessions = [...this._sessions.values()]
            .filter(s => s.state === SESSION_STATES.ACTIVE).length;
        return deepFreeze({
            devices: this._devices.size,
            byPairingState,
            transactionsTotal: this._transactions.size,
            transactionsActive: [...this._transactions.values()]
                .filter(t => t.state === "CHALLENGE_ISSUED"
                    || t.state === "AWAITING_OWNER_CONFIRMATION").length,
            challengesLive: this.challenges.size(),
            sessionsActive: activeSessions,
            sessionsTotal: this._sessions.size,
            forgedSessionAttempts: this._forgedSessionCount,
            identityConflicts: this._identityConflicts
        });
    }

    /** Forensic view of a device's bounded pairing history. */
    history(deviceId) {
        const rec = this._mustGet(deviceId);
        return deepFreeze(structuredCopyList(rec.history));
    }

    /* --------------------------- persistence --------------------------- */

    /**
     * Durable truth = identity records + pairing states + archived
     * transactions + binding digests. Sessions are EPHEMERAL and are
     * never serialized as canonical identity.
     */
    serialize() {
        const devices = [...this._devices.values()]
            .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
            .map(r => {
                const material = {
                    deviceId: r.deviceId,
                    displayName: r.displayName,
                    deviceClass: r.deviceClass,
                    platform: r.platform,
                    instanceKeyDigest: r.instanceKeyDigest,
                    observedCapabilities: [...r.observedCapabilities],
                    pairingState: r.pairingState,
                    trustState: TRUST_BY_PAIRING_STATE[r.pairingState],
                    bodyRelation: r.bodyRelation,
                    presence: r.presence,
                    createdAtMs: r.createdAtMs,
                    lastSeenAtMs: r.lastSeenAtMs,
                    bindingDigest: r.bindingDigest,
                    activeTxId: null,      // pending txs do not survive restart
                    history: structuredCopyList(r.history)
                };
                return { ...material, rowDigest: digestOf(material) };
            });
        return deepFreeze({
            version: 1,
            devices,
            transactions: [...this._transactions.values()]
                .filter(t => t.state === "CONFIRMED")
                .map(t => ({ ...t }))
                .sort((a, b) => a.pairingId.localeCompare(b.pairingId))
        });
    }

    /**
     * Fail-closed restore: ANY invalid row rejects the WHOLE snapshot —
     * half-restored identity state is more dangerous than none. Restored
     * rows are canonical truth: a snapshot that says REVOKED stays
     * REVOKED; nothing here upgrades trust on load. Evidence that arrives
     * without pairing truth simply does not exist as a pairing.
     */
    static restore(data, { clock = realClock(), config = {}, entropy = null, body = null } = {}) {
        const errors = [];
        if (!data || typeof data !== "object" || data.version !== 1) {
            throw fail("PID_INVALID_SERIALIZATION",
                "serialisasi tidak dikenal (version !== 1)");
        }
        const svc = new DeviceIdentityService({ clock, config, entropy, body });
        const staged = new Map();

        for (const [i, row] of (Array.isArray(data.devices) ? data.devices : []).entries()) {
            try {
                validateRowShape(row, i);
                if (!validateDeviceId(row.deviceId)) {
                    throw fail("PID_INVALID_DEVICE_ID", `baris#${i}: deviceId tidak sah`);
                }
                if (staged.has(row.deviceId)) {
                    throw fail("PID_DUPLICATE_DEVICE", `baris#${i}: deviceId duplikat`);
                }
                const enumsOk =
                    PAIRING_STATES[row.pairingState] != null
                    && BODY_RELATIONS[row.bodyRelation] != null
                    && PRESENCE_STATES[row.presence] != null;
                if (!enumsOk) {
                    throw fail("PID_INVALID_ENUM", `baris#${i}: enum tidak sah`);
                }
                const expectedTrust = TRUST_BY_PAIRING_STATE[row.pairingState];
                if (row.trustState !== expectedTrust) {
                    throw fail("PID_TRUST_MISMATCH",
                        `baris#${i}: trustState '${row.trustState}' tidak konsisten ` +
                        `dengan pairingState '${row.pairingState}'`);
                }
                if (!Number.isInteger(row.createdAtMs) || !Number.isInteger(row.lastSeenAtMs)) {
                    throw fail("PID_INVALID_TIMESTAMPS", `baris#${i}: stempel waktu tidak sah`);
                }
                if (row.bindingDigest != null
                    && !/^[a-f0-9]{64}$/.test(String(row.bindingDigest))) {
                    throw fail("PID_INVALID_BINDING", `baris#${i}: bindingDigest tidak sah`);
                }
                sanitizeDisplayName(row.displayName, 120);   // shape check
                for (const c of row.observedCapabilities) {
                    if (!OBSERVED_CAPABILITIES[c]) {
                        throw fail("PID_INVALID_CAPABILITY", `baris#${i}: kemampuan asing '${c}'`);
                    }
                }
                const material = { ...structuredCopyRow(row), rowDigest: undefined };
                delete material.rowDigest;
                if (row.rowDigest !== digestOf(material)) {
                    throw fail("PID_DIGEST_MISMATCH",
                        `baris#${i} (${row.deviceId}): integritas baris tidak cocok`);
                }
                staged.set(row.deviceId, material);
            } catch (err) {
                errors.push(`devices[${i}]: ${err.code ?? "ERR"} — ${err.message}`);
            }
        }

        for (const [i, tx] of (Array.isArray(data.transactions) ? data.transactions : []).entries()) {
            try {
                if (!tx || typeof tx !== "object" || typeof tx.pairingId !== "string") {
                    throw fail("PID_INVALID_TRANSACTION", `tx#${i} tidak sah`);
                }
                if (tx.state !== "CONFIRMED") {
                    throw fail("PID_INVALID_TRANSACTION", `tx#${i}: hanya CONFIRMED yang durable`);
                }
                if (!staged.has(tx.deviceId)) {
                    throw fail("PID_TRANSACTION_ORPHAN",
                        `tx#${i}: perangkat '${tx.deviceId}' tidak dikenal`);
                }
            } catch (err) {
                errors.push(`transactions[${i}]: ${err.code ?? "ERR"} — ${err.message}`);
            }
        }

        if (errors.length > 0) {
            const error = fail("PID_INVALID_SERIALIZATION",
                `${errors.length} baris ditolak; seluruh snapshot ditolak`);
            error.details = errors;
            throw error;
        }

        for (const row of staged.values()) {
            svc._devices.set(row.deviceId, {
                ...row,
                trustState: TRUST_BY_PAIRING_STATE[row.pairingState],
                activeTxId: null,
                history: row.history
            });
        }
        for (const tx of data.transactions ?? []) {
            svc._transactions.set(tx.pairingId, { ...tx });
        }
        return svc;
    }

    /* ------------------------------ internal --------------------------- */

    _mustGet(deviceId) {
        const rec = this._devices.get(String(deviceId ?? ""));
        if (!rec) throw fail("PID_UNKNOWN_DEVICE", `perangkat tidak dikenal: '${deviceId}'`);
        return rec;
    }

    _mustGetTx(pairingId) {
        const tx = this._transactions.get(String(pairingId ?? ""));
        if (!tx) throw fail("PID_TX_UNKNOWN", `transaksi pairing tidak dikenal: '${pairingId}'`);
        return tx;
    }

    _transition(rec, nextState) {
        if (!canTransition(rec.pairingState, nextState)) {
            throw fail("PID_INVALID_TRANSITION",
                `transisi tidak sah: ${rec.pairingState} -> ${nextState}`);
        }
        rec.pairingState = nextState;
        rec.trustState = TRUST_BY_PAIRING_STATE[nextState];
    }

    _bindInstanceKey(rec, publicKey) {
        const key = String(publicKey ?? "");
        if (key.length === 0 || key.length > 512) {
            throw fail("PID_INVALID_INSTANCE_KEY", "kunci instansi tidak sah");
        }
        if (rec.instanceKeyDigest != null
            && rec.instanceKeyDigest !== sha256Hex(key)) {
            this._identityConflicts++;
            throw fail("PID_IDENTITY_CONFLICT",
                "kunci instansi berbeda dari yang terikat untuk deviceId ini");
        }
        rec.instanceKeyDigest = sha256Hex(key);
    }

    _failTransaction(tx, rec) {
        this.challenges.invalidatePairing(tx.pairingId);
        tx.state = "FAILED";
        tx.failReason = "identity-conflict";
        if (rec.activeTxId === tx.pairingId) {
            rec.activeTxId = null;
            this._transition(rec, PAIRING_STATES.FAILED);
        }
    }

    _archive(rec, entry) {
        rec.history.push({ ...entry, atMs: this.clock.nowMs() });
        while (rec.history.length > this.config.maxHistoryPerDevice) {
            rec.history.shift();
        }
    }

    _capSessions(deviceId) {
        const mine = [...this._sessions.values()]
            .filter(s => s.deviceId === deviceId)
            .sort((a, b) => a.openedAtMs - b.openedAtMs);
        while (mine.length >= this.config.maxSessionsPerDevice) {
            const oldest = mine.shift();
            this._sessions.delete(oldest.sessionId);
        }
        // Global tombstone bound: prefer evicting disconnected history.
        if (this._sessions.size >= this.config.maxTotalSessions) {
            const all = [...this._sessions.values()]
                .sort((a, b) =>
                    (a.state === b.state ? 0 : a.state === SESSION_STATES.DISCONNECTED ? -1 : 1)
                    || (a.openedAtMs - b.openedAtMs)
                    || a.sessionId.localeCompare(b.sessionId));
            const victim = all[0];
            this._sessions.delete(victim.sessionId);
        }
    }

    /** Deterministic expiry sweep: pending txs past deadline -> EXPIRED, device back to UNPAIRED. */
    _sweepExpired() {
        const now = this.clock.nowMs();
        for (const tx of this._transactions.values()) {
            if ((tx.state === "CHALLENGE_ISSUED"
                || tx.state === "AWAITING_OWNER_CONFIRMATION")
                && now >= tx.expiresAtMs) {
                this.challenges.invalidatePairing(tx.pairingId);
                tx.state = "EXPIRED";
                const rec = this._devices.get(tx.deviceId);
                if (rec && rec.activeTxId === tx.pairingId) {
                    rec.activeTxId = null;
                    if (canTransition(rec.pairingState, PAIRING_STATES.EXPIRED)) {
                        this._transition(rec, PAIRING_STATES.EXPIRED);
                        this._archive(rec, { kind: "TX_EXPIRED" });
                    }
                }
            }
        }
        // Broker prunes itself lazily; eager pruning here would turn
        // deterministic EXPIRED reports into NOT_FOUND.
        this._pruneTransactions();
    }

    /**
     * Tombstone reclamation: terminal (CONFIRMED/EXPIRED/FAILED)
     * transactions beyond the archive bound are evicted oldest-expiry
     * first, deterministically. Pending transactions are never evicted.
     * Confirmed-pairing TRUTH lives on the device record itself, so
     * eviction never un-pairs or resurrects anything.
     */
    _pruneTransactions() {
        const terminal = [];
        for (const tx of this._transactions.values()) {
            if (tx.state === "CONFIRMED" || tx.state === "EXPIRED"
                || tx.state === "FAILED") {
                terminal.push(tx);
            }
        }
        if (terminal.length <= this.config.maxArchivedTransactions) return;
        terminal.sort((a, b) =>
            (a.expiresAtMs - b.expiresAtMs) || a.pairingId.localeCompare(b.pairingId));
        const excess = terminal.length - this.config.maxArchivedTransactions;
        for (let i = 0; i < excess; i++) {
            this._transactions.delete(terminal[i].pairingId);
        }
    }

    /**
     * Owner-side re-enrollment after an expired transaction. Explicit,
     * auditable; never automatic, never triggered by device contact.
     */
    reEnrollAfterExpiry(deviceId) {
        const rec = this._mustGet(deviceId);
        if (rec.pairingState !== PAIRING_STATES.EXPIRED) {
            throw fail("PID_INVALID_STATE",
                `hanya EXPIRED yang dapat didaftarkan ulang (bukan ${rec.pairingState})`);
        }
        rec.pairingState = PAIRING_STATES.UNPAIRED;
        rec.trustState = TRUST_BY_PAIRING_STATE[PAIRING_STATES.UNPAIRED];
        return this.getIdentity(deviceId);
    }

}

/* ------------------------- pure module helpers ------------------------- */

function sanitizeDisplayName(raw, maxLen) {
    if (raw == null) return "(tanpa nama)";
    const name = String(raw);
    if (name.length > maxLen) {
        throw fail("PID_DISPLAY_NAME_TOO_LONG",
            `nama tampilan > ${maxLen} karakter`);
    }
    if (/[\u0000-\u001f]/.test(name)) {
        throw fail("PID_INVALID_DISPLAY_NAME", "nama tampilan memuat kontrol");
    }
    return name;
}

function sanitizeMetadata(metadata, config) {
    if (metadata == null) return {};
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
        throw fail("PID_INVALID_METADATA", "metadata bukan objek");
    }
    const keys = Object.keys(metadata);
    if (keys.length > config.maxMetadataFields) {
        throw fail("PID_METADATA_TOO_LARGE",
            `metadata > ${config.maxMetadataFields} field`);
    }
    for (const k of keys) {
        if (DEVICE_ID_PATTERN_KEYS.has(k)) {
            throw fail("PID_INVALID_METADATA", `kunci metadata terlarang: '${k}'`);
        }
    }
    const out = {};
    for (const k of keys) {
        const v = metadata[k];
        out[k] = typeof v === "object" && v !== null
            ? JSON.stringify(v).slice(0, config.maxMetadataValueLength)
            : v;
    }
    return out;
}

function validateRowShape(row, i) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw fail("PID_INVALID_ROW", `baris#${i} bukan objek`);
    }
    for (const field of ["deviceId", "displayName", "deviceClass", "pairingState",
        "trustState", "bodyRelation", "presence", "createdAtMs", "lastSeenAtMs",
        "observedCapabilities", "rowDigest"]) {
        if (!(field in row)) {
            throw fail("PID_FIELD_MISSING", `baris#${i}: field hilang '${field}'`);
        }
    }
    if (!Array.isArray(row.observedCapabilities)) {
        throw fail("PID_INVALID_CAPABILITY_LIST", `baris#${i}: observedCapabilities bukan array`);
    }
    if (row.observedCapabilities.length > 8) {
        throw fail("PID_BOUNDS", `baris#${i}: observedCapabilities melebihi batas`);
    }
    if (!Array.isArray(row.history) || row.history.length > 16) {
        throw fail("PID_BOUNDS", `baris#${i}: riwayat melebihi batas / bukan array`);
    }
}

/** Row used for digest verification — canonical field order irrelevant. */
function structuredCopyRow(row) {
    return {
        deviceId: row.deviceId,
        displayName: row.displayName,
        deviceClass: row.deviceClass,
        platform: row.platform ?? null,
        instanceKeyDigest: row.instanceKeyDigest ?? null,
        observedCapabilities: [...row.observedCapabilities],
        pairingState: row.pairingState,
        trustState: row.trustState,
        bodyRelation: row.bodyRelation,
        presence: row.presence,
        createdAtMs: row.createdAtMs,
        lastSeenAtMs: row.lastSeenAtMs,
        bindingDigest: row.bindingDigest ?? null,
        activeTxId: null,
        history: row.history.map(h => ({ ...h }))
    };
}

function structuredCopyList(list) {
    return JSON.parse(JSON.stringify(list ?? []));
}

function frozenView(obj) { return Object.freeze(obj); }

module.exports = { DeviceIdentityService, IDENTITY_DEFAULTS: DEFAULTS };
