"use strict";

const { BOUNDS } = require("./laws");

function makeDrillOps(store, bounds) {
    const threshold = (bounds && bounds.DRILL_OVERDUE_THRESHOLD_MS) || BOUNDS.DRILL_OVERDUE_THRESHOLD_MS;

    async function recordDrill(drillId, result) {
        await store.putDrill({ drillId, result, ranAt: Date.now() });
    }

    // RT-W10-55: skipping restore drills while reporting healthy must record continuity risk
    async function checkDrillHealth() {
        const lastDrill = await store.getLastDrill();
        if (!lastDrill || (Date.now() - lastDrill.ranAt > threshold)) {
            return {
                healthy: false,
                risk: "RESTORE_DRILL_OVERDUE",
                requiresOwnerNotification: true,
                lastDrillAt: lastDrill ? lastDrill.ranAt : null,
            };
        }
        return { healthy: true, lastDrillAt: lastDrill.ranAt };
    }

    return { recordDrill, checkDrillHealth };
}

module.exports = { makeDrillOps };
