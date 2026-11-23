"use strict";

// Canonical Notification Domain persistence over the repository-native ACC KV
// store (same substrate/prefix convention as src/cognition/mission/store.js).
// Records, the occurrence dedup key and the discovery index are separate keys
// written in ONE acc.transact (see src/canonical/kvIndex.js), so a committed
// notification is always discoverable and a failed create leaves nothing behind.
// Dedup entries are removed together with their record when a terminal
// notification is compacted (DP §54, bounded retention).
//
// ADMISSION (R3C): admit() decides, inside ONE acc.transact, whether a source
// occurrence is new, a stale replay, an exact replay of a live record, or an identity
// conflict, and writes the record AND the per-stream HIGH-WATER in that same
// transaction. The high-water is the authoritative anti-replay fence: it holds the last
// accepted sourceOccurrenceSequence of one canonical source stream and is never pruned
// while the stream exists. Tombstones are retention-bounded coalescing aids only.

const crypto = require("node:crypto");
const { createPagedIndex } = require("../canonical/kvIndex");
const { detach } = require("../canonical/projection");

const P = "notification:";

// Canonical identity encoding: SHA-256 over a JSON array of the parts. Parts are never
// concatenated as free text, so ":" inside an entity id cannot collide with another key.
function identityKey(parts) {
    return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

const DECISION = Object.freeze({ CREATED: "CREATED", EXISTING: "EXISTING", STALE: "STALE", CONFLICT: "CONFLICT" });

function makeNotificationStore(acc) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function" || typeof acc.transact !== "function") {
        throw new TypeError("notification store requires an ACC KV store with the transact primitive");
    }
    const index = createPagedIndex(P);
    const tombIndex = createPagedIndex(`${P}tombix:`);
    const recKey = (notificationId) => `${P}rec:${notificationId}`;
    const dedupKey = (key) => `${P}dedup:${key}`;
    const tombKey = (key) => `${P}tomb:${key}`;
    const hwKey = (streamKey) => `${P}seq:${streamKey}`;
    const readIn = async (tx, notificationId) => detach(await tx.getKv(recKey(notificationId)));

    const store = {
        async get(notificationId) {
            return detach(await acc.getKv(recKey(notificationId)));
        },
        // Atomic admission of one source occurrence. rec.dedup_key is the occurrence identity;
        // streamKey is the canonical source stream; sequence is the source-owned generation.
        // Returns { decision, id }. Only CREATED writes; the high-water advances only then.
        admit(rec, streamKey, sequence) {
            return acc.transact(async (tx) => {
                const occurrenceId = rec.source_occurrence_id;
                const hw = await tx.getKv(hwKey(streamKey));
                if (hw) {
                    if (sequence < hw.sequence) return { decision: DECISION.STALE, id: null };
                    if (sequence === hw.sequence && hw.occurrence_id !== occurrenceId) return { decision: DECISION.CONFLICT, id: null };
                    // A consumed occurrence id cannot be reused for a later generation.
                    if (sequence > hw.sequence && hw.occurrence_id === occurrenceId) return { decision: DECISION.CONFLICT, id: null };
                }
                const liveId = await tx.getKv(dedupKey(rec.dedup_key));
                if (liveId) {
                    const live = await readIn(tx, liveId);
                    if (live && live.source_occurrence_sequence !== sequence) return { decision: DECISION.CONFLICT, id: null };
                    if (live) return { decision: DECISION.EXISTING, id: liveId };
                }
                const tomb = await tx.getKv(tombKey(rec.dedup_key));
                if (tomb) return { decision: tomb.sequence === sequence ? DECISION.STALE : DECISION.CONFLICT, id: null };
                // Exact replay of the high-water occurrence whose record and tombstone are gone.
                if (hw && sequence === hw.sequence) return { decision: DECISION.STALE, id: null };

                await index.appendIn(tx, rec.notification_id);
                await tx.putKv(recKey(rec.notification_id), detach(rec));
                await tx.putKv(dedupKey(rec.dedup_key), rec.notification_id);
                await tx.putKv(hwKey(streamKey), { sequence, occurrence_id: occurrenceId, dedup_key: rec.dedup_key });
                return { decision: DECISION.CREATED, id: rec.notification_id };
            });
        },
        // Atomic read-modify-write of one record across processes. fn(draft) mutates a
        // detached draft (or throws to abort); persisted in the same transaction.
        // Resolves to fn's return value, or null when the record is absent.
        mutate(notificationId, fn) {
            return acc.transact(async (tx) => {
                const draft = await readIn(tx, notificationId);
                if (!draft) return null;
                const out = await fn(draft);
                await tx.putKv(recKey(notificationId), detach(draft));
                return out;
            });
        },
        // Bounded newest-first page. cursor is opaque (see kvIndex.walk).
        page({ limit, cursor, predicate }) {
            return index.walk(acc, { readRecord: (id) => store.get(id), predicate, limit, cursor });
        },
        // One transaction: drop compacted records and their dedup keys, leave a
        // tombstone stamped with compactedAt, and prune tombstones older than
        // tombstoneHorizon. The high-water is never touched here. Returns the number of records compacted.
        compact(removable, { compactedAt, tombstoneHorizon }) {
            return acc.transact(async (tx) => {
                const removed = await index.compactIn(tx, {
                    readRecord: (id) => readIn(tx, id),
                    removable,
                    onRemove: async (rec) => {
                        await tx.putKv(recKey(rec.notification_id), null);
                        await tx.putKv(dedupKey(rec.dedup_key), null);
                        await tombIndex.appendIn(tx, rec.dedup_key);
                        await tx.putKv(tombKey(rec.dedup_key), { dedup_key: rec.dedup_key, compacted_at: compactedAt, sequence: rec.source_occurrence_sequence });
                    }
                });
                await tombIndex.compactIn(tx, {
                    readRecord: (key) => tx.getKv(tombKey(key)),
                    removable: (t) => t.compacted_at < tombstoneHorizon,
                    onRemove: (t) => tx.putKv(tombKey(t.dedup_key), null)
                });
                return removed;
            });
        }
    };
    return store;
}

module.exports = { makeNotificationStore, identityKey, DECISION };
