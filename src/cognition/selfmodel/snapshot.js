"use strict";

/**
 * W7-L1 SELF-MODEL — perakitan SelfModelSnapshot (spec §4 + §9 "Snapshot
 * over budget"). Truncation berurutan deterministik dari domain paling
 * murah untuk dikorbankan ke paling mahal, dan SELALU menandai
 * `snapshotTruncated: true` — tidak pernah diam-diam memotong.
 */

const { SCHEMA_VERSION } = require("./bounds");

function byteSize(value) {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function buildSnapshot({
    identity, runtimeLocation, capabilityAssessments, unknowns,
    activeLimitations, healthState, degradedSubsystems, resourcePressure,
    activeProviders, knownNodes, reachableNodes, activeGoalRefs,
    activeMissionRefs, generatedAtMs, maxSnapshotBytes
}) {

    let truncated = false;

    const domainsInSacrificeOrder = [
        "activeMissionRefs", "activeGoalRefs", "knownNodes", "reachableNodes",
        "degradedSubsystems", "activeLimitations", "unknowns", "capabilityAssessments"
    ];

    const live = {
        activeMissionRefs, activeGoalRefs, knownNodes, reachableNodes,
        degradedSubsystems, activeLimitations, unknowns, capabilityAssessments
    };

    function assemble() {
        return Object.freeze({
            schemaVersion: SCHEMA_VERSION,
            generatedAtMs,
            identity: Object.freeze({ ...identity }),
            runtimeLocation: Object.freeze({ ...runtimeLocation }),
            capabilityAssessments: Object.freeze([...live.capabilityAssessments]),
            unknowns: Object.freeze([...live.unknowns]),
            activeLimitations: Object.freeze([...live.activeLimitations]),
            healthState,
            degradedSubsystems: Object.freeze([...live.degradedSubsystems]),
            resourcePressure,
            activeProviders: Object.freeze([...activeProviders]),
            knownNodes: Object.freeze([...live.knownNodes]),
            reachableNodes: Object.freeze([...live.reachableNodes]),
            activeGoalRefs: Object.freeze([...live.activeGoalRefs]),
            activeMissionRefs: Object.freeze([...live.activeMissionRefs]),
            snapshotTruncated: truncated
        });
    }

    let snapshot = assemble();
    let cursor = 0;
    while (byteSize(snapshot) > maxSnapshotBytes && cursor < domainsInSacrificeOrder.length) {
        const key = domainsInSacrificeOrder[cursor];
        const arr = live[key];
        if (Array.isArray(arr) && arr.length > 0) {
            live[key] = arr.slice(0, Math.max(0, Math.floor(arr.length / 2)));
            truncated = true;
        } else {
            cursor += 1;
        }
        snapshot = assemble();
    }

    return snapshot;
}

module.exports = { byteSize, buildSnapshot };
