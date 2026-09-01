"use strict";

/**
 * DAMAR SESSION CONTINUITY — public package surface (Wave 5 Lane 4).
 *
 * Deliberately mirrors the mediaIngress discipline: the public index exposes
 * the inert vocabulary and the domain factory for the runtime composition
 * root, while nothing here can mint authority, register transports, call
 * models, or create a second Manager/bus domain.
 *
 *   SESSION != AUTHORITY
 *   CHANNEL != IDENTITY
 *   PERSISTED STATE != LIVE AUTHORITY
 */

const { createSessionContinuity, peerKeyFor, TERMINAL_INTERACTION_STATES, DEFAULT_BOUNDS } = require("./continuity");
const ids = require("./ids");
const persistence = require("./persistence");

module.exports = Object.freeze({
    createSessionContinuity,
    peerKeyFor,
    TERMINAL_INTERACTION_STATES,
    DEFAULT_BOUNDS,
    ...ids,
    ...persistence
});
