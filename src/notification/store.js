"use strict";

// Canonical Notification Domain persistence over the repository-native ACC KV
// store (same substrate/prefix convention as src/cognition/mission/store.js).
// Records, the occurrence dedup key and the discovery index are separate keys
// written in ONE acc.transact (see src/canonical/kvIndex.js), so a committed
// notification is always discoverable and a failed create leaves nothing behind.
// Dedup entries are removed together with their record when a terminal
// notification is compacted (DP §54, bounded retention).
// REPLAY FENCE (R3): compaction leaves a bounded TOMBSTONE per occurrence key, stamped
// with the store's clock (never the caller's occurredAt). Tombstones are pruned by the
// same retention window, so the fence is bounded. A replay of a compacted occurrence is
// rejected by its tombstone whatever occurredAt the replay carries.

const { createPagedIndex } = require("../canonical/kvIndex");
const { detach } = require("../canonical/projection");

const P = "notification:";

function makeNotificationStore(acc) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function" || typeof acc.transact !== "function") {
        throw new TypeError("notification store requires an ACC KV store with the transact primitive");
    }
    const index = createPagedIndex(P);
    const tombIndex = createPagedIndex(`${P}tombix:`);
    const recKey = (notificationId) => `${P}rec:${notificationId}`;
    const dedupKey = (key) => `${P}dedup:${key}`;
    const tombKey = (key) => `${P}tomb:${key}`;
    const readIn = async (tx, notificationId) => detach(await tx.getKv(recKey(notificationId)));

    const store = {
        async get(notificationId) {
            return detach(await acc.getKv(recKey(notificationId)));
        },
        async byDedup(key) {
            const id = await acc.getKv(dedupKey(key));
            return id ? store.get(id) : null;
        },
        async tombstoned(key) {
            return (await acc.getKv(tombKey(key))) !== null;
        },
        // Atomic create-or-find on the occurrence key. created=false means another
        // process (or instance) already recorded this occurrence; its id is returned so
        // the caller coalesces instead of creating a duplicate.
        createIfAbsent(rec) {
            return acc.transact(async (tx) => {
                const existingId = await tx.getKv(dedupKey(rec.dedup_key));
                if (existingId) return { created: false, id: existingId };
                await index.appendIn(tx, rec.notification_id);
                await tx.putKv(recKey(rec.notification_id), detach(rec));
                await tx.putKv(dedupKey(rec.dedup_key), rec.notification_id);
                return { created: true, id: rec.notification_id };
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
        // tombstoneHorizon. Returns the number of records compacted.
        compact(removable, { compactedAt, tombstoneHorizon }) {
            return acc.transact(async (tx) => {
                const removed = await index.compactIn(tx, {
                    readRecord: (id) => readIn(tx, id),
                    removable,
                    onRemove: async (rec) => {
                        await tx.putKv(recKey(rec.notification_id), null);
                        await tx.putKv(dedupKey(rec.dedup_key), null);
                        await tombIndex.appendIn(tx, rec.dedup_key);
                        await tx.putKv(tombKey(rec.dedup_key), { dedup_key: rec.dedup_key, compacted_at: compactedAt });
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

module.exports = { makeNotificationStore };
