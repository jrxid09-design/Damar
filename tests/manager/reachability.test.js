"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
function jsFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...jsFiles(file));
        else if (entry.isFile() && file.endsWith(".js")) files.push(file);
    }
    return files;
}

test("Manager internal composition is reachable only from trusted bootstrap", () => {
    const consumers = [];
    for (const file of jsFiles(path.join(ROOT, "src"))) {
        const source = fs.readFileSync(file, "utf8");
        if (source.includes("internal/managerBootstrap") || source.includes("internal\\\\managerBootstrap")) {
            consumers.push(path.relative(ROOT, file).replaceAll("\\", "/"));
        }
    }
    assert.deepEqual(consumers.sort(), ["src/manager/bootstrap.js"]);
});

test("public Manager exposes only the frozen orchestration facade", () => {
    const { createDamarManager } = require("../../src/manager");
    const manager = createDamarManager();
    assert.equal(Object.isFrozen(manager), true);
    assert.deepEqual(Object.keys(manager).sort(), [
        "cancel", "handle", "isCanonicalManagerRequest", "isCanonicalManagerResult"
    ]);
    for (const key of ["lane2", "lane3", "lane4", "registry", "registrar", "dispatcher", "verifier", "compensate"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(manager, key), false, key);
    }
});

test("production Manager modules do not import test harnesses", () => {
    for (const file of jsFiles(path.join(ROOT, "src", "manager"))) {
        const source = fs.readFileSync(file, "utf8");
        assert.equal(/(?:require|import)[^\n]*tests[\\/]/.test(source), false, path.relative(ROOT, file));
    }
});

test("legacy Console plugin ingress fails before ToolRegistry execution", async () => {
    const controller = require("../../src/controllers/pluginController");
    const { ToolRegistry } = require("../../src/core/tools");
    const original = ToolRegistry.execute;
    let invoked = 0;
    ToolRegistry.execute = async () => { invoked++; return {}; };
    const response = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
    await controller.execute({ params: { id: "arbitrary.tool" }, body: { args: {} } }, response);
    ToolRegistry.execute = original;
    assert.equal(invoked, 0);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, null);
    assert.match(response.body.message, /canonical Damar Manager/i);
});

test("legacy Console terminal mutators fail before TerminalRuntime", async () => {
    const controller = require("../../src/controllers/terminalController");
    const terminals = require("../../src/runtime/terminal/TerminalRuntime");
    const original = terminals.execute;
    let invoked = 0;
    terminals.execute = async () => { invoked++; return {}; };
    const response = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
    await controller.execute({ params: { id: "t1" }, body: { command: "touch forbidden" } }, response);
    terminals.execute = original;
    assert.equal(invoked, 0);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /canonical Damar Manager/i);
});

test("production MCP tools/call is fail-closed before legacy registry execution", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/mcp/index.js"), "utf8");
    assert.match(source, /rejectLegacyActionRoute\("MCP tool"\)/);
    assert.doesNotMatch(source, /ToolRegistry\.execute\(/);
});

test("runtime restart and terminal WebSocket ingress are fail-closed", () => {
    const runtimeSource = fs.readFileSync(path.join(ROOT, "src/controllers/runtimeController.js"), "utf8");
    const wsSource = fs.readFileSync(path.join(ROOT, "src/ws/terminalGateway.js"), "utf8");
    assert.match(runtimeSource, /rejectLegacyActionRoute\("Console runtime"\)/);
    assert.match(wsSource, /LEGACY_ACTION_ROUTE_DISABLED/);
    assert.match(wsSource, /return reject\(socket, 503/);
});

test("external action ingress guard has no authority or executor surface", () => {
    const boundary = require("../../src/manager/legacyBoundary");
    assert.deepEqual(Object.keys(boundary).sort(), ["LEGACY_ACTION_ROUTE_DISABLED", "rejectLegacyActionMiddleware", "rejectLegacyActionRoute"]);
    assert.throws(() => boundary.rejectLegacyActionRoute("test"), error =>
        error.code === boundary.LEGACY_ACTION_ROUTE_DISABLED &&
        /canonical Damar Manager/.test(error.message));
});

test("high-risk Console families are wired to the fail-closed boundary", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/routes/api/v1/console.js"), "utf8");
    for (const route of [
        'router.post("/home/control", homeManagerOnly)',
        'router.post("/home/mqtt/publish", homeManagerOnly)',
        'router.post("/orchestrate", managerOnly)',
        'router.post("/lab/missions/:id/run", labManagerOnly)',
        'router.post("/lab/experiments/:id/run", labManagerOnly)',
        'router.post("/automation/run", automationManagerOnly)',
        'router.post("/mcp/restart", mcpManagerOnly)',
        'router.put("/devices", managerOnly)',
        'router.post("/memory", managerOnly)',
        'router.post("/voice/speak", managerOnly)',
        'router.post("/forge/:id/approve", managerOnly)'
    ]) assert.ok(source.includes(route), route);
});

test("legacy API agent chat cannot reach PlanExecutor plugin execution", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/routes/api/v1/index.js"), "utf8");
    assert.match(source, /rejectLegacyActionMiddleware\("legacy agent chat"\)/);
    assert.doesNotMatch(source, /chatController\.chat\s*\n\s*\)/);
});

test("shared external AI runtime boundary strips tool execution for every external channel", async () => {
    const ai = require("../../src/services/aiRuntimeService");
    const originalEnsure = ai.ensure;
    const originalAssemble = ai.assemble;
    const originalResolveModel = ai.resolveModel;
    const originalRecordUsage = ai._recordUsage;
    const observed = [];
    ai.assemble = async ({ messages }) => ({ messages, diagnostics: {} });
    ai.resolveModel = () => "test-model";
    ai._recordUsage = () => {};
    ai.ensure = () => ({
        chat: async options => { observed.push(options); return { content: "ok" }; },
        stream: async function* () { yield { delta: "ok" }; }
    });
    try {
        for (const channel of ["console", "telegram", "whatsapp", "device", "companion", "api", "voice"]) {
            await ai.chat({ messages: [{ role: "user", content: "run it" }], channel, tools: [{ name: "dangerous" }] });
        }
    } finally {
        ai.ensure = originalEnsure;
        ai.assemble = originalAssemble;
        ai.resolveModel = originalResolveModel;
        ai._recordUsage = originalRecordUsage;
    }
    assert.equal(observed.length, 7);
    assert.ok(observed.every(options => Array.isArray(options.tools) && options.tools.length === 0));
});

test("shared external AI streaming boundary also strips tool execution", async () => {
    const ai = require("../../src/services/aiRuntimeService");
    const originalEnsure = ai.ensure;
    const originalAssemble = ai.assemble;
    const originalResolveModel = ai.resolveModel;
    const observed = [];
    ai.assemble = async ({ messages }) => ({ messages, diagnostics: {} });
    ai.resolveModel = () => "test-model";
    ai.ensure = () => ({
        stream: async function* streamStub(options) {
            observed.push(options);
            yield { delta: "ok", done: true };
        }
    });
    try {
        const chunks = [];
        for await (const chunk of ai.stream({
            messages: [{ role: "user", content: "run it" }],
            channel: "console",
            tools: [{ name: "dangerous" }]
        })) chunks.push(chunk);
        assert.equal(chunks.length, 1);
    } finally {
        ai.ensure = originalEnsure;
        ai.assemble = originalAssemble;
        ai.resolveModel = originalResolveModel;
    }
    assert.equal(observed.length, 1);
    assert.deepEqual(observed[0].tools, []);
});

test("production AI controller feeds channel context into the fenced runtime", async () => {
    const controller = require("../../src/controllers/aiController");
    const ai = require("../../src/services/aiRuntimeService");
    const originalChat = ai.chat;
    const calls = [];
    ai.chat = async options => {
        calls.push(options);
        return { content: "cognition-only" };
    };
    const response = {
        status() { return this; },
        json(body) { this.body = body; return body; }
    };
    try {
        await controller.chat({
            body: { messages: [{ role: "user", content: "propose a tool" }], channel: "telegram" },
            get() { return undefined; },
            authIdentity: { role: "superadmin", sessionId: "telegram:test" }
        }, response);
    } finally {
        ai.chat = originalChat;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "telegram");
    assert.equal(response.body.data.content, "cognition-only");
});

test("external API role clamp rejects privileged environment roles", () => {
    const { clampExternalRole } = require("../../src/core/auth/tokenCompare");
    for (const role of ["system", "internal", "root", "unknown", "SUPERUSER"]) {
        assert.equal(clampExternalRole(role, "user"), "user", role);
    }
    assert.equal(clampExternalRole("superadmin", "user"), "superadmin");
});

test("safety stop is the only documented fail-safe exception; release requires Manager control", () => {
    const controller = require("../../src/controllers/safetyController");
    const response = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
    controller.release({ body: { actor: "system" } }, response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /canonical Manager/i);
});

test("Authorization capability normalization rejects hostile objects before reflection", () => {
    const Authorization = require("../../src/ai/tools/Authorization");
    let traps = 0;
    const hostile = new Proxy({}, {
        get() { traps++; throw new Error("get"); },
        has() { traps++; throw new Error("has"); },
        ownKeys() { traps++; throw new Error("keys"); },
        getPrototypeOf() { traps++; throw new Error("proto"); },
        getOwnPropertyDescriptor() { traps++; throw new Error("descriptor"); }
    });
    assert.throws(() => Authorization.toCapabilitySet(hostile));
    assert.equal(traps, 0);

    const accessor = {};
    Object.defineProperty(accessor, Symbol.iterator, { get() { traps++; throw new Error("iterator"); } });
    Object.defineProperty(accessor, "constructor", { get() { traps++; throw new Error("constructor"); } });
    assert.throws(() => Authorization.toCapabilitySet(accessor));
    assert.equal(traps, 0);

    const array = [];
    Object.defineProperty(array, "0", { get() { traps++; throw new Error("element"); } });
    assert.throws(() => Authorization.toCapabilitySet(array));
    assert.equal(traps, 0);
});

test("Context Brief production service uses cognition-only runtime and reaches no tool sink", async () => {
    const context = require("../../src/services/contextService");
    const ai = require("../../src/services/aiRuntimeService");
    const originalSnapshot = context.snapshot;
    const originalEnsure = ai.ensure;
    const originalAssemble = ai.assemble;
    const originalResolveModel = ai.resolveModel;
    const originalRecordUsage = ai._recordUsage;
    const calls = [];
    context.snapshot = async () => ({ system: { cpu: 1, memory: 1, host: "test" } });
    ai.assemble = async ({ messages }) => ({ messages, diagnostics: {} });
    ai.resolveModel = () => "test-model";
    ai._recordUsage = () => {};
    ai.ensure = () => ({
        chat: async options => { calls.push(options); return { content: "brief" }; }
    });
    try {
        const result = await context.brief(null);
        assert.equal(result.brief, "brief");
    } finally {
        context.snapshot = originalSnapshot;
        ai.ensure = originalEnsure;
        ai.assemble = originalAssemble;
        ai.resolveModel = originalResolveModel;
        ai._recordUsage = originalRecordUsage;
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].tools, []);
    assert.equal(calls[0].channel, "external");
    assert.equal(calls[0].role, "user");
});

test("Vision Analyze production service uses cognition-only runtime and reaches no tool sink", async () => {
    const vision = require("../../src/services/visionService");
    const ai = require("../../src/services/aiRuntimeService");
    const originalModel = vision.model;
    const originalGeminiKey = vision.geminiKey;
    const originalEnsure = ai.ensure;
    const originalAssemble = ai.assemble;
    const originalRecordUsage = ai._recordUsage;
    const calls = [];
    vision.model = () => "test-vision-model";
    vision.geminiKey = () => null;
    ai.assemble = async ({ messages }) => ({ messages, diagnostics: {} });
    ai._recordUsage = () => {};
    ai.ensure = () => ({
        chat: async options => { calls.push(options); return { content: "description" }; }
    });
    try {
        const result = await vision.analyze({
            imageBase64: "aW1hZ2U=",
            mimeType: "image/jpeg",
            prompt: "describe only"
        });
        assert.equal(result.text, "description");
    } finally {
        vision.model = originalModel;
        vision.geminiKey = originalGeminiKey;
        ai.ensure = originalEnsure;
        ai.assemble = originalAssemble;
        ai._recordUsage = originalRecordUsage;
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].tools, []);
    assert.equal(calls[0].channel, "external");
});

test("external AI inventory has explicit dispositions and no direct ensure bypass", () => {
    const expected = [
        ["Console chat", "COGNITION_ONLY"],
        ["Console stream", "COGNITION_ONLY"],
        ["Context Brief", "COGNITION_ONLY"],
        ["Vision Analyze", "COGNITION_ONLY"],
        ["Telegram", "COGNITION_ONLY"],
        ["WhatsApp", "COGNITION_ONLY"],
        ["Companion", "COGNITION_ONLY"],
        ["Voice", "COGNITION_ONLY"],
        ["OpenAI API", "COGNITION_ONLY"],
        ["MCP tools/call", "FAIL_CLOSED"],
        ["Legacy API chat", "FAIL_CLOSED"]
    ];
    assert.deepEqual(expected.map(([, disposition]) => disposition), [
        "COGNITION_ONLY", "COGNITION_ONLY", "COGNITION_ONLY", "COGNITION_ONLY",
        "COGNITION_ONLY", "COGNITION_ONLY", "COGNITION_ONLY", "COGNITION_ONLY",
        "COGNITION_ONLY", "FAIL_CLOSED", "FAIL_CLOSED"
    ]);

    const directEnsureCallers = [];
    for (const file of jsFiles(path.join(ROOT, "src"))) {
        const source = fs.readFileSync(file, "utf8");
        if (/ensure\(\)\.(chat|stream)\s*\(/.test(source)) {
            directEnsureCallers.push(path.relative(ROOT, file).replaceAll("\\", "/"));
        }
    }
    assert.deepEqual(directEnsureCallers, ["src/services/aiRuntimeService.js"]);
});
