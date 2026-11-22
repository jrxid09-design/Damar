"use strict";

const { BOUNDS } = require("./bounds");

function makePlan(store, kinds) {
    async function createPlan(planId, opts = {}) {
        const existing = await store.getKv(`plan:${planId}`);
        if (existing) throw new Error(`Plan '${planId}' already exists`);
        const plans = await store.getIndex("plans");
        if (plans.length >= BOUNDS.MAX_PLANS) throw new Error("MAX_PLANS reached");
        const record = {
            planId,
            label: opts.label || "",
            budget: opts.budget || {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await store.putKv(`plan:${planId}`, record);
        await store.addToIndex("plans", planId);
        return record;
    }

    async function getPlan(planId) {
        return store.getKv(`plan:${planId}`);
    }

    async function replanBudget(planId, newBudget, { ownerApproval = false } = {}) {
        if (!ownerApproval) {
            throw new Error("Budget replan refused: owner approval required (W9-L5 law)");
        }
        const record = await store.getKv(`plan:${planId}`);
        if (!record) throw new Error(`Plan '${planId}' not found`);
        const updated = Object.assign({}, record, { budget: newBudget, updatedAt: Date.now() });
        await store.putKv(`plan:${planId}`, updated);
        return updated;
    }

    return { createPlan, getPlan, replanBudget };
}

module.exports = { makePlan };
