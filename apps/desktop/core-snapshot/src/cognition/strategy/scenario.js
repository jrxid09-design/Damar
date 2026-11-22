"use strict";

const { BOUNDS, SCENARIO_SCHEMA_VERSION } = require("./bounds");

function makeScenario(store) {
    async function create(scenarioId, opts = {}) {
        if (opts.isFactual) {
            throw new Error(
                "Scenario claiming to be factual refused — all scenarios are labelled PREDICTION (W9-L6/ADR-11/RT-W9-39)"
            );
        }
        const branches = opts.branches || [];
        if (branches.length > BOUNDS.MAX_SCENARIO_BRANCHES) {
            throw new Error(
                `Scenario branch count (${branches.length}) exceeds MAX_SCENARIO_BRANCHES (${BOUNDS.MAX_SCENARIO_BRANCHES}) — branch cap exceeded (W9-L6/RT-W9-40)`
            );
        }
        const scenarios = await store.getIndex("scenarios");
        if (scenarios.length >= BOUNDS.MAX_SCENARIOS) throw new Error("MAX_SCENARIOS reached");
        const record = {
            schemaVersion: SCENARIO_SCHEMA_VERSION,
            scenarioId,
            kind: "PREDICTION",
            label: opts.label || "",
            branches,
            isFactual: false,
            createdAt: Date.now(),
        };
        await store.putKv(`scenario:${scenarioId}`, record);
        await store.addToIndex("scenarios", scenarioId);
        return record;
    }

    async function get(scenarioId) {
        return store.getKv(`scenario:${scenarioId}`);
    }

    return { create, get };
}

module.exports = { makeScenario };
