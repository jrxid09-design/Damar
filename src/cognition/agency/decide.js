"use strict";

const { DECISION_SCHEMA_VERSION, DECISION_STATES } = require("./laws");

function makeDecide(store) {
    // RT-W10-45: serialize concurrent decisions per subject
    const activeSubjects = new Map();

    async function decide(intention, options, preferences, values, budget) {
        const { subject } = intention;

        // wait for any in-progress decision on this subject
        if (activeSubjects.has(subject)) {
            await activeSubjects.get(subject);
        }

        let resolveActive;
        const promise = new Promise(r => { resolveActive = r; });
        activeSubjects.set(subject, promise);

        try {
            budget.tick();

            // RT-W10-40: record all alternatives — chosen is first, rest are alternatives
            const chosen = options.length > 0 ? options[0] : null;
            const alternatives = options.slice(1);

            const decision = {
                schemaVersion: DECISION_SCHEMA_VERSION,
                decisionId: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                intentionId: intention.intentionId,
                subject: intention.subject,
                actionIntent: chosen
                    ? { kind: "ActionIntent", option: chosen, intentionId: intention.intentionId }
                    : null,
                alternatives,
                state: DECISION_STATES.RESOLVED,
                resolvedAt: Date.now(),
            };

            await store.putDecision(decision);
            return decision;
        } finally {
            resolveActive();
            activeSubjects.delete(subject);
        }
    }

    return { decide };
}

module.exports = { makeDecide };
