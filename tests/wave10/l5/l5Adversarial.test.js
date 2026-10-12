"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const { makeUnifiedAgency } = require("../../../src/cognition/agency/index");
const { makeAgencyStore } = require("../../../src/cognition/agency/store");

function makeAgency() {
    return makeUnifiedAgency(createMemoryAccStore());
}

test("RT-W10-39: intention without intentText refused", () => {
    const agency = makeAgency();
    assert.throws(
        () => agency.makeIntention({ intentionId: "i39", subject: "sub39" }),
        /intentText required|intentless/i
    );
    assert.throws(
        () => agency.makeIntention({ intentionId: "i39b", intentText: "Do something" }),
        /subject required|intentless/i
    );
});

test("RT-W10-40: all alternatives recorded in decision", async () => {
    const agency = makeAgency();
    const decision = await agency.deliberate(
        { intentionId: "i40", subject: "s40", intentText: "Pick one" },
        [
            { id: "a", text: "option A" },
            { id: "b", text: "option B" },
            { id: "c", text: "option C" },
        ],
        [], []
    );
    assert.ok(Array.isArray(decision.alternatives), "alternatives must be array");
    assert.equal(decision.alternatives.length, 2, "2 non-chosen options recorded as alternatives");
    assert.ok(decision.actionIntent !== null, "actionIntent set");
});

test("RT-W10-41: deliberation budget exhaustion ends in ask-or-defer", () => {
    const agency = makeAgency();
    const budget = agency.createBudget();
    let threw = false;
    try {
        for (let i = 0; i < 1000; i++) budget.tick();
    } catch (err) {
        threw = true;
        assert.ok(
            err instanceof agency.BudgetExhaustedError || err.requiresDefer === true,
            "must be BudgetExhaustedError with requiresDefer"
        );
        assert.match(err.message, /budget exhausted|ask-or-defer/i);
    }
    assert.ok(threw, "budget must throw on exhaustion");
});

test("RT-W10-42: in-flight decisions abandoned on restart", async () => {
    const acc = createMemoryAccStore();
    // Seed both DELIBERATING and PENDING (invariant names both states)
    const store = makeAgencyStore(acc);
    await store.putDecision({
        schemaVersion: 1, decisionId: "dec-old-42", intentionId: "i42-old",
        subject: "restart-subject", actionIntent: null, alternatives: [],
        state: "DELIBERATING", resolvedAt: null,
    });
    await store.putDecision({
        schemaVersion: 1, decisionId: "dec-old-42p", intentionId: "i42-old-p",
        subject: "restart-subject-p", actionIntent: null, alternatives: [],
        state: "PENDING", resolvedAt: null,
    });

    const agency2 = makeUnifiedAgency(acc);
    await agency2.deliberate(
        { intentionId: "i42-new", subject: "other-subject", intentText: "fresh intent" },
        [{ id: "x", text: "option x" }], [], []
    );

    const decisions = await store.getDecisions();
    const old = decisions.find(d => d.decisionId === "dec-old-42");
    assert.ok(old, "old DELIBERATING decision still in store");
    assert.equal(old.state, "ABANDONED", "DELIBERATING decision must be ABANDONED after restart");
    assert.equal(old.abandonReason, "restart");
    const oldP = decisions.find(d => d.decisionId === "dec-old-42p");
    assert.ok(oldP, "old PENDING decision still in store");
    assert.equal(oldP.state, "ABANDONED", "PENDING decision must be ABANDONED after restart");
    assert.equal(oldP.abandonReason, "restart");

    // On store failure, deliberate() must throw — not silently skip abandonment
    const brokenAcc = {
        getKv: async () => { throw new Error("store-fault-42"); },
        putKv: async () => { throw new Error("store-fault-42"); },
    };
    const faultAgency = makeUnifiedAgency(brokenAcc);
    await assert.rejects(
        () => faultAgency.deliberate(
            { intentionId: "i42-fault", subject: "fault-subject", intentText: "fault test" },
            [], [], []
        ),
        /store-fault-42/
    );
});

test("RT-W10-43: nonsense options filtered before ranking", async () => {
    const agency = makeAgency();
    const decision = await agency.deliberate(
        { intentionId: "i43", subject: "s43", intentText: "Choose" },
        [
            { id: "bad1", text: "" },
            { id: "bad2", text: "   " },
            { id: "good", text: "valid option" },
        ],
        [], []
    );
    // All options in decision must have non-empty text
    const allOpts = [
        decision.actionIntent && decision.actionIntent.option,
        ...decision.alternatives,
    ].filter(Boolean);
    assert.ok(allOpts.length > 0, "at least one valid option");
    assert.ok(
        allOpts.every(o => typeof o.text === "string" && o.text.trim().length > 0),
        "all selected/alternative options must have non-empty text"
    );
});

test("RT-W10-44: values never expand option set during ranking", () => {
    const agency = makeAgency();
    const options = [
        { id: "a", text: "option A" },
        { id: "b", text: "option B" },
    ];
    const result = agency.rankOptions(options, [], [{ valueId: "v1", statement: "Always prefer efficiency" }]);
    assert.equal(result.length, options.length, "option count must not grow");
    assert.ok(result.every(o => options.some(orig => orig.id === o.id)), "all ranked options from original set");
});

test("RT-W10-45: concurrent decisions for same subject serialized", async () => {
    const agency = makeAgency();
    const [d1, d2] = await Promise.all([
        agency.deliberate(
            { intentionId: "i45a", subject: "shared-subject", intentText: "Do A" },
            [{ id: "x", text: "x" }],
            [], []
        ),
        agency.deliberate(
            { intentionId: "i45b", subject: "shared-subject", intentText: "Do B" },
            [{ id: "y", text: "y" }],
            [], []
        ),
    ]);
    assert.ok(d1.decisionId !== d2.decisionId, "two distinct decision IDs");
    assert.equal(d1.state, "RESOLVED");
    assert.equal(d2.state, "RESOLVED");
});
