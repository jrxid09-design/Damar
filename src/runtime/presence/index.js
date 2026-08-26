/**
 * Presence Runtime V0 — pintu masuk publik.
 *
 * Presence lifecycle kanon Aether: apa state entitas yang berjalan,
 * mengapa demikian, dan transisi apa yang legal. Lihat
 * docs/architecture/PRESENCE-RUNTIME-V0.md.
 */

const states = require("./states");
const config = require("./config");
const clock = require("./clock");
const identity = require("./identity");
const { PresenceRuntime, DECISION_CODES, createPresenceRuntime } = require("./presenceRuntime");
const ports = require("./ports");
const { ActivityToken, isGenuineActivityToken } = require("./activityToken");

module.exports = {
    createPresenceRuntime,
    PresenceRuntime,
    DECISION_CODES,
    LIFECYCLE: states.LIFECYCLE,
    ACTIVITY_MODE: states.ACTIVITY_MODE,
    ACTIVITY_PRESENTATION_PRECEDENCE: states.ACTIVITY_PRESENTATION_PRECEDENCE,
    DEGRADED_REASON: states.DEGRADED_REASON,
    HEALTH: states.HEALTH,
    RESOURCE_PRESSURE_LEVEL: states.RESOURCE_PRESSURE_LEVEL,
    CAUSE: states.CAUSE,
    TRANSITIONS: states.TRANSITIONS,
    FACT_TYPE: states.FACT_TYPE,
    HOST_EVENT: states.HOST_EVENT,
    DEFAULT_PRESENCE_CONFIG: config.DEFAULT_PRESENCE_CONFIG,
    validatePresenceConfig: config.validatePresenceConfig,
    createSystemClock: clock.createSystemClock,
    createManualClock: clock.createManualClock,
    PRODUCER_KIND: identity.PRODUCER_KIND,
    registerProducer: identity.registerProducer,
    isGenuineProducer: identity.isGenuineProducer,
    ActivityToken,
    isGenuineActivityToken,
    ports
};
