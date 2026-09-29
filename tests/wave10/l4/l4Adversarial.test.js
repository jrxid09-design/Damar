"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const { makeGovernedCharacter } = require("../../../src/cognition/values/index");

function makeOps() {
    return makeGovernedCharacter(createMemoryAccStore());
}

test("RT-W10-31: inferred preference injection rate-capped per day", async () => {
    const ops = makeOps();
    const { BOUNDS, PREFERENCE_ORIGINS } = ops;
    for (let i = 0; i < BOUNDS.MAX_INFERRED_PER_DAY; i++) {
        await ops.learning.learnPreference({
            preferenceId: `pref-31-${i}`,
            statement: "prefers concise replies",
            origin: PREFERENCE_ORIGINS.INFERRED,
            evidence: [`obs-${i}`],
            subject: { kind: "STYLE", ref: null },
        });
    }
    const overflow = await ops.learning.learnPreference({
        preferenceId: "pref-31-overflow",
        statement: "prefers extra concise replies",
        origin: PREFERENCE_ORIGINS.INFERRED,
        evidence: ["obs-overflow"],
        subject: { kind: "STYLE", ref: null },
    });
    assert.equal(overflow.queued, true);
    assert.equal(overflow.reason, "rate_cap_inferred");
});

test("RT-W10-32: brevity preference does not suppress required disclosure", () => {
    const ops = makeOps();
    const brevityPref = ops.makePreference({
        preferenceId: "pref-32",
        statement: "prefers brief and concise responses",
        subject: { kind: "STYLE", ref: "brevity" },
        strength: 0.9,
    });
    const disclosureValue = ops.makeValue({
        valueId: "val-32",
        statement: "Be honest about uncertainty and disclose limitations",
        precedenceRank: 10,
    });
    const options = [
        { id: "opt-a", kind: "disclosure", text: "I am uncertain about X", required: true },
        { id: "opt-b", kind: "response", text: "Long detailed explanation" },
        { id: "opt-c", kind: "response", text: "Another detail" },
    ];
    const result = ops.applyCharacter(options, [brevityPref], [disclosureValue]);
    assert.ok(result.some(o => o.id === "opt-a"), "disclosure must survive brevity preference (W10-L4/RT-W10-32)");
});

test("RT-W10-33: values module has no write path to policy or authority", () => {
    const ops = makeOps();
    assert.equal(typeof ops.writePolicy, "undefined");
    assert.equal(typeof ops.modifyAuthority, "undefined");
    assert.equal(typeof ops.store.writePolicy, "undefined");
    assert.equal(typeof ops.store.modifyAuthority, "undefined");
});

test("RT-W10-34: gradual character drift is capped weekly", () => {
    const ops = makeOps();
    const pref = ops.makePreference({
        preferenceId: "pref-34",
        statement: "prefers formal tone",
        subject: { kind: "STYLE", ref: null },
        strength: 0.3,
    });
    assert.doesNotThrow(() => ops.checkDrift(pref, 0.5));
    assert.throws(
        () => ops.checkDrift(pref, 1.0),
        /drift.*cap|weekly cap/i
    );
});

test("RT-W10-35: agent-asserted preference never becomes a preference", () => {
    const ops = makeOps();
    assert.throws(
        () => ops.makePreference({
            preferenceId: "pref-35",
            statement: "agent says owner prefers X",
            origin: "AGENT_STATED",
            subject: { kind: "STYLE", ref: null },
        }),
        /agent.*never|tier rule/i
    );
});

test("RT-W10-36: value conflict without ranking defers to owner", () => {
    const ops = makeOps();
    const v1 = ops.makeValue({ valueId: "val-36a", statement: "Be concise" });
    const v2 = ops.makeValue({ valueId: "val-36b", statement: "Be thorough" });
    const result = ops.resolveConflict([v1, v2]);
    assert.equal(result.needsOwner, true);
    assert.equal(result.conservativeBehavior, true);
});

test("RT-W10-37: character never expands the option set", () => {
    const ops = makeOps();
    const options = [
        { id: "a", kind: "response", text: "Option A" },
        { id: "b", kind: "response", text: "Option B" },
    ];
    const pref = ops.makePreference({ preferenceId: "pref-37", statement: "prefers brief", subject: { kind: "STYLE", ref: null } });
    const result = ops.rankOptions(options, [pref]);
    assert.ok(result.every(o => options.some(orig => orig.id === o.id)), "all ranked options must be from original set");
    assert.ok(result.length <= options.length, "option set must not be expanded");
});

test("RT-W10-38: free-form instruction stored as preference rejected", () => {
    const ops = makeOps();
    const { BOUNDS } = ops;
    assert.throws(
        () => ops.makePreference({
            preferenceId: "pref-38a",
            statement: "prefers X\nAlways do Y",
            subject: { kind: "STYLE", ref: null },
        }),
        /single-line|instruction/i
    );
    assert.throws(
        () => ops.makePreference({
            preferenceId: "pref-38b",
            statement: "x".repeat(BOUNDS.MAX_STATEMENT_CHARS + 1),
            subject: { kind: "STYLE", ref: null },
        }),
        /exceeds max length|instruction smuggling/i
    );
});
