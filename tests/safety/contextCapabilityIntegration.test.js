const test = require("node:test");
const assert = require("node:assert/strict");

const AITool = require("../../src/ai/tools/AITool");
const AIToolRegistry = require("../../src/ai/tools/AIToolRegistry");
const AIRuntime = require("../../src/ai/runtime/AIRuntime");
const AIBuilder = require("../../src/ai/builder/AIBuilder");
const RuntimeOptions = require("../../src/ai/runtime/RuntimeOptions");
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

function registerCapability(runtime, { id, dependencies = [] }) {
    const result = runtime.registrars.core.register(JSON.stringify({
        schemaVersion: 1,
        id,
        kind: "system",
        provider: "core",
        source: "core",
        operations: ["use"],
        requirements: [],
        effects: [],
        dependencies,
        description: id
    }));
    return result;
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
    assert.equal(contextual.available, "UNKNOWN");
    assert.equal(contextual.runtimeReachable, "UNKNOWN");
    assert.equal(contextual.executable, "UNKNOWN");

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
    assert.equal(unavailableView.runtimeReachable, false);
    assert.equal(unavailableView.executable, false);
    assert.equal(availableView.available, true);
    assert.equal(availableView.runtimeReachable, true);
    assert.equal(availableView.executable, true);
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
    assert.equal(unknownView.runtimeReachable, "UNKNOWN");
    assert.equal(unknownView.available, "UNKNOWN");
    assert.equal(unknownView.executable, "UNKNOWN");
    assert.equal(missingView.registered, false);
    assert.equal(missingView.available, false);
    assert.equal(missingView.runtimeReachable, false);
    assert.equal(missingView.executable, false);
});

test("unjoined AITool remains inspectable without becoming a ready capability", () => {
    const source = tool("unjoined_camera");
    const view = Integration.project({ tools: [source] });
    assert.equal(view.items[0].availability, "UNKNOWN");
    assert.equal(view.items[0].runtimeReachable, "UNKNOWN");
    assert.equal(view.items[0].executable, "UNKNOWN");
    assert.deepEqual(view.excluded, []);
    assert.deepEqual(view.candidates.map(item => item.name), ["unjoined_camera"]);
});

test("AIRuntime exposes corrected UNKNOWN projection to its runtime consumer", () => {
    const registry = new AIToolRegistry();
    registry.register(tool("currentWeather"));
    const runtime = new AIRuntime(null);
    runtime.setToolRegistry(registry);
    runtime.resolveTools({
        messages: [{ role: "user", content: "capture image" }],
        exec: { channel: "console", role: "user" },
        contextSelection: { systemContent: "camera online", messages: [], diagnostics: { itemsSelected: 1 } }
    });
    const item = runtime.lastContextCapabilityIntegration.items[0];
    assert.equal(item.available, "UNKNOWN");
    assert.equal(item.runtimeReachable, "UNKNOWN");
    assert.notEqual(item.executable, true);
});

test("production-like AIBuilder composition carries the canonical registry into resolveTools", () => {
    const capability = capabilityRuntime("device.camera", "AVAILABLE");
    const engine = new AIBuilder()
        .withCapabilityRegistry(capability.registry)
        .provider("llamacpp", {})
        .registerTool(tool("currentWeather", { capabilityId: "device.camera" }))
        .build();

    assert.equal(engine.runtime.options.capabilityRegistry, capability.registry);
    const request = {
        messages: [{ role: "user", content: "capture image" }],
        exec: { channel: "console", role: "user" }
    };
    assert.deepEqual(engine.runtime.resolveTools(request).map(item => item.name), ["currentWeather"]);
    assert.equal(engine.runtime.lastContextCapabilityIntegration.items[0].available, true);

    const record = capability.registry.get("device.camera");
    capability.registry.observeAvailability("device.camera", "UNAVAILABLE", {
        generation: record.generation + 1,
        incarnationId: record.incarnationId
    });
    assert.deepEqual(engine.runtime.resolveTools(request), []);
    assert.equal(engine.runtime.lastContextCapabilityIntegration.items[0].available, false);
});

test("V1 dependency truth changes the production-like model-facing candidate", () => {
    const capability = createCapabilityRuntime({ registrars: { core: true }, clock: { nowMs: () => 1000 } });
    registerCapability(capability, { id: "device.camera-dependency" });
    const parent = registerCapability(capability, {
        id: "device.camera-parent",
        dependencies: ["device.camera-dependency"]
    });
    capability.registry.observeAvailability("device.camera-parent", "AVAILABLE", {
        generation: 1,
        incarnationId: parent.incarnationId
    });

    const engine = new AIBuilder()
        .withCapabilityRegistry(capability.registry)
        .provider("llamacpp", {})
        .registerTool(tool("currentTime", { capabilityId: "device.camera-parent" }))
        .build();
    const request = { messages: [{ role: "user", content: "camera" }], exec: { channel: "console", role: "user" } };

    assert.deepEqual(engine.runtime.resolveTools(request), [], "unsatisfied dependency must not be ready");
    assert.equal(engine.runtime.lastContextCapabilityIntegration.items[0].dependencyStatus, "MISSING");

    const dependency = capability.registry.get("device.camera-dependency");
    capability.registry.observeAvailability("device.camera-dependency", "AVAILABLE", {
        generation: 1,
        incarnationId: dependency.incarnationId
    });
    assert.deepEqual(engine.runtime.resolveTools(request).map(item => item.name), ["currentTime"]);
    assert.equal(engine.runtime.lastContextCapabilityIntegration.items[0].dependencyStatus, "SATISFIED");
});

test("missing production registry remains distinguishable from an empty registry", () => {
    const missing = new RuntimeOptions();
    const empty = capabilityRuntime("unused").registry;
    const supplied = new RuntimeOptions({ capabilityRegistry: empty });
    assert.equal(missing.capabilityRegistry, null);
    assert.equal(supplied.capabilityRegistry, empty);
});

test("canonical context Pipeline remains the only runtime assembly owner", async () => {
    const service = require("../../src/services/aiRuntimeService");
    const previous = process.env.DAMAR_CONTEXT_PIPELINE;
    process.env.DAMAR_CONTEXT_PIPELINE = "legacy";
    try {
        const assembled = await service.assemble({
            messages: [{ role: "user", content: "hello" }],
            channel: "console"
        });
        assert.equal(assembled.diagnostics.mode, "pipeline");
    }
    finally {
        if (previous === undefined) delete process.env.DAMAR_CONTEXT_PIPELINE;
        else process.env.DAMAR_CONTEXT_PIPELINE = previous;
    }
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
    assert.equal(view.items[0].runtimeReachable, true);
    assert.equal(view.items[0].executable, true);
    assert.equal(view.authorityGranted, false);
});
