"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExtensionManifest } = require("../../src/extensions/manifest");
const { makeRegistry, manifest } = require("./helpers");

test("security: prototype pollution payloads rejected at any depth", () => {
    const attacks = [
        '{"schemaVersion":1,"extensionId":"p.ext","name":"P","version":"1.0.0","__proto__":{"polluted":"yes"}}',
        '{"schemaVersion":1,"extensionId":"p.ext","name":"P","version":"1.0.0","configuration":{"nested":{"__proto__":{"x":1}}}}',
        '{"schemaVersion":1,"extensionId":"p.ext","name":"P","version":"1.0.0","dependencies":[{"id":"d.e","constructor":{"prototype":{}}}]}',
        '{"schemaVersion":1,"extensionId":"p.ext","name":"P","version":"1.0.0","resources":{"prototype":"HEAVY"}}'
    ];
    for (const payload of attacks) {
        assert.throws(() => parseExtensionManifest(payload),
            (e) => e.reasonCode === "DANGEROUS_KEY", payload.slice(0, 60));
    }
    // and nothing actually leaked onto Object.prototype
    assert.equal({}.polluted, undefined);
    assert.equal({}.x, undefined);
});

test("security: hostile returned objects are contained", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "victim.ext",
        configuration: { allowed: true }
    }), { install: true });

    const cfg = registry.getDescriptor("victim.ext").configuration;
    assert.ok(Object.isFrozen(cfg));
    assert.throws(() => { cfg.allowed = false; });
    assert.equal(registry.getDescriptor("victim.ext").configuration.allowed, true);

    const values = registry.setConfigurationValues("victim.ext", { k: "v" });
    void values;
    const got = registry.getConfigurationValues("victim.ext");
    assert.throws(() => { got.k = "hijacked"; });
    try { got.__proto__ = { hijacked: true }; } catch { /* frozen */ }
    assert.equal(({}).hijacked, undefined);
    assert.equal(registry.getConfigurationValues("victim.ext").k, "v");

    // setting config values with dangerous keys fails closed
    const sneaky = JSON.parse('{"normal":1,"__proto__":{"bad":2}}');
    assert.throws(() => registry.setConfigurationValues("victim.ext", sneaky),
        (e) => e.reasonCode === "DANGEROUS_KEY");
    assert.equal(({}).bad, undefined);
});

test("security: dependency bomb stays bounded", () => {
    const { registry } = makeRegistry({ maxExtensions: 64 });
    const fanout = Array.from({ length: 16 }, (_, i) => ({ id: `bomb.${i}` }));
    for (let i = 0; i < 4; i++) {
        registry.register(manifest({
            extensionId: `bomb.${i}`,
            dependencies: fanout.filter((d) => d.id !== `bomb.${i}`)
        }));
    }
    // cycle-ish fan-out must resolve reports quickly and deterministically
    const t0 = process.hrtime.bigint();
    const cycles = registry.findAllDependencyCycles();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `cycle scan took ${ms}ms`);
    void cycles;
    assert.equal(registry.size, 4);
});

test("security: no timers, intervals or immediates are created by the kernel", () => {
    const origTimeout = global.setTimeout;
    const origInterval = global.setInterval;
    const origImmediate = global.setImmediate;
    let created = 0;
    global.setTimeout = (...a) => { created++; return origTimeout(...a); };
    global.setInterval = (...a) => { created++; return origInterval(...a); };
    global.setImmediate = (...a) => { created++; return origImmediate(...a); };
    try {
        const { registry } = makeRegistry();
        registry.register(manifest({
            extensionId: "timer.check",
            capabilities: ["c.one"],
            dependencies: [{ id: "t.dep", optional: true }]
        }), { install: true });
        registry.enable("timer.check");
        registry.reportHealth("timer.check", "DEGRADED", [{ code: "X" }]);
        registry.activateForProject("timer.check", "proj-1");
        registry.deactivateForProject("timer.check", "proj-1");
        registry.disable("timer.check");
        registry.findAllDependencyCycles();
        discoverQuiet();
        function discoverQuiet() {
            const { discoverFromSources } = require("../../src/extensions/discovery");
            discoverFromSources([{ jsonText: JSON.stringify(manifest({ extensionId: "q.one" })) }]);
        }
    } finally {
        global.setTimeout = origTimeout;
        global.setInterval = origInterval;
        global.setImmediate = origImmediate;
    }
    assert.equal(created, 0, "kernel must not schedule async work");
});
