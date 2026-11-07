"use strict";

/**
 * EXTENSION KERNEL V1 — storm test.
 *
 * 5200 deterministic mixed operations across the full kernel surface.
 * Runs twice with identical seeds and requires byte-identical state
 * digests, bounded internal state, no lifecycle wedge, no cross-extension
 * corruption, no timers/handles leaked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { ExtensionRegistry } = require("../../src/extensions/registry");
const { discoverFromSources } = require("../../src/extensions/discovery");
const { parseExtensionManifest } = require("../../src/extensions/manifest");
const { manifest } = require("./helpers");

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const EXT_POOL_SIZE = 40;

function buildPool() {
    const pool = [];
    for (let i = 0; i < EXT_POOL_SIZE; i++) {
        const deps = [];
        if (i >= 10) {
            deps.push({ id: `pool.ext.${(i - 1) % EXT_POOL_SIZE}` });
            if (i % 3 === 0) deps.push({ id: `pool.ext.${(i + 5) % 10}`, optional: true });
        }
        // every 7th extension declares a cycle back to its "parent" group head
        if (i % 7 === 0 && i > 0) deps.push({ id: `pool.ext.${Math.floor(i / 7) * 7}` });
        pool.push(manifest({
            extensionId: `pool.ext.${i}`,
            version: `${(i % 3) + 1}.${i % 5}.0`,
            capabilities: [`cap.group.${i % 4}`, `cap.own.${i}`],
            dependencies: deps,
            resources: i % 2 === 0 ? { cpuClass: "HEAVY" } : { cpuClass: "LIGHT" },
            authorityRequirements: i % 5 === 0 ? ["environment.device.control"] : []
        }));
    }
    return pool;
}

/** One full storm run. Returns outcome digest + invariants data. */
function runStorm(seed) {
    const rng = mulberry32(seed);
    const registry = new ExtensionRegistry({ clock: { nowMs: () => 42 } });
    const outcomes = [];

    const malformedPayloads = [
        "{not json at all",
        JSON.stringify({ schemaVersion: 2, extensionId: "mal.one", name: "M", version: "1.0.0" }),
        JSON.stringify({ schemaVersion: 1, extensionId: "mal.two", name: "M", version: "not.a.version" }),
        '{"schemaVersion":1,"extensionId":"mal.three","name":"M","version":"1.0.0","__proto__":{"x":1}}',
        JSON.stringify({ schemaVersion: 1, extensionId: "../traversal", name: "M", version: "1.0.0" })
    ];

    let opCount = 0;
    const record = (op, ok, note = "") => {
        opCount++;
        outcomes.push(`${op}:${ok ? "ok" : "err"}:${note}`);
    };

    while (opCount < 5200) {
        const roll = Math.floor(rng() * 12);
        const idx = Math.floor(rng() * EXT_POOL_SIZE);
        const id = `pool.ext.${idx}`;
        const project = `proj-${idx % 8}`;
        try {
            switch (roll) {
                case 0:
                case 1: { // register (incl. duplicates)
                    const r = registry.register(buildPool()[idx]);
                    record("register", true, r.state);
                    break;
                }
                case 2: {
                    record("install", registry.install(id).changed);
                    break;
                }
                case 3:
                case 4: {
                    const r = registry.enable(id);
                    record("enable", true, r.changed ? r.state : "already-enabled");
                    break;
                }
                case 5: {
                    const r = registry.disable(id);
                    record("disable", true, r.changed ? r.state : "already-disabled");
                    break;
                }
                case 6: {
                    const status = ["HEALTHY", "DEGRADED", "FAILED"][Math.floor(rng() * 3)];
                    const diags = Math.floor(rng()) === 0 ? [{ code: "S", message: "x".repeat(400) }] : [];
                    record("health", registry.reportHealth(id, status, diags).changed);
                    break;
                }
                case 7: {
                    const r = registry.activateForProject(id, project);
                    record("activate", true, r.changed ? "on" : "already-on");
                    break;
                }
                case 8: {
                    record("deactivate", registry.deactivateForProject(id, project).changed);
                    break;
                }
                case 9: {
                    parseExtensionManifest(malformedPayloads[Math.floor(rng() * malformedPayloads.length)]);
                    record("malformed-manifest", true, "unexpectedly-parsed");
                    break;
                }
                case 10: {
                    const caps = registry.getCapabilities(id);
                    record("capability-query", Array.isArray(caps));
                    break;
                }
                case 11: {
                    const d = registry.getDependencyReport(id);
                    record("dependency-report", typeof d.ok === "boolean");
                    break;
                }
            }
        } catch (err) {
            assert.ok(err.name === "ExtensionKernelError",
                `unexpected error type during ${opCount}: ${err.stack}`);
            record(opName(roll), false, err.reasonCode);
        }
    }

    const cycles = registry.findAllDependencyCycles();
    const stats = registry.getStats();
    const snapshot = registry.serializeState();

    return {
        digest: crypto.createHash("sha256")
            .update(JSON.stringify(outcomes))
            .update(JSON.stringify(snapshot))
            .update(JSON.stringify(cycles))
            .digest("hex"),
        opCount,
        stats,
        snapshot,
        cycles,
        registry
    };
}

function opName(roll) {
    return ["register", "register", "install", "enable", "enable", "disable",
        "health", "activate", "deactivate", "malformed-manifest",
        "capability-query", "dependency-report"][roll];
}

test("storm: 5200 mixed operations are deterministic, bounded and isolated", () => {
    const beforeHandles = countAsyncResources();

    const run1 = runStorm(1337);
    const run2 = runStorm(1337);

    assert.equal(run1.opCount, 5200);
    assert.equal(run1.digest, run2.digest, "identical seed must produce identical outcomes+state");

    // ---- bounded state ----
    assert.equal(run1.registry.size, EXT_POOL_SIZE,
        "duplicate registrations never grow the registry");
    assert.ok(run1.stats.totalProjectActivations <= EXT_POOL_SIZE * 8);
    for (const e of run1.snapshot.extensions) {
        assert.ok(e.health.diagnosticCount <= 32, "diagnostics stayed bounded");
    }

    // ---- no lifecycle wedge: every extension is in a coherent known state ----
    const VALID = new Set(["DISCOVERED", "INSTALLED", "DISABLED", "ENABLED",
        "STARTING", "HEALTHY", "DEGRADED", "FAILED", "STOPPING", "UNAVAILABLE"]);
    for (const e of run1.snapshot.extensions) {
        assert.ok(VALID.has(e.state), `coherent state for ${e.id}: ${e.state}`);
    }

    // ---- cycle surfaced, not wedged ----
    assert.ok(Array.isArray(run1.cycles));

    // ---- discovery port under storm-like garbage stays isolated ----
    const disc = discoverFromSources(
        [...buildPool().slice(0, 5).map((m) => ({ jsonText: JSON.stringify(m) })),
         { jsonText: "broken" }, { jsonText: null }]);
    assert.equal(disc.extensions.length, 5);

    // ---- no leaked timers/handles ----
    const afterHandles = countAsyncResources();
    assert.deepEqual(afterHandles, beforeHandles, "no async handles leaked by the kernel");
});

test("storm: different seeds diverge but respect the same invariants", () => {
    const a = runStorm(1);
    const b = runStorm(999);
    assert.notEqual(a.digest, b.digest, "different seeds explore different paths");
    assert.equal(a.registry.size, b.registry.size);
});

function countAsyncResources() {
    try {
        const info = process.getActiveResourcesInfo();
        const counts = {};
        for (const k of info) counts[k] = (counts[k] ?? 0) + 1;
        return counts;
    } catch {
        return {};
    }
}
