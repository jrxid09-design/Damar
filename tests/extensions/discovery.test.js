"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverExtensions, discoverFromSources } = require("../../src/extensions/discovery");
const { manifest } = require("./helpers");

function makeRoot(structure) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdisc-"));
    for (const [dirName, files] of Object.entries(structure)) {
        const dir = path.join(root, dirName);
        fs.mkdirSync(dir, { recursive: true });
        for (const [fileName, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, fileName), content);
        }
    }
    return root;
}

test("discovery: reads only configured roots, returns descriptors sorted", () => {
    const good = JSON.stringify(manifest({ extensionId: "z.ext" }));
    const early = JSON.stringify(manifest({ extensionId: "a.ext" }));
    const root = makeRoot({
        "zeta": { "damar-extension.json": good },
        "alpha": { "damar-extension.json": early }
    });
    const res = discoverExtensions({ roots: [root] });
    assert.deepEqual(res.extensions.map((d) => d.id.value), ["a.ext", "z.ext"],
        "deterministic ordering by canonical id");
    // descriptors are frozen and carry no code
    assert.ok(Object.isFrozen(res));
    assert.deepEqual(res.problems, []);
});

test("discovery: malformed extension isolated; others unaffected", () => {
    const root = makeRoot({
        "broken-json": { "damar-extension.json": "{ this is not json" },
        "bad-schema": {
            "damar-extension.json": JSON.stringify({
                schemaVersion: 9, extensionId: "bad.schema", name: "B", version: "1.0.0"
            })
        },
        "proto-attack": {
            "damar-extension.json": '{"schemaVersion":1,"extensionId":"evil.ext","name":"E","version":"1.0.0","__proto__":{"x":1}}'
        },
        "good-one": {
            "damar-extension.json": JSON.stringify(manifest({ extensionId: "good.ext" }))
        },
        "no-manifest-at-all": { "README.txt": "nothing here" }
    });
    const res = discoverExtensions({ roots: [root] });
    assert.deepEqual(res.extensions.map((d) => d.id.value), ["good.ext"]);
    const kinds = res.problems.map((p) => p.kind).sort();
    assert.ok(kinds.includes("MALFORMED_JSON"));
    assert.ok(kinds.includes("UNSUPPORTED_SCHEMA"));
    assert.ok(kinds.includes("DANGEROUS_KEY"));
    assert.ok(kinds.includes("NO_MANIFEST"));
});

test("discovery: missing root reported, not fatal", () => {
    const res = discoverExtensions({ roots: ["/definitely/not/here-xyz"] });
    assert.equal(res.extensions.length, 0);
    assert.equal(res.problems[0].kind, "ROOT_UNREADABLE");
});

test("discovery: duplicate canonical ids keep first occurrence deterministically", () => {
    const r1 = makeRoot({ "x": { "damar-extension.json": JSON.stringify(manifest({ extensionId: "dup.ext", version: "1.0.0" })) } });
    const r2 = makeRoot({ "x": { "damar-extension.json": JSON.stringify(manifest({ extensionId: "dup.ext", version: "9.9.9" })) } });
    const res = discoverExtensions({ roots: [r1, r2] });
    assert.equal(res.extensions.length, 1);
    assert.equal(res.extensions[0].version.raw, "1.0.0");
    assert.deepEqual(res.problems.map((p) => p.kind), ["DUPLICATE_ID"]);
});

test("discovery: bounded result count (storm safety)", () => {
    const structure = {};
    for (let i = 0; i < 40; i++) {
        structure[`e${String(i).padStart(3, "0")}`] =
            { "damar-extension.json": JSON.stringify(manifest({ extensionId: `bound.${i}` })) };
    }
    const root = makeRoot(structure);
    const res = discoverExtensions({ roots: [root], maxResults: 10 });
    assert.equal(res.extensions.length, 10);
});

test("discovery: oversized manifest file rejected with bound reason", () => {
    const root = makeRoot({
        "huge": { "damar-extension.json": JSON.stringify({
            schemaVersion: 1, extensionId: "big.ext", name: "B", version: "1.0.0",
            description: "x".repeat(70 * 1024)
        }) }
    });
    const res2 = discoverExtensions({ roots: [root] });
    assert.ok(res2.problems.some((p) => p.kind === "MANIFEST_TOO_LARGE" || p.kind === "MANIFEST_TOO_LARGE"),
        "oversized manifests produce a problem record");
    assert.equal(res2.extensions.length, 0);
});

test("discovery: pure in-memory source port mirrors semantics", () => {
    const res = discoverFromSources([
        { source: "s1", jsonText: JSON.stringify(manifest({ extensionId: "m.b" })) },
        { source: "s2", jsonText: "garbage{" },
        { source: "s3", jsonText: JSON.stringify(manifest({ extensionId: "m.a" })) }
    ]);
    assert.deepEqual(res.extensions.map((d) => d.id.value), ["m.a", "m.b"]);
    assert.equal(res.problems.length, 1);
});
