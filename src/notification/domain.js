"use strict";

// Canonical Surface Notification Domain owner (DP-L4..L5, repaired DP-R1..R6, R2).
//
// DOMAIN LAW: NOTIFICATION != AUTHORITY, SALIENCE != AUTHORITY, SOURCE DOMAIN
// != NOTIFICATION (DP §39, §40, §44). This domain owns notification identity,
// lifecycle, policy result, salience, sensitivity, dedup and a surface-safe
// read model. It references source domains (approval/mission/incident/...) but
// never owns their state, and NOTHING here executes an actuator, approves an
// approval, or mutates a source domain. Dismissing a notification mutates the
// notification ONLY (DP §47).
//
// REPAIR CONTRACT (DP-R2/R3/R4/R6, R2):
//  - Every write (emit, coalesce, transition, compaction) is one acc.transact
//    read-modify-write, so it is atomic across OS processes sharing the store. Terminal
//    states are final for the SAME source occurrence, in every process.
//  - Dedup identity is the source OCCURRENCE: entity + event + sourceOccurrenceId.
//    An exact replay of a known occurrence maps back to it; a new occurrence
//    creates a new notification. Entity+event alone is never a dedup key.
//  - ANTI-REPLAY (R3C): each canonical source stream (entity + event) has a persistent
//    HIGH-WATER of its last accepted sourceOccurrenceSequence, written in the same ACC
//    transaction as the notification it admits. Sequence <= high-water is rejected
//    forever while the stream exists; sequence > high-water with a new id is accepted.
//    The sequence is source-owned and required: missing or invalid fails closed, and
//    Notification never synthesizes it. occurredAt is metadata and never decides identity.
//  - Same id with another sequence, or same sequence with another id, is an identity
//    conflict and throws SOURCE_OCCURRENCE_IDENTITY_CONFLICT (no second notification).
//  - Sensitivity is monotonic per notification: NORMAL < SENSITIVE < SECRET.
//  - A compacted occurrence keeps a short bounded tombstone for coalescing only;
//    long-term replay safety never depends on it (the high-water is authoritative).
//  - Surface reads are deep copies; list() is cursor-paged, so no record is unreachable.

const crypto = require("node:crypto");
const { makeNotificationStore, identityKey, DECISION } = require("./store");
const { classify, LEVEL, rank } = require("./policy");
const { entityRef } = require("../ui-platform/entityRefs");
const { withSharedLock } = require("../canonical/kvIndex");
const { maxSensitivity, surfaceText, detach, SENSITIVITY } = require("../canonical/projection");

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

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
// ponytail: one lock for every notification write. Per-dedup-key locking if throughput matters.
const MUTATE_LOCK = "notification:mutate";

class NotificationError extends Error {
    constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = "NotificationError"; this.code = code; }
}

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
    // SENSITIVE/SECRET summary is never exposed unless the surface reveals it. Every
    // nested value is a copy, so the caller cannot reach canonical state (R2-2).
    function surfaceRecord(rec, { reveal = false } = {}) {
        return Object.freeze({
            notification_id: rec.notification_id,
            source_ref: detach(rec.source_ref),
            source_event: rec.source_event,
            source_occurrence_id: rec.source_occurrence_id,
            state: rec.state,
            delivery_state: rec.state,
            acknowledgement_state: rec.state === STATE.ACKNOWLEDGED ? "ACKNOWLEDGED" : "UNACKNOWLEDGED",
            urgency: rec.level,
            severity: rec.severity,
            privacy_sensitivity: rec.privacy_sensitivity,
            summary: surfaceText(rec.summary, rec.privacy_sensitivity, { reveal }),
            target_surfaces: detach(rec.target_surfaces ?? []),
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
    // occurrence of the same entity+event creates a new notification. occurredAt is
    // METADATA: it never takes part in identity, so changing it cannot revive an occurrence.
    // R3C: sourceOccurrenceSequence is the SOURCE-owned, monotonic generation of this
    // occurrence within its canonical stream (entity_type, entity_id, event). Notification
    // never derives it: a missing or invalid sequence fails closed before any state is touched.
    async function emitSource({ sourceType, sourceId, sourceOccurrenceId, sourceOccurrenceSequence, occurredAt, event = null,
        severity = "normal", privacySensitivity = "NORMAL", summary = null, targetSurfaces = [] } = {}) {
        const ref = entityRef(sourceType, sourceId); // validates canonical entity reference
        if (!SENSITIVITY.includes(privacySensitivity)) throw new NotificationError("INVALID_SENSITIVITY", privacySensitivity);
        if (typeof sourceOccurrenceId !== "string" || sourceOccurrenceId.length === 0) {
            throw new NotificationError("SOURCE_OCCURRENCE_REQUIRED", "emitSource needs the source occurrence identity");
        }
        if (sourceOccurrenceSequence === undefined || sourceOccurrenceSequence === null) {
            throw new NotificationError("SOURCE_OCCURRENCE_SEQUENCE_REQUIRED", "emitSource needs the source-owned occurrence sequence");
        }
        if (!Number.isSafeInteger(sourceOccurrenceSequence) || sourceOccurrenceSequence < 1) {
            throw new NotificationError("INVALID_SOURCE_OCCURRENCE_SEQUENCE", String(sourceOccurrenceSequence));
        }
        if (!Number.isFinite(occurredAt)) throw new NotificationError("SOURCE_OCCURRENCE_TIME_REQUIRED", "emitSource needs occurredAt");
        const level = classify({ sourceKind: sourceType, event, severity });
        if (level === LEVEL.NONE) return null; // policy: no notification

        // Occurrence identity is entity + event + sourceOccurrenceId; occurredAt is metadata.
        const streamKey = identityKey([ref.entity_type, ref.entity_id, event ?? null]);
        const dedupKey = identityKey([ref.entity_type, ref.entity_id, event ?? null, sourceOccurrenceId]);
        return withSharedLock(MUTATE_LOCK, async () => {
            const now = clock();
            const rec = {
                notification_id: idFactory(),
                dedup_key: dedupKey,
                source_ref: { entity_type: ref.entity_type, entity_id: ref.entity_id },
                source_event: event,
                source_occurrence_id: sourceOccurrenceId,
                source_occurrence_sequence: sourceOccurrenceSequence,
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
            // One ACC transaction decides admission and commits the high-water with the record.
            const adm = await backing.admit(rec, streamKey, sourceOccurrenceSequence);
            if (adm.decision === DECISION.CONFLICT) {
                throw new NotificationError("SOURCE_OCCURRENCE_IDENTITY_CONFLICT", "sourceOccurrenceId and sourceOccurrenceSequence disagree with the source stream");
            }
            if (adm.decision === DECISION.STALE) return null; // stale or replayed occurrence: fenced
            if (adm.decision === DECISION.CREATED) {
                emit("notification.created", rec, "ok");
                return surfaceRecord(rec);
            }
            // EXISTING: this occurrence already has a live record. Coalesce into it.
            const out = await backing.mutate(adm.id, (draft) => {
                // Terminal occurrence: an exact replay never revives it (DP §54, F2/F4).
                if (TERMINAL.has(draft.state)) return { rec: draft, event: null };
                draft.coalesce_count += 1;
                draft.last_event_at = now;
                // Sensitivity only ratchets up for this notification (F1).
                const sensitivity = maxSensitivity(draft.privacy_sensitivity, privacySensitivity);
                const sensitivityUp = sensitivity !== draft.privacy_sensitivity;
                draft.privacy_sensitivity = sensitivity;
                const escalated = rank(level) !== rank(draft.level) || severity !== draft.severity;
                if (escalated) {
                    draft.level = level;
                    draft.severity = severity;
                }
                if (escalated || sensitivityUp) {
                    draft.revision += 1;
                    if (summary !== null) draft.summary = summary;
                }
                return { rec: draft, event: escalated ? "notification.escalated" : "notification.coalesced" };
            });
            if (!out) return null; // compacted between read and write: stale replay
            if (out.event) emit(out.event, out.rec, "ok");
            return surfaceRecord(out.rec);
        });
    }

    function transition(target, stamp) {
        return (notificationId) => withSharedLock(MUTATE_LOCK, async () => {
            const out = await backing.mutate(notificationId, (draft) => {
                // Terminal is idempotent; a non-advancing transition (e.g. READ after
                // ACKNOWLEDGED) is a no-op read.
                if (TERMINAL.has(draft.state) || !TRANSITIONS[draft.state].includes(target)) return { rec: draft, changed: false };
                draft.state = target;
                draft.revision += 1;
                if (stamp) draft[stamp] = clock();
                // Dismissal/ack/read/resolve mutate ONLY the notification. This domain
                // holds no source-domain mutator, so it structurally cannot deny an
                // approval, close a mission or touch a DCD incident (DP §47).
                return { rec: draft, changed: true };
            });
            if (!out) throw new NotificationError("UNKNOWN_NOTIFICATION", notificationId);
            if (out.changed) emit(`notification.${target.toLowerCase()}`, out.rec, "ok");
            return surfaceRecord(out.rec);
        });
    }

    function pageLimit(limit) {
        return Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
    }

    async function page({ state = null, sourceType = null, limit = DEFAULT_LIST_LIMIT, cursor = null } = {}) {
        const r = await backing.page({
            limit: pageLimit(limit), cursor,
            predicate: (x) => (!state || x.state === state) && (!sourceType || x.source_ref.entity_type === sourceType)
        });
        return { items: r.items.map((x) => surfaceRecord(x)), nextCursor: r.nextCursor };
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
        // Bounded newest-first page: { items, nextCursor }. Pass nextCursor back, unchanged,
        // with the same filters, to continue. Cursor is position only, never authority.
        page,
        // Backward-compatible first page. Use page() to traverse beyond the first page.
        async list(opts = {}) { return (await page(opts)).items; },
        // Retention: removes terminal notifications last touched before the
        // horizon, with their index entry and dedup key. ACTIVE records never move.
        async compact() {
            const now = clock();
            const horizon = now - retentionMs;
            return withSharedLock(MUTATE_LOCK, () => backing.compact(
                (r) => TERMINAL.has(r.state) && r.last_event_at < horizon,
                { compactedAt: now, tombstoneHorizon: horizon }));
        }
    });
}

module.exports = { createNotificationDomain, STATE, TERMINAL, TRANSITIONS, SENSITIVITY, NotificationError };
