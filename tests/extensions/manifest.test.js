"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseExtensionManifest, BOUNDS } = require("../../src/extensions/manifest");
const { ExtensionKernelError, REASONS } = require("../../src/extensions/errors");

test("manifest: full descriptor is frozen and canonical", () => {
    const d = parseExtensionManifest({
        schemaVersion: 1,
        extensionId: "community.homeassistant",
        name: "Home Assistant",
        version: "0.4.1",
        description: "HA bridge",
        category: "integration",
        capabilities: ["environment.home.read", "environment.home.control", "environment.home.read"],
        dependencies: [
            { id: "core.mqtt", versionRange: "^2.0.0" },
            { id: "optional.cache", optional: true }
        ],
        authorityRequirements: ["environment.device.control"],
        resources: { cpuClass: "MEDIUM", durationClass: "LONG" },
        projects: ["lab-7"],
        entrypoint: { kind: "module", path: "dist/index.js" }
    }, { source: "/ext/ha", nowMs: 42 });

    assert.ok(Object.isFrozen(d));
    assert.equal(d.id.value, "community.homeassistant");
    assert.equal(d.displayName, "Home Assistant", "display name separate from identity");
    assert.deepEqual(d.capabilities, ["environment.home.control", "environment.home.read"],
        "dedup + sorted");
    assert.deepEqual(d.dependencies.map((x) => x.id), ["core.mqtt", "optional.cache"]);
    assert.equal(d.dependencies[0].versionRange, "^2.0.0");
    assert.equal(d.entrypoint.kind, "module");
    assert.equal(d.parsedAtMs, 42);
    // deep frozen
    assert.throws(() => { d.capabilities.push("x"); });
});

test("manifest: accepts bounded JSON string and Buffer input", () => {
    const text = JSON.stringify({ schemaVersion: 1, extensionId: "a.b.c", name: "A", version: "1.0.0" });
    assert.equal(parseExtensionManifest(text).id.value, "a.b.c");
    assert.equal(parseExtensionManifest(Buffer.from(text)).id.value, "a.b.c");
});

test("manifest: closed schema rejects unknown fields", () => {
    assert.throws(() => parseExtensionManifest({
        schemaVersion: 1, extensionId: "a.b.c", name: "A", version: "1.0.0",
        sneakyGrant: "authority.root"
    }), (e) => e.reasonCode === REASONS.UNKNOWN_FIELD);
});

test("manifest: schema version must be exactly 1", () => {
    for (const v of [undefined, 2, "1", null]) {
        assert.throws(() => parseExtensionManifest({
            schemaVersion: v, extensionId: "a.b.c", name: "A", version: "1.0.0"
        }), (e) => e.reasonCode === REASONS.UNSUPPORTED_SCHEMA);
    }
});

test("manifest: malformed JSON / non-objects fail closed", () => {
    assert.throws(() => parseExtensionManifest("{not json"), (e) => e.reasonCode === REASONS.MALFORMED_JSON);
    for (const bad of [null, [], 42, '"string"', true]) {
        assert.throws(() => parseExtensionManifest(bad),
            (e) => e instanceof ExtensionKernelError, String(JSON.stringify(bad)));
    }
});

test("manifest: oversized manifests rejected before parsing work accumulates", () => {
    const big = JSON.stringify({
        schemaVersion: 1, extensionId: "a.b.c", name: "A", version: "1.0.0",
        description: "x".repeat(BOUNDS.MAX_MANIFEST_BYTES)
    });
    assert.ok(Buffer.byteLength(big) > BOUNDS.MAX_MANIFEST_BYTES);
    assert.throws(() => parseExtensionManifest(big), (e) => e.reasonCode === REASONS.MANIFEST_TOO_LARGE);
});

test("manifest: bounds on collections", () => {
    const base = { schemaVersion: 1, extensionId: "a.b.c", name: "A", version: "1.0.0" };
    assert.throws(() => parseExtensionManifest({
        ...base, capabilities: Array.from({ length: 33 }, (_, i) => `cap.${i}`)
    }), (e) => e.reasonCode === REASONS.BOUND_EXCEEDED);
    assert.throws(() => parseExtensionManifest({
        ...base, dependencies: Array.from({ length: 17 }, (_, i) => ({ id: `dep.${i}` }))
    }), (e) => e.reasonCode === REASONS.BOUND_EXCEEDED);
    assert.throws(() => parseExtensionManifest({
        ...base, authorityRequirements: Array.from({ length: 33 }, (_, i) => `auth.${i}`)
    }), (e) => e.reasonCode === REASONS.BOUND_EXCEEDED);
    // within bounds parses fine
    const okCaps = Array.from({ length: 32 }, (_, i) => `cap.${i}`);
    assert.equal(parseExtensionManifest({ ...base, capabilities: okCaps }).capabilities.length, 32);
});

test("manifest: malformed semantic versions rejected", () => {
    for (const v of ["1", "1.2", "v1.2.3", "01.2.3", "1.2.3.4", "latest", "*", "", 1]) {
        assert.throws(() => parseExtensionManifest({
            schemaVersion: 1, extensionId: "a.b.c", name: "A", version: v
        }), (e) => e instanceof ExtensionKernelError &&
            (e.reasonCode === REASONS.INVALID_VERSION || e.reasonCode === REASONS.MALFORMED_INPUT),
        String(v));
    }
    assert.equal(parseExtensionManifest({
        schemaVersion: 1, extensionId: "a.b.c", name: "A", version: "1.2.3-beta.11"
    }).version.prerelease.join("."), "beta.11");
});

test("manifest: dependency ranges validated at parse time", () => {
    const base = { schemaVersion: 1, extensionId: "a.b.c", name: "A", version: "1.0.0" };
    for (const range of [">=1.0.0", "^abc", "~", "^1.x", 123, "1.2.3 || 2.0"]) {
        assert.throws(() => parseExtensionManifest({
            ...base, dependencies: [{ id: "d.e.f", versionRange: range }]
        }), (e) => e instanceof ExtensionKernelError, String(range));
    }
    for (const range of ["^1.0.0", "~2.3.0", "1.0.0", "*"]) {
        parseExtensionManifest({ ...base, dependencies: [{ id: "d.e.f", versionRange: range }] });
    }
});

test("manifest: unsafe entrypoint paths rejected; never loaded anywhere", () => {
    const base = { schemaVersion: 1, extensionId: "a.b.c", name: "A", version: "1.0.0" };
    for (const p of ["/etc/passwd", "../escape.js", "..\\win.js", "C:\\x.js", "a\x00b", "has space.js"]) {
        assert.throws(() => parseExtensionManifest({
            ...base, entrypoint: { kind: "script", path: p }
        }), (e) => e instanceof ExtensionKernelError, p);
    }
    assert.equal(parseExtensionManifest({ ...base, entrypoint: { kind: "script", path: "lib/main.js" } })
        .entrypoint.path, "lib/main.js");
});
