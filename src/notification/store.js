"use strict";

// Canonical Notification Domain persistence over the repository-native ACC KV
// store (same substrate/prefix convention as src/cognition/mission/store.js).
// Records, the occurrence dedup key and the discovery index are separate keys.
// Discovery goes through a paged index (src/canonical/kvIndex.js), never one
// growing array. Dedup entries are removed together with their record when a
// terminal notification is compacted (DP §54, bounded retention).

const { createPagedIndex } = require("../canonical/kvIndex");

const P = "notification:";

function makeNotificationStore(acc) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function") {
        throw new TypeError("notification store requires an ACC KV store (getKv/putKv)");
    }
    const index = createPagedIndex(acc, P);
    const store = {
        async get(notificationId) {
            return acc.getKv(`${P}rec:${notificationId}`);
        },
        async put(rec) {
            await acc.putKv(`${P}rec:${rec.notification_id}`, rec);
            return rec;
        },
        // New occurrence: index entry first, then record and dedup key. See kvIndex.
        async create(rec) {
            await index.append(rec.notification_id);
            await store.put(rec);
            await acc.putKv(`${P}dedup:${rec.dedup_key}`, rec.notification_id);
            return rec;
        },
        async byDedup(dedupKey) {
            const id = await acc.getKv(`${P}dedup:${dedupKey}`);
            return id ? store.get(id) : null;
        },
        async list({ limit, predicate }) {
            return index.walk({ readRecord: (id) => store.get(id), predicate, limit });
        },
        async compact({ removable }) {
            return index.compact({
                readRecord: (id) => store.get(id),
                removable,
                onRemove: async (rec) => {
                    await acc.putKv(`${P}rec:${rec.notification_id}`, null);
                    await acc.putKv(`${P}dedup:${rec.dedup_key}`, null);
                }
            });
        }
    };
    return store;
}

module.exports = { makeNotificationStore };
