"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");

function makeBus() {
  const bus = ib.createInteractionBus({
    clock: () => 1000,
    idFactory: ib.createSequentialIdFactory()
  });
  bus.registerTransport({
    transportId: "hostile.test",
    origin: "TEST",
    capabilities: { acceptsText: true }
  });
  return bus;
}

function base(overrides) {
  return {
    transportId: "hostile.test",
    sessionId: "ses_hostile",
    kind: "MESSAGE",
    payload: { text: "safe" },
    ...(overrides || {})
  };
}

test("metadata own getter is rejected without executing it", () => {
  const bus = makeBus();
  let getterCalls = 0;
  const metadata = {};
  Object.defineProperty(metadata, "x", {
    enumerable: true,
    get() { getterCalls += 1; return "trap"; }
  });
  const result = bus.submit(base({ metadata }));
  assert.equal(result.accepted, false);
  assert.equal(getterCalls, 0);
});

test("nested metadata Proxy is rejected without invoking traps", () => {
  const bus = makeBus();
  let trapCalls = 0;
  const metadata = new Proxy({ x: "trap" }, {
    get() { trapCalls += 1; throw new Error("get"); },
    ownKeys() { trapCalls += 1; throw new Error("ownKeys"); },
    getPrototypeOf() { trapCalls += 1; throw new Error("proto"); }
  });
  const result = bus.submit(base({ metadata }));
  assert.equal(result.accepted, false);
  assert.equal(trapCalls, 0);
});

test("attachment accessors and Proxies are rejected before field reads", () => {
  const bus = makeBus();
  let getterCalls = 0;
  const attachment = {};
  Object.defineProperty(attachment, "name", {
    enumerable: true,
    get() { getterCalls += 1; return "trap.txt"; }
  });
  const accessorResult = bus.submit(base({ payload: { text: "x", attachments: [attachment] } }));
  assert.equal(accessorResult.accepted, false);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxy = new Proxy({ name: "trap.txt" }, {
    ownKeys() { proxyTraps += 1; throw new Error("ownKeys"); },
    get() { proxyTraps += 1; throw new Error("get"); }
  });
  const proxyResult = bus.submit(base({ payload: { text: "x", attachments: [proxy] } }));
  assert.equal(proxyResult.accepted, false);
  assert.equal(proxyTraps, 0);
});

test("hostile arrays and iterator hooks are rejected without iteration", () => {
  const bus = makeBus();
  let getterCalls = 0;
  const references = [];
  Object.defineProperty(references, "0", {
    enumerable: true,
    get() { getterCalls += 1; return "ix_bad"; }
  });
  const result = bus.submit(base({ payload: { text: "x", referenceIds: references } }));
  assert.equal(result.accepted, false);
  assert.equal(getterCalls, 0);

  let iteratorCalls = 0;
  const hostileArray = new Proxy([], {
    get(target, key) {
      if (key === Symbol.iterator) iteratorCalls += 1;
      throw new Error("array trap");
    }
  });
  const proxyResult = bus.submit(base({ payload: { text: "x", referenceIds: hostileArray } }));
  assert.equal(proxyResult.accepted, false);
  assert.equal(iteratorCalls, 0);
});

test("object-valued session and reply/reference identifiers fail without coercion", () => {
  const bus = makeBus();
  let coercions = 0;
  const hostileId = {
    toString() { coercions += 1; throw new Error("coercion"); },
    valueOf() { coercions += 1; throw new Error("coercion"); }
  };
  const sessionResult = bus.submit(base({ sessionId: hostileId }));
  assert.equal(sessionResult.accepted, false);
  const replyResult = bus.submit(base({ payload: { text: "x", replyToInteractionId: hostileId } }));
  assert.equal(replyResult.accepted, false);
  assert.equal(coercions, 0);
});

test("context accessors and malformed nested reference records fail closed", () => {
  const bus = makeBus();
  let getterCalls = 0;
  const context = {};
  Object.defineProperty(context, "ref", {
    enumerable: true,
    get() { getterCalls += 1; return "ref"; }
  });
  const contextResult = bus.submit(base({ contextRefs: [{ type: "doc", ref: context }] }));
  assert.equal(contextResult.accepted, false);
  assert.equal(getterCalls, 0);
});

test("envelope reference arrays use zero-trap descriptor copying for both fields", () => {
  const fields = ["contextRefs", "authEvidenceRefs"];
  for (const field of fields) {
    const bus = makeBus();
    const valid = field === "contextRefs"
      ? [{ type: "doc", ref: "ref-1" }]
      : [{ provider: "totp_provider", evidenceId: "evd_1", issuedAt: 1, expiresAt: 2 }];
    const makeSpec = (value) => ({ [field]: value });

    let proxyTraps = 0;
    const proxy = new Proxy([], {
      get() { proxyTraps += 1; throw new Error("proxy get"); },
      ownKeys() { proxyTraps += 1; throw new Error("proxy keys"); }
    });
    assert.equal(bus.submit(base(makeSpec(proxy))).accepted, false);
    assert.equal(proxyTraps, 0, field);

    let getterCalls = 0;
    const accessorArray = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() { getterCalls += 1; return valid[0]; }
    });
    assert.equal(bus.submit(base(makeSpec(accessorArray))).accepted, false);
    assert.equal(getterCalls, 0, field);

    let mapCalls = 0;
    const customMap = valid.slice();
    Object.defineProperty(customMap, "map", {
      enumerable: true,
      value() { mapCalls += 1; throw new Error("custom map"); }
    });
    const mapResult = bus.submit(base(makeSpec(customMap)));
    assert.equal(mapResult.accepted, true, field);
    assert.equal(mapCalls, 0, field);

    const sparse = [];
    sparse.length = 1;
    assert.equal(bus.submit(base(makeSpec(sparse))).accepted, false);

    const wrongPrototype = valid.slice();
    Object.setPrototypeOf(wrongPrototype, { custom: true });
    assert.equal(bus.submit(base(makeSpec(wrongPrototype))).accepted, false);
  }
});

test("valid envelope reference arrays are detached and frozen", () => {
  const bus = makeBus();
  const seen = [];
  bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (envelope, context) => {
      seen.push(envelope);
      context.stream.emit("START");
      context.stream.emit("COMPLETE");
    }
  });
  const contextRefs = [{ type: "doc", ref: "ref-1" }];
  const authEvidenceRefs = [{ provider: "totp_provider", evidenceId: "evd_1", issuedAt: 1, expiresAt: 2 }];
  assert.equal(bus.submit(base({ payload: { text: "x" }, contextRefs, authEvidenceRefs })).accepted, true);
  contextRefs[0].ref = "changed";
  authEvidenceRefs[0].expiresAt = 999;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].contextRefs[0].ref, "ref-1");
  assert.equal(seen[0].authEvidenceRefs[0].expiresAt, 2);
  assert.equal(Object.isFrozen(seen[0].contextRefs), true);
  assert.equal(Object.isFrozen(seen[0].authEvidenceRefs), true);
});

test("direct hostile submit rejects before transport property observation", () => {
  const bus = makeBus();
  let trapCalls = 0;
  const request = new Proxy({}, {
    get() { trapCalls += 1; throw new Error("request get"); },
    ownKeys() { trapCalls += 1; throw new Error("request keys"); },
    getPrototypeOf() { trapCalls += 1; throw new Error("request proto"); }
  });
  const result = bus.submit(request);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "SUBMIT_INVALID");
  assert.equal(trapCalls, 0);
});

test("safe direct submit remains functional and canonical envelope is frozen", () => {
  const bus = makeBus();
  let seen = null;
  bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (envelope, context) => {
      seen = envelope;
      context.stream.emit("START");
      context.stream.emit("COMPLETE");
    }
  });
  const result = bus.submit(base({ payload: { text: "valid" } }));
  assert.equal(result.accepted, true);
  assert.equal(bus.isCanonicalEnvelope(seen), true);
  assert.equal(Object.isFrozen(seen), true);
});
