"use strict";

// Canonical Surface Notification Domain owner (DP-L4..L5, repaired DP-R1..R6).
//
// DOMAIN LAW: NOTIFICATION != AUTHORITY, SALIENCE != AUTHORITY, SOURCE DOMAIN
// != NOTIFICATION (DP §39, §40, §44). This domain owns notification identity,
// lifecycle, policy result, salience, sensitivity, dedup and a surface-safe
// read model. It references source domains (approval/mission/incident/...) but
// never owns their state, and NOTHING here executes an actuator, approves an
// approval, or mutates a source domain. Dismissing a notification mutates the
// notification ONLY (DP §47).
//
// REPAIR CONTRACT (DP-R2/R3/R4/R6):
//  - One mutation boundary for every notification write (emit, transition,
//    compaction), shared across domain instances. Terminal states are final for
//    the SAME source occurrence.
//  - Dedup identity is the source OCCURRENCE: entity + event + sourceOccurrenceId.
//    An exact replay of a known occurrence maps back to it; a new occurrence
//    creates a new notification. Entity+event alone is never a dedup key.
//  - Sensitivity is monotonic per notification: NORMAL < SENSITIVE < SECRET.
//  - Occurrences older than the retention horizon are never re-created, so
//    compaction cannot permit stale replay resurrection.

const crypto = require("node:crypto");
const { makeNotificationStore } = require("./store");
const { classify, LEVEL, rank } = require("./policy");
const { entityRef } = require("../ui-platform/entityRefs");
const { withSharedLock } = require("../canonical/kvIndex");

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
const SENSITIVITY_RANK = Object.freeze({ NORMAL: 0, SENSITIVE: 1, SECRET: 2 });
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
// ponytail: one lock for every notification write. Per-dedup-key locking if throughput matters.
const MUTATE_LOCK = "notification:mutate";

class NotificationError extends Error {
    constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = "NotificationError"; this.code = code; }
}

function maxSensitivity(a, b) { return SENSITIVITY_RANK[b] > SENSITIVITY_RANK[a] ? b : a; }

function createNotificationDomain({ store, acc, clock = () => Date.now(), audit = null,
    ttlMs = null, retentionMs = DEFAULT_RETENTION_MS,
    idFactory = () => `ntf-${crypto.randomUUID()}` } = {}) {
    const backing = store || (acc ? makeNotificationStore(acc) : null);
    if (!backing) throw new TypeError("notification domain requires { store } or { acc }");

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
            source_occurrence_id: rec.source_occurrence_id,
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

    // DP §41/§42/§53: emit a source condition for one source OCCURRENCE. The
    // caller supplies sourceOccurrenceId (the source's own identity for that
    // occurrence, e.g. approval_id) and occurredAt (when it happened). Replays of
    // a known occurrence coalesce or return the existing terminal record; a new
    // occurrence of the same entity+event creates a new notification.
    async function emitSource({ sourceType, sourceId, sourceOccurrenceId, occurredAt, event = null,
        severity = "normal", privacySensitivity = "NORMAL", summary = null, targetSurfaces = [] } = {}) {
        const ref = entityRef(sourceType, sourceId); // validates canonical entity reference
        if (!SENSITIVITY.includes(privacySensitivity)) throw new NotificationError("INVALID_SENSITIVITY", privacySensitivity);
        if (typeof sourceOccurrenceId !== "string" || sourceOccurrenceId.length === 0) {
            throw new NotificationError("SOURCE_OCCURRENCE_REQUIRED", "emitSource needs the source occurrence identity");
        }
        if (!Number.isFinite(occurredAt)) throw new NotificationError("SOURCE_OCCURRENCE_TIME_REQUIRED", "emitSource needs occurredAt");
        const level = classify({ sourceKind: sourceType, event, severity });
        if (level === LEVEL.NONE) return null; // policy: no notification

        const dedupKey = `${ref.entity_type}:${ref.entity_id}:${event ?? ""}:${sourceOccurrenceId}`;
        return withSharedLock(MUTATE_LOCK, async () => {
            const now = clock();
            const existing = await backing.byDedup(dedupKey);
            if (existing) {
                // Terminal occurrence: an exact replay never revives it (DP §54, F2/F4).
                if (TERMINAL.has(existing.state)) return surfaceRecord(existing);
                existing.coalesce_count += 1;
                existing.last_event_at = now;
                // Sensitivity only ratchets up for this notification (F1).
                const sensitivity = maxSensitivity(existing.privacy_sensitivity, privacySensitivity);
                const sensitivityUp = sensitivity !== existing.privacy_sensitivity;
                existing.privacy_sensitivity = sensitivity;
                const escalated = rank(level) !== rank(existing.level) || severity !== existing.severity;
                if (escalated) {
                    existing.level = level;
                    existing.severity = severity;
                }
                if (escalated || sensitivityUp) {
                    existing.revision += 1;
                    if (summary !== null) existing.summary = summary;
                }
                await backing.put(existing);
                emit(escalated ? "notification.escalated" : "notification.coalesced", existing, "ok");
                return surfaceRecord(existing);
            }
            // Unknown occurrence older than the retention horizon: it may have been
            // compacted, so it is a stale replay, never a new notification.
            if (occurredAt < now - retentionMs) return null;
            const rec = {
                notification_id: idFactory(),
                dedup_key: dedupKey,
                source_ref: { entity_type: ref.entity_type, entity_id: ref.entity_id },
                source_event: event,
                source_occurrence_id: sourceOccurrenceId,
                occurred_at: occurredAt,
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
            await backing.create(rec);
            emit("notification.created", rec, "ok");
            return surfaceRecord(rec);
        });
    }

    function transition(target, stamp) {
        return (notificationId) => withSharedLock(MUTATE_LOCK, async () => {
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
        // Bounded, newest-first discovery. Default and maximum page sizes are finite.
        async list({ state = null, sourceType = null, limit = DEFAULT_LIST_LIMIT } = {}) {
            const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT);
            const recs = await backing.list({
                limit: cap,
                predicate: (r) => (!state || r.state === state) && (!sourceType || r.source_ref.entity_type === sourceType)
            });
            return recs.map((r) => surfaceRecord(r));
        },
        // Retention: removes terminal notifications last touched before the
        // horizon, with their index entry and dedup key. ACTIVE records never move.
        async compact() {
            const horizon = clock() - retentionMs;
            return withSharedLock(MUTATE_LOCK, () => backing.compact({
                removable: (r) => TERMINAL.has(r.state) && r.last_event_at < horizon
            }));
        }
    });
}

module.exports = { createNotificationDomain, STATE, TERMINAL, TRANSITIONS, SENSITIVITY, NotificationError };
