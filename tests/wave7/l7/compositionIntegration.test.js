const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createRuntimeCore } = require("../../../src/integration/canonicalRuntimeComposition");

function fakeRegistry() {
    return { get: () => null, has: () => false, getAvailability: () => { throw new Error("unused"); } };
}

function tmpStateDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-w7l7-"));
}

test("W7-L7 composition: enableCognition defaults to false — core.cognition is null, zero footprint (GATE-W7-10)", async (t) => {
    const stateDir = tmpStateDir();
    const core = await createRuntimeCore({
        mediaStorageRoot: path.join(stateDir, "media-v1")
    });
    t.after(() => { try { core.shutdown({ reason: "test-end" }); } catch { /* idempotent */ } });

    assert.equal(core.cognition, null, "tanpa enableCognition, tidak ada apa pun yang dibangun");
});

test("W7-L7 composition: enableCognition=true wires the longhorizon cycle in the declared mode", async (t) => {
    const stateDir = tmpStateDir();
    const core = await createRuntimeCore({
        mediaStorageRoot: path.join(stateDir, "media-v1"),
        enableCognition: true,
        cognitionMode: "shadow",
        cognitionCapabilityRegistry: fakeRegistry()
    });
    t.after(() => { try { core.shutdown({ reason: "test-end" }); } catch { /* idempotent */ } });

    assert.ok(core.cognition, "enableCognition=true membangun composition longhorizon");
    assert.equal(core.cognition.mode, "shadow");
    const result = await core.cognition.cycle();
    assert.equal(result.decisionInfluence, false);
});
