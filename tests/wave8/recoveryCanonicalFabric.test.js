"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");

test("recovery embodiment capabilities are admitted by the canonical Lane 2 registry", () => {
    const { createCanonicalActionFacade } = require("../../src/action/bootstrap");
    const lane2 = createCanonicalActionFacade();
    for (const [capabilityId, operation, args] of [
        ["damar.media", "download", { videoId: "dQw4w9WgXcQ" }],
        ["damar.desktop", "listWindows", {}],
        ["damar.backup", "copy", { source: "C:/source", dest: "C:/destination" }],
        ["damar.kali", "run", { command: "printf governed", cwd: null, timeout: 300000 }]
    ]) {
        const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId, operation, arguments: args }));
        assert.equal(intent.capabilityId, capabilityId);
        assert.equal(intent.operation, operation);
        assert.ok(Array.isArray(intent.scope) && intent.scope.length > 0);
    }
});

test("recovery wiring uses the existing canonical composition and has no private execution runtime", () => {
    const bootstrap = fs.readFileSync(path.join(ROOT, "src/action/bootstrap.js"), "utf8");
    const wiring = fs.readFileSync(path.join(ROOT, "src/action/capabilities/embodimentWiring.js"), "utf8");
    assert.match(bootstrap, /wireEmbodimentCapabilities/);
    assert.match(bootstrap, /wireEmbodimentActuators/);
    assert.match(bootstrap, /wireEmbodimentVerifiers/);
    assert.doesNotMatch(wiring, /new\s+CanonicalCapabilityExecution\s*\(/);
    assert.doesNotMatch(wiring, /createCanonicalReplayLedger\s*\(/);
    assert.doesNotMatch(wiring, /loadAndEvaluateAuthority\s*\(/);
});

test("canonical production facades retain least-privilege surfaces after recovery wiring", () => {
    const bootstrap = require("../../src/action/bootstrap");
    assert.deepEqual(Object.keys(bootstrap.createCanonicalActuationFacade()).sort(), [
        "execute", "isCanonicalExecutionRequest", "isCanonicalExecutionResult"
    ]);
    assert.deepEqual(Object.keys(bootstrap.createCanonicalVerificationFacade()).sort(), [
        "compensate", "isCanonicalCompensationPlan", "isCanonicalVerificationRequest",
        "isCanonicalVerificationResult", "verify"
    ]);
});

test("recovered service adapters fail closed without Manager context and own no process launcher", async () => {
    const desktopSource = fs.readFileSync(path.join(ROOT, "src/services/desktopControlService.js"), "utf8");
    const mediaSource = fs.readFileSync(path.join(ROOT, "src/services/streamResolver.js"), "utf8");
    const backupSource = fs.readFileSync(path.join(ROOT, "src/services/backupService.js"), "utf8");
    for (const source of [desktopSource, mediaSource, backupSource]) {
        assert.doesNotMatch(source, /node:child_process|child_process|\bspawn\s*\(|\bexecFile\s*\(/);
    }
    const desktop = require("../../src/services/desktopControlService");
    const media = require("../../src/services/streamResolver");
    assert.equal((await desktop.openApp("notepad")).effectInvoked, false);
    assert.equal(await media.downloadMedia("dQw4w9WgXcQ"), null);
});

test("replay rollback witness is durable and independent from the Owner Trust audit stream", () => {
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "damar-replay-witness-"));
    const file = path.join(dir, "witness.jsonl");
    const { createCanonicalReplayWitness } = require("../../src/manager/internal/canonicalReplayWitness");
    const witness = createCanonicalReplayWitness(file);
    assert.deepEqual(witness.read(), { seq: 0, token: null });
    witness.commit(1, "event-hmac-1");
    assert.deepEqual(createCanonicalReplayWitness(file).read(), { seq: 1, token: "event-hmac-1" });
    assert.throws(() => witness.commit(0, "old"), /ROLLBACK/);
    fs.rmSync(dir, { recursive: true, force: true });
});
