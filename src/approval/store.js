"use strict";

// Canonical Approval Domain persistence over the repository-native ACC KV
// store (same substrate and prefix convention as src/cognition/mission/store.js).
//
// DURABILITY CONTRACT (DP §30-§33): DP owns a durable HUMAN-DECISION record.
// It NEVER persists an executable continuation, a closure, a callback, or the
// branded confirmation requirement / confirmation evidence. Those are
// process-local to frozen HC; a durable approval record that outlives its
// process-local HC continuation is reconciled fail-closed, never resumed.
//
// ATOMICITY (R2): create, read-modify-write and compaction each run in ONE
// acc.transact. The record, its discovery entry and its requirement back-reference
// commit together or not at all, across processes (see src/canonical/kvIndex.js).
// Records are detached on every read and write, so no caller holds canonical state.

const { createPagedIndex } = require("../canonical/kvIndex");
const { detach } = require("../canonical/projection");

const P = "approval:";

function makeApprovalStore(acc) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function" || typeof acc.transact !== "function") {
        throw new TypeError("approval store requires an ACC KV store with the transact primitive");
    }
    const index = createPagedIndex(P);
    const recKey = (approvalId) => `${P}rec:${approvalId}`;
    const byReqKey = (requirementId) => `${P}byreq:${requirementId}`;
    const readIn = async (tx, approvalId) => detach(await tx.getKv(recKey(approvalId)));

    const store = {
        async get(approvalId) {
            return detach(await acc.getKv(recKey(approvalId)));
        },
        async byRequirement(requirementId) {
            const id = await acc.getKv(byReqKey(requirementId));
            return id ? store.get(id) : null;
        },
        // Atomic create-or-find. created=false means this requirement already has an
        // approval, possibly minted by another process; that one is returned instead of
        // a second one (DP §13).
        createIfAbsent(rec) {
            return acc.transact(async (tx) => {
                const existingId = await tx.getKv(byReqKey(rec.requirement_ref));
                if (existingId) return { created: false, id: existingId };
                // DP §10: approval_id references confirmation_requirement_id; the two
                // identities are never collapsed into one value.
                await index.appendIn(tx, rec.approval_id);
                await tx.putKv(recKey(rec.approval_id), detach(rec));
                await tx.putKv(byReqKey(rec.requirement_ref), rec.approval_id);
                return { created: true, id: rec.approval_id };
            });
        },
        // Atomic read-modify-write of one record across processes. fn(draft) mutates a
        // detached draft (or throws to abort); the draft is persisted in the same
        // transaction. Resolves to fn's return value, or null when the record is absent.
        mutate(approvalId, fn) {
            return acc.transact(async (tx) => {
                const draft = await readIn(tx, approvalId);
                if (!draft) return null;
                const out = await fn(draft);
                await tx.putKv(recKey(approvalId), detach(draft));
                return out;
            });
        },
        // Bounded newest-first page. cursor is opaque (see kvIndex.walk).
        page({ limit, cursor, predicate }) {
            return index.walk(acc, { readRecord: (id) => store.get(id), predicate, limit, cursor });
        },
        compact(removable) {
            return acc.transact((tx) => index.compactIn(tx, {
                readRecord: (id) => readIn(tx, id),
                removable,
                onRemove: async (rec) => {
                    await tx.putKv(recKey(rec.approval_id), null);
                    await tx.putKv(byReqKey(rec.requirement_ref), null);
                }
            }));
        }
    };
    return store;
}

module.exports = { makeApprovalStore };
