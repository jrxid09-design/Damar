"use strict";

// Canonical Approval Domain persistence over the repository-native ACC KV
// store (same substrate and prefix convention as src/cognition/mission/store.js).
//
// DURABILITY CONTRACT (DP §30-§33): DP owns a durable HUMAN-DECISION record.
// It NEVER persists an executable continuation, a closure, a callback, or the
// branded confirmation requirement / confirmation evidence. Those are
// process-local to frozen HC; a durable approval record that outlives its
// process-local HC continuation is reconciled fail-closed, never resumed.

const P = "approval:";

function makeApprovalStore(acc) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function") {
        throw new TypeError("approval store requires an ACC KV store (getKv/putKv)");
    }
    const store = {
        async get(approvalId) {
            return acc.getKv(`${P}rec:${approvalId}`);
        },
        async put(rec) {
            await acc.putKv(`${P}rec:${rec.approval_id}`, rec);
            const idx = (await acc.getKv(`${P}index`)) || [];
            if (!idx.includes(rec.approval_id)) {
                idx.push(rec.approval_id);
                await acc.putKv(`${P}index`, idx);
            }
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
        async list() {
            const idx = (await acc.getKv(`${P}index`)) || [];
            const recs = await Promise.all(idx.map((id) => store.get(id)));
            return recs.filter(Boolean);
        }
    };
    return store;
}

module.exports = { makeApprovalStore };
