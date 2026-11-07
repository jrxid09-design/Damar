"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const Authorization = require("../../src/ai/tools/Authorization");
const InternalGrant = require("../../src/ai/tools/internalGrant").createInternalGrantDomain();
const loopGuard = require("../../src/core/safety/loopGuard");

const toolCall = name => ({ id: `call-${name}`, name, arguments: {} });

function registry(counter) {
    return {
        get(name) {
            if (name !== "system__time__currentTime") return null;
            return {
                name,
                parameters: {},
                execute: async () => { counter.count++; return { now: 1 }; }
            };
        }
    };
}

test("RuntimeExecutor ignores unsolicited non-stream tool calls without trusted execution", async () => {
    for (const request of [
        { tools: [] },
        { tools: [toolCall("system__time__currentTime")] },
        { tools: [], exec: { toolExecutionAuthorized: true } }
    ]) {
        const counter = { count: 0 };
        const executor = new RuntimeExecutor({
            chat: async () => ({ content: "advisory", toolCalls: [toolCall("system__time__currentTime")] })
        }, { callTimeout: 1000, grantDomain: InternalGrant });
        executor.setToolRegistry(registry(counter));
        const result = await executor.execute({
            messages: [{ role: "user", content: "run it" }],
            role: "system",
            channel: "internal",
            ...request
        });
        assert.equal(counter.count, 0);
        assert.deepEqual(result.toolCalls, []);
    }
});

test("RuntimeExecutor streaming ignores unsolicited tool calls without trusted execution", async () => {
    const counter = { count: 0 };
    const executor = new RuntimeExecutor({
        stream: async function* () {
            yield { toolCalls: [toolCall("system__time__currentTime")], finishReason: "tool_calls", done: true };
        }
    }, { callTimeout: 1000, grantDomain: InternalGrant });
    executor.setToolRegistry(registry(counter));
    const chunks = [];
    for await (const chunk of executor.stream({
        messages: [{ role: "user", content: "run it" }],
        tools: [],
        role: "system",
        channel: "internal"
    })) chunks.push(chunk);
    assert.equal(counter.count, 0);
    assert.equal(chunks.some(chunk => chunk.toolCalls?.length), false);
    assert.equal(chunks.at(-1).done, true);
});

test("RuntimeExecutor permits a tool only with canonical internal grant provenance", async () => {
    const counter = { count: 0 };
    const executor = new RuntimeExecutor({
        chat: async request => request.messages.some(message => message.role === "tool")
            ? { content: "done", toolCalls: [] }
            : { content: "", toolCalls: [toolCall("system__time__currentTime")] }
    }, { callTimeout: 1000, grantDomain: InternalGrant });
    executor.setToolRegistry(registry(counter));
    const grant = InternalGrant.mintCanonicalInternalGrant({
        authorizedTools: ["system__time__currentTime"],
        provenance: "runtime-test"
    });
    const result = await executor.execute({
        messages: [{ role: "user", content: "run it" }],
        tools: [toolCall("system__time__currentTime")],
        exec: grant
    });
    assert.equal(counter.count, 1);
    assert.deepEqual(result.toolCalls, []);
});

test("grant provenance is identity-based and scope is immutable", async () => {
    const sourceScope = ["tool-A"];
    const grant = InternalGrant.mintCanonicalInternalGrant({
        authorizedTools: sourceScope, provenance: "scope-test"
    });
    sourceScope.push("tool-B");
    assert.equal(Object.isFrozen(grant), true);
    assert.equal(InternalGrant.isCanonicalInternalGrant(grant), true);
    for (const copy of [
        { ...grant },
        Object.assign({}, grant),
        Object.create(grant),
        JSON.parse(JSON.stringify(grant)),
        { authorizedTools: ["tool-A"] }
    ]) assert.equal(InternalGrant.isCanonicalInternalGrant(copy), false);
    const traps = { get: 0 };
    const proxy = new Proxy(grant, { get() { traps.get++; return true; } });
    assert.equal(InternalGrant.isCanonicalInternalGrant(proxy), false);
    assert.equal(traps.get, 0);
    assert.equal(InternalGrant.isToolAuthorizedByGrant(grant, "tool-A"), true);
    assert.equal(InternalGrant.isToolAuthorizedByGrant(grant, "tool-B"), false);
    assert.throws(() => { grant.authorizedTools.push("tool-B"); }, TypeError);
});

async function runScoped(scope, returnedNames, stream = false) {
    loopGuard.resetAll();
    const counters = { A: 0, B: 0 };
    const registry = {
        get(name) {
            if (!/^tool-[AB]$/.test(name)) return null;
            return { name, parameters: {}, execute: async () => { counters[name.slice(-1)]++; return { ok: true }; } };
        }
    };
    const responses = returnedNames.map(name => toolCall(name));
    let streamed = false;
    const service = stream
        ? { stream: async function* () {
            if (!streamed) {
                streamed = true;
                yield { toolCalls: responses, done: true, finishReason: "tool_calls" };
            } else {
                yield { content: "done", toolCalls: [], done: true, finishReason: "stop" };
            }
        } }
        : { chat: async request => request.messages.some(m => m.role === "tool")
            ? { content: "done", toolCalls: [] }
            : { content: "", toolCalls: responses } };
    const executor = new RuntimeExecutor(service, { callTimeout: 1000, grantDomain: InternalGrant });
    executor.setToolRegistry(registry);
    const request = {
        messages: [{ role: "user", content: "run" }],
        tools: returnedNames.map(name => toolCall(name)),
        exec: InternalGrant.mintCanonicalInternalGrant({ authorizedTools: scope })
    };
    if (stream) {
        const chunks = [];
        for await (const chunk of executor.stream(request)) chunks.push(chunk);
        loopGuard.resetAll();
        return { counters, chunks };
    }
    const result = await executor.execute(request);
    loopGuard.resetAll();
    return { counters, result };
}

test("empty and substituted scopes fail closed, positive scope executes exactly once", async () => {
    assert.deepEqual((await runScoped([], ["tool-A"])).counters, { A: 0, B: 0 });
    assert.deepEqual((await runScoped(["tool-A"], ["tool-B"])).counters, { A: 0, B: 0 });
    assert.deepEqual((await runScoped(["tool-A"], ["tool-A"])).counters, { A: 1, B: 0 });
    assert.deepEqual((await runScoped(["tool-A"], ["tool-A", "tool-B"])).counters, { A: 0, B: 0 });
});

test("streaming applies the same grant and exact-batch scope policy", async () => {
    for (const [scope, names] of [[[], ["tool-A"]], [["tool-A"], ["tool-B"]], [["tool-A"], ["tool-A"]], [["tool-A"], ["tool-A", "tool-B"]]]) {
        const outcome = await runScoped(scope, names, true);
        const positive = scope.length === 1 && names.length === 1 && names[0] === "tool-A";
        assert.deepEqual(outcome.counters, { A: positive ? 1 : 0, B: 0 });
        assert.equal(outcome.chunks.some(chunk => chunk.toolCalls?.length), positive);
    }
});

test("public boolean delegation metadata cannot mint an execution grant", () => {
    const candidate = Authorization.resolveDelegator(null, true, "attacker");
    assert.equal(Authorization.isCanonicalInternalGrant(candidate), false);
    assert.equal(Authorization.isToolAuthorizedByGrant(candidate, "tool-A"), false);
});

test("caller-selected grant domain cannot bind the production registry", () => {
    const attackerDomain = require("../../src/ai/tools/internalGrant")
        .createInternalGrantDomain();
    const executor = new RuntimeExecutor({ chat: async () => ({ toolCalls: [] }) }, {
        grantDomain: attackerDomain
    });
    const { AIToolRegistry } = require("../../src/ai/tools");
    assert.throws(() => executor.setToolRegistry(new AIToolRegistry()), /production registry/);
});

test("registry binding is immutable after first bootstrap binding", () => {
    const executor = new RuntimeExecutor({ chat: async () => ({ toolCalls: [] }) });
    executor.setToolRegistry({ get: () => null });
    assert.throws(() => executor.setToolRegistry({ get: () => null }), /already bound/);
});
