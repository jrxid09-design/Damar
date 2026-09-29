"use strict";

const MISSION_SCHEMA_VERSION = "mission.v1";

function makeMission(store) {
    async function create(missionId, opts = {}) {
        const existing = await store.getKv(`m:${missionId}`);
        if (existing) throw new Error(`Mission '${missionId}' already exists`);
        if (opts.parentId && opts.budget) {
            const parent = await store.getKv(`m:${opts.parentId}`);
            if (parent && parent.budget) {
                for (const [k, v] of Object.entries(opts.budget)) {
                    if (parent.budget[k] != null && v > parent.budget[k]) {
                        throw new Error(
                            `Sub-mission budget for '${k}' (${v}) exceeds parent slice (${parent.budget[k]}) — slice non-additive (W9-L1/RT-W9-03)`
                        );
                    }
                }
            }
        }
        const record = {
            schemaVersion: MISSION_SCHEMA_VERSION, missionId,
            state: "DRAFT", ownerApproved: false,
            label: opts.label || "", source: opts.source || null,
            scope: opts.scope || [], budget: opts.budget || {},
            capabilities: opts.capabilities || [],
            durationCapMs: opts.durationCapMs || null,
            activatedAt: null, parentId: opts.parentId || null,
            requiresReport: opts.requiresReport || false, createdAt: Date.now(),
        };
        await store.putKv(`m:${missionId}`, record);
        await store.addToIndex("missions", missionId);
        return record;
    }

    async function get(missionId) {
        return store.getKv(`m:${missionId}`);
    }

    async function activate(missionId, { ownerApproval = false } = {}) {
        const m = await store.getKv(`m:${missionId}`);
        if (!m) throw new Error(`Mission '${missionId}' not found`);
        if (!ownerApproval) throw new Error(`Mission activation requires owner approval — currently DRAFT (W9-L1/RT-W9-01)`);
        const updated = Object.assign({}, m, { state: "ACTIVE", ownerApproved: true, activatedAt: Date.now() });
        await store.putKv(`m:${missionId}`, updated);
        return updated;
    }

    async function widenScope(missionId, newScope) {
        throw new Error(`Scope widening refused and audited — Damar cannot widen mission scope at runtime (W9-L1/RT-W9-02)`);
    }

    async function complete(missionId, { evidence, t1Ref } = {}) {
        if (!t1Ref) throw new Error(`Mission completion requires T1 verified evidence reference — execution results alone do not certify completion (W9-L1/RT-W9-04)`);
        const m = await store.getKv(`m:${missionId}`);
        if (!m) throw new Error(`Mission '${missionId}' not found`);
        const updated = Object.assign({}, m, { state: "COMPLETED", completedAt: Date.now(), t1Ref });
        await store.putKv(`m:${missionId}`, updated);
        return updated;
    }

    async function pause(missionId, { reason } = {}) {
        const m = await store.getKv(`m:${missionId}`);
        if (!m) throw new Error(`Mission '${missionId}' not found`);
        const updated = Object.assign({}, m, { state: "PAUSED", pausedReason: reason || null, pausedAt: Date.now() });
        await store.putKv(`m:${missionId}`, updated);
        return updated;
    }

    async function resume(missionId, { ownerApproval = false } = {}) {
        if (!ownerApproval) throw new Error(`Self-resume after safety pause refused — owner approval required to resume (W9-L1/RT-W9-05)`);
        const m = await store.getKv(`m:${missionId}`);
        if (!m) throw new Error(`Mission '${missionId}' not found`);
        const updated = Object.assign({}, m, { state: "ACTIVE", resumedAt: Date.now() });
        await store.putKv(`m:${missionId}`, updated);
        return updated;
    }

    async function checkDuration(missionId) {
        const m = await store.getKv(`m:${missionId}`);
        if (!m || m.state !== "ACTIVE") return m;
        if (m.durationCapMs && m.activatedAt && (Date.now() - m.activatedAt) > m.durationCapMs) {
            const updated = Object.assign({}, m, { state: "BLOCKED", blockedReason: "duration_cap_exceeded", blockedAt: Date.now() });
            await store.putKv(`m:${missionId}`, updated);
            return updated;
        }
        return m;
    }

    async function suppressReport(missionId) {
        throw new Error(`Report suppression refused — reporting obligation cannot be removed (W9-L1/RT-W9-07)`);
    }

    async function revokeCapability(missionId, capability) {
        const m = await store.getKv(`m:${missionId}`);
        if (!m) throw new Error(`Mission '${missionId}' not found`);
        const caps = (m.capabilities || []).filter(c => c !== capability);
        const updated = Object.assign({}, m, { capabilities: caps, state: "BLOCKED", blockedReason: `capability_revoked:${capability}`, blockedAt: Date.now() });
        await store.putKv(`m:${missionId}`, updated);
        return updated;
    }

    async function borrowCapability(missionId, capability, { fromMission } = {}) {
        throw new Error(`Cross-mission privilege borrowing refused — capabilities are per-intent (W9-L1/RT-W9-09)`);
    }

    return { create, get, activate, widenScope, complete, pause, resume, checkDuration, suppressReport, revokeCapability, borrowCapability };
}

module.exports = { makeMission };
