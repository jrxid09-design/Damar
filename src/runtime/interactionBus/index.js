"use strict";

const { createInteractionBus } = require("./interactionBus");
const { DEFAULT_BOUNDS, resolveBounds } = require("./config");
const ids = require("./ids");
const enums = require("./enums");
const payloads = require("./payloads");
const envelope = require("./envelope");
const streams = require("./streams");
const sessions = require("./sessions");
const routing = require("./routing");
const transportsMod = require("./transports");
const futureTransports = require("./futureTransports");
const managerIngress = require("./managerIngress");
const mediaIngress = require("../mediaIngress");

function createSystemClock() {
  return function systemClock() {
    return Date.now();
  };
}

function createProductionBus(options) {
  void options;
  throw new TypeError("production bus is owned by createRuntimeHost");
}

module.exports = {
  createInteractionBus,
  createProductionBus,
  createSystemClock,
  DEFAULT_BOUNDS,
  resolveBounds,
  ...ids,
  ...enums,
  ...payloads,
  ...envelope,
  InteractionStream: streams.InteractionStream,
  createSessionRegistry: sessions.createSessionRegistry,
  createHandlerRegistry: routing.createHandlerRegistry,
  routeForKind: routing.routeForKind,
  KIND_TO_ROUTE: routing.KIND_TO_ROUTE,
  createTransportRegistry: transportsMod.createTransportRegistry,
  CAPABILITY_NAMES: transportsMod.CAPABILITY_NAMES,
  KIND_CAPABILITY_REQUIREMENTS: transportsMod.KIND_CAPABILITY_REQUIREMENTS,
  futureTransports,
  ...managerIngress,
  ...mediaIngress
};
