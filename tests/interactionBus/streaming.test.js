"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");
const { makeBus } = require("./helpers/busFactory");

function makeStream(boundsOverride) {
  let now = 500;
  const stream = new ib.InteractionStream({
    interactionId: "ix_stream",
    bounds: ib.resolveBounds(Object.assign({ maxStreamBufferEvents: 4 }, boundsOverride)),
    clock: () => (now += 1),
    onTransition: () => {}
  });
  return stream;
}

function collect(stream) {
  const events = [];
  stream.subscribe((event) => events.push(event));
  return events;
}

test("streaming: happy path emits ordered canonical events with monotonic seq", () => {
  const stream = makeStream();
  const events = collect(stream);
  stream.emit("START");
  stream.emit("DELTA", { text: "he" });
  stream.emit("DELTA", { text: "llo" });
  stream.emit("FINAL", { text: "hello" });
  stream.emit("COMPLETE");
  assert.deepEqual(
    events.map((e) => e.type),
    ["START", "DELTA", "DELTA", "FINAL", "COMPLETE"]
  );
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3, 4, 5]
  );
});

test("streaming: START may occur at most once", () => {
  const stream = makeStream();
  stream.emit("START");
  assert.throws(() => stream.emit("START"), /STREAM_INVALID_TRANSITION/);
});

test("streaming: DELTA requires an active started stream", () => {
  const stream = makeStream();
  assert.throws(() => stream.emit("DELTA", { text: "x" }), /STREAM_INVALID_TRANSITION/);
});

test("streaming: FINAL and COMPLETE enforce ordering", () => {
  const stream = makeStream();
  assert.throws(() => stream.emit("COMPLETE"), /STREAM_INVALID_TRANSITION/);
  assert.throws(() => stream.emit("FINAL"), /STREAM_INVALID_TRANSITION/);
  stream.emit("START");
  stream.emit("FINAL");
  assert.throws(() => stream.emit("DELTA", { text: "late" }), /STREAM_INVALID_TRANSITION/);
  stream.emit("COMPLETE");
});

test("streaming: second FINAL is rejected", () => {
  const stream = makeStream();
  stream.emit("START");
  stream.emit("FINAL");
  assert.throws(() => stream.emit("FINAL"), /STREAM_INVALID_TRANSITION/);
});

test("streaming: ERROR is terminal and may occur at most once", () => {
  const stream = makeStream();
  stream.emit("START");
  stream.emit("ERROR", { reason: "boom" });
  assert.equal(stream.terminal, true);
  assert.equal(stream.state, "failed");
  for (const type of ["DELTA", "FINAL", "COMPLETE", "ERROR"]) {
    assert.throws(() => stream.emit(type), /STREAM_INVALID_TRANSITION|terminal/, type);
  }
});

test("streaming: no events of any kind after COMPLETE terminal state", () => {
  const stream = makeStream();
  stream.emit("START");
  stream.emit("FINAL");
  stream.emit("COMPLETE");
  assert.equal(stream.terminal, true);
  for (const type of ["START", "DELTA", "STATUS", "APPROVAL_REQUIRED", "FINAL", "ERROR", "COMPLETE"]) {
    assert.throws(() => stream.emit(type), /STREAM_INVALID_TRANSITION|terminal/, type);
  }
});

test("streaming: unknown event types are closed-enum rejected", () => {
  const stream = makeStream();
  assert.throws(() => stream.emit("EXPLODE"), /INVALID_ENUM/);
  assert.throws(() => stream.emit("start"), /INVALID_ENUM/);
});

test("streaming: emitted events are frozen immutable records", () => {
  const stream = makeStream();
  const events = collect(stream);
  stream.emit("START");
  assert.equal(Object.isFrozen(events[0]), true);
  assert.throws(() => {
    "use strict";
    events[0].type = "MUTATED";
  });
});

test("streaming: oversized event data rejects deterministically", () => {
  const stream = makeStream({ maxPayloadBytes: 64 });
  stream.emit("START");
  assert.throws(() => stream.emit("DELTA", { text: "x".repeat(1024) }), /BOUNDS_EXCEEDED/);
});

test("streaming: paused subscriber buffers bounded then drains in order on resume", () => {
  const stream = makeStream({ maxStreamBufferEvents: 8 });
  const received = [];
  const sub = stream.subscribe((event) => received.push(event.type));
  sub.pause();
  stream.emit("START");
  stream.emit("DELTA", { text: "a" });
  stream.emit("FINAL");
  assert.equal(received.length, 0);
  assert.ok(stream.snapshot().buffered <= 8);
  sub.resume();
  assert.deepEqual(received, ["START", "DELTA", "FINAL"]);
});

test("streaming: slow consumer overflow fails the stream instead of growing memory", () => {
  const stream = makeStream({ maxStreamBufferEvents: 2 });
  const received = [];
  const sub = stream.subscribe((event) => received.push(event));
  sub.pause();
  stream.emit("START");
  stream.emit("DELTA", { text: "1" });
  stream.emit("DELTA", { text: "2-overflows" });
  assert.equal(stream.terminal, true);
  assert.throws(() => stream.emit("DELTA", { text: "3-after-terminal" }), /STREAM_INVALID_TRANSITION/);
  assert.equal(received[received.length - 1].data.reason, "STREAM_BUFFER_OVERFLOW");
  const overflowCount = received.filter((e) => e.data && e.data.reason === "STREAM_BUFFER_OVERFLOW").length;
  assert.equal(overflowCount, 1);
});

test("streaming: throwing subscriber cannot corrupt stream state nor other subscribers", () => {
  const stream = makeStream();
  const goodReceived = [];
  stream.subscribe(() => {
    throw new Error("subscriber exploded");
  });
  stream.subscribe((event) => goodReceived.push(event.type));
  assert.doesNotThrow(() => stream.emit("START"));
  stream.emit("FINAL");
  stream.emit("COMPLETE");
  assert.deepEqual(goodReceived, ["START", "FINAL", "COMPLETE"]);
  assert.equal(stream.state, "completed");
});

test("streaming: cancellation notification only affects non-terminal streams once", () => {
  const stream = makeStream();
  const events = collect(stream);
  assert.throws(() => stream.emit("STATUS"), /STREAM_INVALID_TRANSITION/);
  stream.emit("START");
  assert.equal(stream.notifyCancellationRequested(), true);
  assert.equal(stream.cancelRequested, true);
  assert.equal(events[events.length - 1].type, "STATUS");
  assert.deepEqual(events[events.length - 1].data, { cancelRequested: true });
  stream.emit("FINAL");
  stream.emit("COMPLETE");
  assert.equal(stream.notifyCancellationRequested(), false);
});

test("streaming: stale generation payloads reject on the interaction stream", () => {
  let now = 0;
  const stream = new ib.InteractionStream({
    interactionId: "ix_gen",
    bounds: ib.resolveBounds(),
    clock: () => (now += 1),
    expectedGeneration: "gen_7",
    onTransition: () => {}
  });
  stream.emit("START");
  assert.doesNotThrow(() => stream.emit("FINAL", { text: "ok", generation: "gen_7" }));
  const stream2 = new ib.InteractionStream({
    interactionId: "ix_gen2",
    bounds: ib.resolveBounds(),
    clock: () => (now += 1),
    expectedGeneration: "gen_7",
    onTransition: () => {}
  });
  stream2.emit("START");
  assert.throws(
    () => stream2.emit("FINAL", { text: "stale", generation: "gen_old" }),
    /STALE_GENERATION/
  );
});
