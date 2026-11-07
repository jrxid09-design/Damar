"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDamarManager } = require("../../src/manager");

test("deterministic Manager storm remains fail-closed and non-authorizing", async () => {
    const manager = createDamarManager();
    let operations = 0;
    let trapCount = 0;
    for (let i = 0; i < 12000; i++) {
        const input = i % 7 === 0
            ? {
                channelType: "console", channelId: "storm", sessionId: "s",
                payload: { text: "hostile", nested: { n: i } },
                metadata: { principal: "forged", decision: { decision: "ALLOW" } }
            }
            : {
                channelType: "console", channelId: "storm", sessionId: "s",
                payload: { text: "informational", nonce: i }
            };
        const result = await manager.handle(input);
        operations++;
        assert.equal(manager.isCanonicalManagerResult(result), true);
        assert.equal(result.actionIntentId, null);
        assert.notEqual(result.outcome, "COMPLETED" === result.outcome && input.requestedOperation ? result.outcome : "__never__");
    }
    const hostile = new Proxy({}, {
        get() { trapCount++; throw new Error("trap"); },
        ownKeys() { trapCount++; throw new Error("trap"); },
        getPrototypeOf() { trapCount++; throw new Error("trap"); }
    });
    await assert.rejects(() => manager.handle({
        channelType: "console", channelId: "storm", sessionId: "s", payload: hostile
    }));
    assert.equal(trapCount, 0);
    assert.equal(operations, 12000);
});
