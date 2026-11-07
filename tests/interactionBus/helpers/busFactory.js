"use strict";

const ib = require("../../../src/runtime/interactionBus");

function makeBus(options) {
  const opts = options || {};
  let now = opts.now === undefined ? 1000 : opts.now;
  const clock = () => now;
  const ids = ib.createSequentialIdFactory();
  const bus = ib.createInteractionBus({
    clock,
    idFactory: ids,
    bounds: opts.bounds,
    handlerAmbiguityPolicy: opts.handlerAmbiguityPolicy
  });
  return {
    bus,
    ids,
    clock,
    advance: (ms) => {
      now += ms;
    },
    setNow: (value) => {
      now = value;
    }
  };
}

function textHandler(collector, options) {
  const opts = options || {};
  return function handler(envelope, ctx) {
    collector.push({ id: envelope.interactionId, session: envelope.sessionId });
    if (opts.deferred) {
      return new Promise((resolve) => {
        ctx.stream.subscribe((event) => {
          collector.push(`evt:${event.type}`);
          if (event.type === "COMPLETE") resolve();
        });
        if (opts.onStream) opts.onStream(ctx);
      });
    }
    ctx.stream.subscribe((event) => collector.push(`evt:${event.type}`));
    if (opts.onStream) opts.onStream(ctx);
    return undefined;
  };
}

module.exports = { makeBus, textHandler };
