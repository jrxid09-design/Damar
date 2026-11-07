"use strict";

const { BusError } = require("./errors");

function inert(name) {
  return function notImplemented() {
    throw new BusError("NOT_IMPLEMENTED", `${name} is an inert future transport contract`);
  };
}

const LIFECYCLE_METHODS = Object.freeze([
  "register",
  "start",
  "emit",
  "respond",
  "disconnect",
  "stop"
]);

function createFutureTransport(className) {
  class FutureTransport {
    constructor(bus, descriptor) {
      if (!bus) {
        throw new BusError("BUS_REQUIRED", `${className} requires an InteractionBus instance`);
      }
      this.bus = bus;
      this.descriptor = descriptor === undefined ? null : descriptor;
      this.state = "UNREGISTERED";
    }
  }
  for (const method of LIFECYCLE_METHODS) {
    FutureTransport.prototype[method] = inert(`${className}.${method}`);
  }
  Object.freeze(FutureTransport.prototype);
  return Object.freeze(FutureTransport);
}

const VoiceTransport = createFutureTransport("VoiceTransport");
const TelegramTransport = createFutureTransport("TelegramTransport");
const ObservatoryTransport = createFutureTransport("ObservatoryTransport");
const PresenceTransport = createFutureTransport("PresenceTransport");
const HotkeyTransport = createFutureTransport("HotkeyTransport");

module.exports = {
  VoiceTransport,
  TelegramTransport,
  ObservatoryTransport,
  PresenceTransport,
  HotkeyTransport,
  LIFECYCLE_METHODS
};
