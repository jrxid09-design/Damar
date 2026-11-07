"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createExtensionId, createProjectId, canonicalCapabilityName, idToString } =
    require("../../src/extensions/ids");
const { ExtensionKernelError, REASONS } = require("../../src/extensions/errors");

test("identity: canonical extension ids are stable and branded", () => {
    const a = createExtensionId("community.home-assistant");
    const b = createExtensionId("community.home-assistant");
    assert.equal(a.value, "community.home-assistant");
    assert.ok(a.equals(b));
    assert.notEqual(a, b, "separate frozen instances");
    assert.equal(idToString(a), "community.home-assistant");
});

test("identity: branding is verified, never assumed", () => {
    const fake = { kind: "ExtensionId", value: "evil.ext", toString: () => "evil.ext" };
    assert.throws(() => createExtensionId(fake), ExtensionKernelError,
        "unbranded lookalike objects are rejected");
    const forged = JSON.parse('{"kind":"ExtensionId","value":"x"}');
    // 'x' violates grammar -> rejected even though it claims to be branded
    assert.throws(() => idToString(forged), ExtensionKernelError);
});

test("identity: rejects malformed / hostile identifiers", () => {
    const bad = [
        "", null, undefined, 42, {},
        "ab",                                  // too short
        "a".repeat(129),                       // too long
        "UPPER.case",                          // case collision impossible
        "has space",                           // whitespace
        "tab\tid",
        "nbsp\u00a0id",
        "../etc/passwd",                       // path traversal
        "../../",
        "a/b/c",
        "back\\slash",
        "scheme://x",
        ".leading",
        "trailing.",
        "double..dot",
        "core.__proto__",                      // prototype-pollution segment
        "constructor",
        "__proto__",
        "prototype.something"
    ];
    for (const v of bad) {
        assert.throws(() => createExtensionId(v), (e) =>
            e instanceof ExtensionKernelError,
        `should reject: ${JSON.stringify(v)?.slice(0, 40)}`);
    }
});

test("identity: project ids use the same canonical grammar but distinct brand", () => {
    const p = createProjectId("lab-7");
    assert.equal(p.kind, "ProjectId");
    assert.throws(() => createProjectId("BAD PROJECT"), ExtensionKernelError);
    // cross-kind confusion fails closed
    const e = createExtensionId("some.extension");
    assert.throws(() => createProjectId(e), ExtensionKernelError,
        "branded ExtensionId must not be accepted as ProjectId");
});

test("identity: capability names normalize case and reject garbage", () => {
    assert.equal(canonicalCapabilityName("Environment.Home.Read"), "environment.home.read");
    for (const v of ["", "..", "a..b", ".lead", "trail.", "UPPER!X", 42, null]) {
        assert.throws(() => canonicalCapabilityName(v), ExtensionKernelError);
    }
});

test("identity: error contract carries reason codes", () => {
    try {
        createExtensionId("../escape");
        assert.fail("must throw");
    } catch (e) {
        assert.ok(e instanceof ExtensionKernelError);
        assert.equal(e.reasonCode, REASONS.INVALID_EXTENSION_ID);
        assert.ok(e.details.received.includes(".."));
    }
});
