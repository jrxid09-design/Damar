"use strict";

const test = require("node:test");
const { assert, FakeObserver, makeGovernor, BASE_CONFIG, demand } = require("./helpers");
const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");
const { ADMISSION_OUTCOMES: OUT, REASONS } = require("../../src/runtime/resourceGovernor/model");

const DANGEROUS_NAMES = [
    "constructor", "toString", "valueOf", "hasOwnProperty",
    "__proto__", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"
];

test("prototype escape: inherited Object.prototype names cannot act as groups", () => {
    for (const name of DANGEROUS_NAMES) {
        const gov = makeGovernor({ config: BASE_CONFIG });
        const d = gov.admit(createWorkloadId(`escape-${name.length}`), demand({ concurrencyGroup: name }));
        assert.equal(d.outcome, OUT.REJECT_RESOURCE_LIMIT, `group "${name}" must fail closed`);
        assert.equal(d.reason, REASONS.UNKNOWN_GROUP);
    }
});

test("prototype escape: dangerous names are rejected even in explicit configuration", () => {
    for (const name of DANGEROUS_NAMES) {
        assert.throws(() =>
            makeGovernor({
                config: {
                    globalConcurrencyLimit: 8,
                    groupLimits: { default: 8, [name]: 4 }
                }
            }), /INVALID_RESOURCE_GOVERNOR_CONFIG|closed/,
            `"${name}" must not become a valid group via config`);
    }
});

test("prototype escape: group counters stay within limits under mixed escape attempts", () => {
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 6, groupLimits: { default: 2 }, maxQueue: 32 }
    });
    let i = 0;
    for (const name of [...DANGEROUS_NAMES, "default", "default"]) {
        gov.admit(createWorkloadId(`mix-${i++}`),
            demand({ concurrencyGroup: name, workloadClass: "TOOL" }));
    }
    const st = gov.getResourceStatus();
    assert.equal(st.perGroup.default <= 2, true);
    assert.equal(st.activeLeases <= 6, true);
    assert.ok(st.faulted === null);
});

test("config: validated groupLimits map has null prototype (no inherited keys)", () => {
    const cfg = require("../../src/runtime/resourceGovernor/config")
        .validateResourceGovernorConfig(BASE_CONFIG);
    assert.equal(Object.getPrototypeOf(cfg.groupLimits), null);
    for (const name of DANGEROUS_NAMES) {
        assert.equal(Object.prototype.hasOwnProperty.call(cfg.groupLimits, name), false);
        assert.equal(cfg.groupLimits[name], undefined);
    }
});
