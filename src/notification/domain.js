"use strict";

// Canonical Surface Notification Domain owner (DP-L4..L5).
//
// DOMAIN LAW: NOTIFICATION != AUTHORITY, SALIENCE != AUTHORITY, SOURCE DOMAIN
// != NOTIFICATION (DP §39, §40, §44). This domain owns notification identity,
// lifecycle, policy result, salience, sensitivity, dedup and a surface-safe
// read model. It references source domains (approval/mission/incident/...) but
// never owns their state, and NOTHING here executes an actuator, approves an
// approval, or mutates a source domain. Dismissing a notification mutates the
// notification ONLY (DP §47).

const crypto = require("node:crypto");
const { makeNotificationStore } = require("./store");
const { classify, LEVEL, rank } = require("./policy");
const { entityRef } = require("../ui-platform/entityRefs");

const STATE = Object.freeze({
    ACTIVE: "ACTIVE",
    READ: "READ",
    ACKNOWLEDGED: "ACKNOWLEDGED",
    DISMISSED: "DISMISSED",
    RESOLVED: "RESOLVED",
    EXPIRED: "EXPIRED"
});

// DISMISSED/RESOLVED/EXPIRED are terminal. READ != ACKNOWLEDGED != AUTHORIZED,
// DISMISSED != source resolved (DP §46).
const TERMINAL = Object.freeze(new Set([STATE.DISMISSED, STATE.RESOLVED, STATE.EXPIRED]));
const TRANSITIONS = Object.freeze({
    ACTIVE: Object.freeze([STATE.READ, STATE.ACKNOWLEDGED, STATE.DISMISSED, STATE.RESOLVED, STATE.EXPIRED]),
    READ: Object.freeze([STATE.ACKNOWLEDGED, STATE.DISMISSED, STATE.RESOLVED, STATE.EXPIRED]),
    ACKNOWLEDGED: Object.freeze([STATE.DISMISSED, STATE.RESOLVED, STATE.EXPIRED]),
    DISMISSED: Object.freeze([]), RESOLVED: Object.freeze([]), EXPIRED: Object.freeze([])
});

const SENSITIVITY = Object.freeze(["NORMAL", "SENSITIVE", "SECRET"]);

class NotificationError extends Error {
    constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = "NotificationError"; this.code = code; }
}

function makeKeyedLock() {
    const tails = new Map();
    return function withLock(key, fn) {
        const prev = tails.get(key) || Promise.resolve();
        const result = prev.then(() => fn());
        const tail = result.then(() => {}, () => {});
        tails.set(key, tail);
        tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
        return result;
    };
}

function createNotificationDomain({ store, acc, clock = () => Date.now(), audit = null,
    ttlMs = null, idFactory = () => `ntf-${crypto.randomUUID()}` } = {}) {
    const backing = store || (acc ? makeNotificationStore(acc) : null);
    if (!backing) throw new TypeError("notification domain requires { store } or { acc }");
    const withLock = makeKeyedLock();

    function emit(eventType, rec, outcome) {
        if (!audit || typeof audit.append !== "function") return;
        try {
            audit.append({
                eventType, source: "canonical.notification",
                actor: { kind: "system", id: "notification-domain" },
                subject: { kind: "service", id: "notification" },
                operation: eventType, outcome,
                metadata: { notification_id: rec.notification_id, source_ref: `${rec.source_ref.entity_type}:${rec.source_ref.entity_id}`, state: rec.state, level: rec.level }
            });
        } catch { /* audit is correlation only; never the state owner, never throws */ }
    }

    // Surface-safe projection (DP §55). privacy_sensitivity drives redaction; a
    // SENSITIVE/SECRET notification exposes its summary only as redacted unless
    // the surface is permitted — the raw detail is never placed in the summary
    // field and no raw secret value is ever stored.
    function surfaceRecord(rec, { reveal = false } = {}) {
        const redacted = rec.privacy_sensitivity !== "NORMAL" && !reveal;
        return Object.freeze({
            notification_id: rec.notification_id,
            source_ref: rec.source_ref,
            source_event: rec.source_event,
            state: rec.state,
            delivery_state: rec.state,
            acknowledgement_state: rec.state === STATE.ACKNOWLEDGED ? "ACKNOWLEDGED" : "UNACKNOWLEDGED",
            urgency: rec.level,
            severity: rec.severity,
            privacy_sensitivity: rec.privacy_sensitivity,
            summary: redacted ? "[REDACTED]" : (rec.summary ?? null),
            target_surfaces: rec.target_surfaces ?? [],
            coalesce_count: rec.coalesce_count,
            revision: rec.revision,
            created_at: rec.created_at,
            last_event_at: rec.last_event_at,
            expires_at: rec.expires_at,
            source: "canonical_notification_read_model"
        });
    }

    // DP §41/§42/§53: emit a source condition. The policy decides salience; the
    // dedup key deterministically coalesces repeats of the SAME source+event.
    // A severity/level escalation on the same key updates (does not collapse);
    // identical repeats only bump the coalesce counter (no flood); a repeat that
    // hits a terminal notification is NOT resurrected.
    async function emitSource({ sourceType, sourceId, event = null, severity = "normal",
        privacySensitivity = "NORMAL", summary = null, targetSurfaces = [] } = {}) {
        const ref = entityRef(sourceType, sourceId); // validates canonical entity reference
        if (!SENSITIVITY.includes(privacySensitivity)) throw new NotificationError("INVALID_SENSITIVITY", privacySensitivity);
        const level = classify({ sourceKind: sourceType, event, severity });
        if (level === LEVEL.NONE) return null; // policy: no notification

        const dedupKey = `${ref.entity_type}:${ref.entity_id}:${event ?? ""}`;
        return withLock(dedupKey, async () => {
            const now = clock();
            const existing = await backing.byDedup(dedupKey);
            if (existing) {
                if (TERMINAL.has(existing.state)) {
                    // DP §54: do not resurrect a dismissed/resolved/expired notification
                    // from a stale or replayed source event.
                    return surfaceRecord(existing);
                }
                existing.coalesce_count += 1;
                existing.last_event_at = now;
                const escalated = rank(level) !== rank(existing.level) || severity !== existing.severity;
                if (escalated) {
                    existing.level = level;
                    existing.severity = severity;
                    existing.revision += 1;
                    if (summary !== null) existing.summary = summary;
                }
                await backing.put(existing);
                emit(escalated ? "notification.escalated" : "notification.coalesced", existing, "ok");
                return surfaceRecord(existing);
            }
            const rec = {
                notification_id: idFactory(),
                dedup_key: dedupKey,
                source_ref: { entity_type: ref.entity_type, entity_id: ref.entity_id },
                source_event: event,
                severity,
                level,
                privacy_sensitivity: privacySensitivity,
                summary,
                target_surfaces: Array.isArray(targetSurfaces) ? targetSurfaces.slice() : [],
                state: STATE.ACTIVE,
                revision: 1,
                coalesce_count: 1,
                created_at: now,
                last_event_at: now,
                read_at: null, acknowledged_at: null, resolved_at: null, dismissed_at: null,
                expires_at: ttlMs ? now + ttlMs : null
            };
            await backing.put(rec);
            emit("notification.created", rec, "ok");
            return surfaceRecord(rec);
        });
    }

    function transition(target, stamp) {
        return (notificationId) => withLock(`id:${notificationId}`, async () => {
            const rec = await backing.get(notificationId);
            if (!rec) throw new NotificationError("UNKNOWN_NOTIFICATION", notificationId);
            if (TERMINAL.has(rec.state)) return surfaceRecord(rec); // terminal is idempotent
            if (!TRANSITIONS[rec.state].includes(target)) {
                // Non-advancing transition (e.g. READ after ACKNOWLEDGED) is a no-op read.
                return surfaceRecord(rec);
            }
            rec.state = target;
            rec.revision += 1;
            if (stamp) rec[stamp] = clock();
            // Dismissal/ack/read/resolve mutate ONLY the notification. This domain
            // holds no source-domain mutator, so it structurally cannot deny an
            // approval, close a mission or touch a DCD incident (DP §47).
            await backing.put(rec);
            emit(`notification.${target.toLowerCase()}`, rec, "ok");
            return surfaceRecord(rec);
        });
    }

    return Object.freeze({
        STATE, TERMINAL, TRANSITIONS, LEVEL, SENSITIVITY, NotificationError, classify,
        emitSource,
        markRead: transition(STATE.READ, "read_at"),
        acknowledge: transition(STATE.ACKNOWLEDGED, "acknowledged_at"),
        dismiss: transition(STATE.DISMISSED, "dismissed_at"),
        resolve: transition(STATE.RESOLVED, "resolved_at"),
        async expire(notificationId) { return transition(STATE.EXPIRED, "expires_at")(notificationId); },
        async get(notificationId, opts = {}) { const r = await backing.get(notificationId); return r ? surfaceRecord(r, opts) : null; },
        async list({ state = null, sourceType = null } = {}) {
            const recs = await backing.list();
            return recs
                .filter((r) => (!state || r.state === state) && (!sourceType || r.source_ref.entity_type === sourceType))
                .map((r) => surfaceRecord(r));
        }
    });
}

module.exports = { createNotificationDomain, STATE, TERMINAL, TRANSITIONS, SENSITIVITY, NotificationError };
