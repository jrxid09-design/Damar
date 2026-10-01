const test = require("node:test");
const assert = require("node:assert/strict");

const AITool = require("../../src/ai/tools/AITool");
const AIToolRegistry = require("../../src/ai/tools/AIToolRegistry");
const AIRuntime = require("../../src/ai/runtime/AIRuntime");
const Integration = require("../../src/ai/capability/ContextCapabilityIntegration");
const { createCapabilityRuntime } = require("../../src/capability/registry");

function tool(name, meta = {}) {
    return new AITool({
        name,
        description: `${name} camera image operation`,
        parameters: { type: "object" },
        meta: { readOnly: true, sideEffects: false, ...meta },
        execute: async () => ({ ok: true })
    });
}

function capabilityRuntime(id, availability = null) {
    const runtime = createCapabilityRuntime({ registrars: { core: true }, clock: { nowMs: () => 1000 } });
    const result = runtime.registrars.core.register(JSON.stringify({
        schemaVersion: 1,
        id,
        kind: "system",
        provider: "core",
        source: "core",
        operations: ["use"],
        requirements: [],
        effects: [],
        description: id
    }));
    if (availability) {
        runtime.registry.observeAvailability(id, availability, {
            generation: 1,
            incarnationId: result.incarnationId
        });
    }
    return runtime;
}

test("context output reaches capability evaluation and changes candidates counterfactually", () => {
    const registry = new AIToolRegistry();
    registry.register(tool("currentWeather", {
        contextConstraints: { requires: ["camera online"] }
    }));
    registry.register(tool("currentTime", {
        contextConstraints: { requires: ["microphone online"] }
    }));

    const runtime = new AIRuntime(null);
    runtime.setToolRegistry(registry);
    const request = {
        messages: [{ role: "user", content: "capture image" }],
        exec: { channel: "console", role: "user" }
    };
    const camera = runtime.resolveTools({
        ...request,
        contextSelection: {
            systemContent: "camera online",
            messages: request.messages,
            diagnostics: { itemsSelected: 1 }
        }
    });
    const microphone = runtime.resolveTools({
        ...request,
        contextSelection: {
            systemContent: "microphone online",
            messages: request.messages,
            diagnostics: { itemsSelected: 1 }
        }
    });

    assert.deepEqual(camera.map(item => item.name), ["currentWeather"]);
    assert.deepEqual(microphone.map(item => item.name), ["currentTime"]);
    assert.equal(runtime.lastContextCapabilityIntegration.authorityGranted, false);
});

test("relevance and availability remain distinct in the projection", () => {
    const contextual = Integration.project({
        tools: [tool("camera_capture", { contextConstraints: { requires: ["camera online"] } })],
        contextSelection: { systemContent: "microphone online", messages: [] }
    }).items[0];
    assert.equal(contextual.relevant, false);
    assert.equal(contextual.available, true);

    const available = capabilityRuntime("device.camera", "AVAILABLE");
    const unavailable = capabilityRuntime("device.camera", "UNAVAILABLE");
    const source = tool("camera_capture", { capabilityId: "device.camera" });
    const unavailableView = Integration.project({
        tools: [source],
        capabilityRegistry: unavailable.registry,
        contextSelection: { systemContent: "camera online", messages: [] }
    }).items[0];
    const availableView = Integration.project({
        tools: [source],
        capabilityRegistry: available.registry,
        contextSelection: { systemContent: "camera online", messages: [] }
    }).items[0];
    assert.equal(unavailableView.relevant, true);
    assert.equal(unavailableView.available, false);
    assert.equal(availableView.available, true);
});

test("unknown and unregistered capability state is not silently executable", () => {
    const unknown = capabilityRuntime("device.camera");
    const source = tool("camera_capture", { capabilityId: "device.camera" });
    const unknownView = Integration.project({ tools: [source], capabilityRegistry: unknown.registry }).items[0];
    const missingView = Integration.project({
        tools: [source],
        capabilityRegistry: capabilityRuntime("device.other", "AVAILABLE").registry
    }).items[0];
    assert.equal(unknownView.availability, "UNKNOWN");
    assert.equal(unknownView.runtimeReachable, false);
    assert.equal(unknownView.available, false);
    assert.equal(missingView.registered, false);
    assert.equal(missingView.available, false);
});

test("multiple registries project without creating a second authority or registry", () => {
    const left = capabilityRuntime("device.camera", "AVAILABLE");
    const right = capabilityRuntime("provider.vision", "AVAILABLE");
    const view = Integration.project({
        tools: [tool("vision_camera", { capabilityIds: ["device.camera", "provider.vision"] })],
        capabilityRegistry: {
            get(id) { return left.registry.get(id) ?? right.registry.get(id); },
            resolveDependencyStatus(id) { return left.registry.has(id)
                ? left.registry.resolveDependencyStatus(id)
                : right.registry.resolveDependencyStatus(id); }
        }
    });
    assert.deepEqual(view.items[0].capabilityIds, ["device.camera", "provider.vision"]);
    assert.equal(view.items[0].available, true);
    assert.equal(view.authorityGranted, false);
});
