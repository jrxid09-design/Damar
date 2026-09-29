"use strict";

function makeMigrationOps() {
    function checkMigrationPolicy(identity, policy) {
        // RT-W10-19: MIGRATION != AUTHORIZATION — explicit policy required
        if (!policy) {
            throw new Error("Migration refused — no policy provided (W10-L2/RT-W10-19)");
        }
        if (policy.allow !== true) {
            throw new Error("Migration refused by policy (W10-L2/RT-W10-19)");
        }
        return { allowed: true, identityId: identity.identityId, policy };
    }
    return { checkMigrationPolicy };
}

module.exports = { makeMigrationOps };
