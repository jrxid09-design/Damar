"use strict";

// Storage-scoped primitives shared by the canonical DP domains (approval,
// notification). ACC KV exposes only getKv/putKv: no compare-and-swap, no
// transaction, no prefix listing. Two consequences drive this module:
//
//  1. Every read-modify-write on a shared key runs under withSharedLock. The lock
//     map is MODULE scoped, so every domain instance in the process that touches
//     the same storage key serializes, not only instances sharing a closure.
//     ponytail: one process-wide lock map; cross-process writers need a native
//     ACC compare-and-swap, which the substrate does not expose yet.
//
//  2. Discovery uses a PAGED index (fixed-size id pages + a head record) instead
//     of one ever-growing array. Append writes the index entry BEFORE the record,
//     so a crash can leave an index id with no record (skipped on read) but never
//     a durable record that discovery cannot find.

const DEFAULT_PAGE_SIZE = 100;
const locks = new Map();

function withSharedLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const result = prev.then(() => fn());
    const tail = result.then(() => {}, () => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return result;
}

function createPagedIndex(acc, prefix, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const metaKey = `${prefix}idx:meta`;
    const pageKey = (n) => `${prefix}idx:p:${n}`;
    const lockKey = `${prefix}idx`;

    async function meta() { return (await acc.getKv(metaKey)) || { first: 0, last: 0 }; }

    return {
        // Index-first append: see module header.
        append(id) {
            return withSharedLock(lockKey, async () => {
                const m = await meta();
                let page = (await acc.getKv(pageKey(m.last))) || [];
                if (page.length >= pageSize) {
                    m.last += 1;
                    page = [];
                }
                page.push(id);
                await acc.putKv(pageKey(m.last), page);
                await acc.putKv(metaKey, m);
            });
        },

        // Newest-first bounded walk. readRecord(id) → record | null; predicate(rec) → bool.
        async walk({ readRecord, predicate = () => true, limit }) {
            const m = await meta();
            const out = [];
            for (let p = m.last; p >= m.first && out.length < limit; p -= 1) {
                const ids = (await acc.getKv(pageKey(p))) || [];
                for (let i = ids.length - 1; i >= 0 && out.length < limit; i -= 1) {
                    const rec = await readRecord(ids[i]);
                    if (rec && predicate(rec)) out.push(rec);
                }
            }
            return out;
        },

        // Drops index entries whose record satisfies removable(rec) and drops
        // dangling ids. onRemove(rec) lets the owner delete its own keys. Terminal
        // records are immutable, so reading them outside the record lock is safe.
        compact({ readRecord, removable, onRemove }) {
            return withSharedLock(lockKey, async () => {
                const m = await meta();
                let removed = 0;
                for (let p = m.first; p <= m.last; p += 1) {
                    const ids = (await acc.getKv(pageKey(p))) || [];
                    if (ids.length === 0) continue;
                    const keep = [];
                    for (const id of ids) {
                        const rec = await readRecord(id);
                        if (!rec) continue;
                        if (removable(rec)) { await onRemove(rec); removed += 1; }
                        else keep.push(id);
                    }
                    if (keep.length !== ids.length) await acc.putKv(pageKey(p), keep.length ? keep : null);
                }
                while (m.first < m.last && !(await acc.getKv(pageKey(m.first)))) {
                    await acc.putKv(pageKey(m.first), null);
                    m.first += 1;
                }
                await acc.putKv(metaKey, m);
                return removed;
            });
        }
    };
}

module.exports = { withSharedLock, createPagedIndex, DEFAULT_PAGE_SIZE };
