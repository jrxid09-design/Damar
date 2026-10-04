"use strict";

// Canonical Notification Domain persistence over the repository-native ACC KV
// store (same substrate/prefix convention as src/cognition/mission/store.js).
// The dedup index is durable so a re-fired source event after a restart maps to
// the SAME notification (and is not resurrected if that notification is already
// terminal) — DP §54.

const P = "notification:";

function makeNotificationStore(acc) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function") {
        throw new TypeError("notification store requires an ACC KV store (getKv/putKv)");
    }
    const store = {
        async get(notificationId) {
            return acc.getKv(`${P}rec:${notificationId}`);
        },
        async put(rec) {
            await acc.putKv(`${P}rec:${rec.notification_id}`, rec);
            const idx = (await acc.getKv(`${P}index`)) || [];
            if (!idx.includes(rec.notification_id)) {
                idx.push(rec.notification_id);
                await acc.putKv(`${P}index`, idx);
            }
            await acc.putKv(`${P}dedup:${rec.dedup_key}`, rec.notification_id);
            return rec;
        },
        async byDedup(dedupKey) {
            const id = await acc.getKv(`${P}dedup:${dedupKey}`);
            return id ? store.get(id) : null;
        },
        async list() {
            const idx = (await acc.getKv(`${P}index`)) || [];
            const recs = await Promise.all(idx.map((id) => store.get(id)));
            return recs.filter(Boolean);
        }
    };
    return store;
}

module.exports = { makeNotificationStore };
