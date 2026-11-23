"use strict";

// Storage-scoped primitives shared by the canonical DP domains (approval,
// notification).
//
// ATOMICITY (R2): every mutation of shared state goes through the ACC-level
// `acc.transact` primitive (src/cognition/persistence/AccStore.js). A record and
// its index entry are written in ONE transaction, so across OS processes sharing
// one store either both commit or neither does. withSharedLock is only a
// same-process serializer for read-decide-write sequences on one record; it is
// NOT a correctness boundary for shared storage.
//
// DISCOVERY (R2): a paged index (fixed-size id pages + a meta record). Ids are
// appended at the head. walk() is newest-first and resumes from an OPAQUE cursor
// that names the last scanned id. Cursor is position, never authority.
//
// SNAPSHOT: a traversal is not one atomic snapshot. For a stable dataset it yields
// every live record exactly once. Records appended mid-traversal are newer than the
// cursor and are not returned by it. A cursor whose id was compacted away fails
// closed with INVALID_CURSOR.

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

class InvalidCursorError extends Error {
    constructor() {
        super("INVALID_CURSOR");
        this.name = "InvalidCursorError";
        this.code = "INVALID_CURSOR";
    }
}

function encodeCursor(id) {
    return Buffer.from(JSON.stringify({ v: 1, after: id }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
    if (cursor === null || cursor === undefined) return null;
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512) throw new InvalidCursorError();
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
    catch { throw new InvalidCursorError(); }
    if (!parsed || parsed.v !== 1 || typeof parsed.after !== "string") throw new InvalidCursorError();
    return parsed.after;
}

function createPagedIndex(prefix, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const metaKey = `${prefix}idx:meta`;
    const pageKey = (n) => `${prefix}idx:p:${n}`;

    return {
        // Index entry at the head. Call inside acc.transact together with the record
        // write so that both commit or roll back as one.
        async appendIn(tx, id) {
            const m = (await tx.getKv(metaKey)) || { first: 0, last: 0 };
            let page = (await tx.getKv(pageKey(m.last))) || [];
            if (page.length >= pageSize) {
                m.last += 1;
                page = [];
            }
            page.push(id);
            await tx.putKv(pageKey(m.last), page);
            await tx.putKv(metaKey, m);
        },

        // Bounded newest-first walk. Returns { items, nextCursor }; nextCursor is null
        // when the index is exhausted. The cursor advances past non-matching entries,
        // so a filtered page never repeats or skips items.
        async walk(acc, { readRecord, predicate = () => true, limit, cursor = null }) {
            const after = decodeCursor(cursor);
            const m = (await acc.getKv(metaKey)) || { first: 0, last: 0 };
            let page = m.last;
            let at = null;
            if (after !== null) {
                page = -1;
                for (let q = m.last; q >= m.first; q -= 1) {
                    const idx = ((await acc.getKv(pageKey(q))) || []).lastIndexOf(after);
                    if (idx >= 0) { page = q; at = idx; break; }
                }
                if (page < 0) throw new InvalidCursorError();
            }
            const items = [];
            for (let p = page; p >= m.first; p -= 1) {
                const ids = (await acc.getKv(pageKey(p))) || [];
                for (let i = (p === page && at !== null ? at - 1 : ids.length - 1); i >= 0; i -= 1) {
                    const rec = await readRecord(ids[i]);
                    if (rec && predicate(rec)) items.push(rec);
                    if (items.length === limit) return { items, nextCursor: encodeCursor(ids[i]) };
                }
            }
            return { items, nextCursor: null };
        },

        // Drops index entries whose record satisfies removable(rec) and dangling ids.
        // onRemove(rec) lets the owner delete its own keys in the same transaction.
        async compactIn(tx, { readRecord, removable, onRemove }) {
            const m = (await tx.getKv(metaKey)) || { first: 0, last: 0 };
            let removed = 0;
            for (let p = m.first; p <= m.last; p += 1) {
                const ids = (await tx.getKv(pageKey(p))) || [];
                if (ids.length === 0) continue;
                const keep = [];
                for (const id of ids) {
                    const rec = await readRecord(id);
                    if (!rec) continue;
                    if (removable(rec)) { await onRemove(rec); removed += 1; }
                    else keep.push(id);
                }
                if (keep.length !== ids.length) await tx.putKv(pageKey(p), keep.length ? keep : null);
            }
            while (m.first < m.last && !(await tx.getKv(pageKey(m.first)))) {
                await tx.putKv(pageKey(m.first), null);
                m.first += 1;
            }
            await tx.putKv(metaKey, m);
            return removed;
        }
    };
}

function lockRegistrySize() { return locks.size; }

module.exports = { withSharedLock, lockRegistrySize, createPagedIndex, InvalidCursorError, DEFAULT_PAGE_SIZE };
