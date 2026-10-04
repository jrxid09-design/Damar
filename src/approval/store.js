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
// DISCOVERY (DP-R1/R6): ids go through a paged index (src/canonical/kvIndex.js),
// not one growing array. Terminal records can be compacted after their
// requirement window plus retention, together with their requirement back-reference.

const { createPagedIndex } = require("../canonical/kvIndex");

const P = "approval:";

function makeApprovalStore(acc) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function") {
        throw new TypeError("approval store requires an ACC KV store (getKv/putKv)");
    }
    const index = createPagedIndex(acc, P);
    const store = {
        async get(approvalId) {
            return acc.getKv(`${P}rec:${approvalId}`);
        },
        async put(rec) {
            await acc.putKv(`${P}rec:${rec.approval_id}`, rec);
            return rec;
        },
        // New approval: index entry first (see kvIndex), then record and back-reference.
        async create(rec) {
            await index.append(rec.approval_id);
            await store.put(rec);
            // requirement_id -> approval_id back-reference. This is the ONE-WAY
            // link of DP §10: approval_id references confirmation_requirement_id;
            // the two identities are never collapsed into one value.
            await acc.putKv(`${P}byreq:${rec.requirement_ref}`, rec.approval_id);
            return rec;
        },
        async byRequirement(requirementId) {
            const id = await acc.getKv(`${P}byreq:${requirementId}`);
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
                    await acc.putKv(`${P}rec:${rec.approval_id}`, null);
                    await acc.putKv(`${P}byreq:${rec.requirement_ref}`, null);
                }
            });
        }
    };
    return store;
}

module.exports = { makeApprovalStore };
