"use strict";

const SCHEMA_VERSION = "governed.v1";

/**
 * off      -> zero cognition influence anywhere; the only mode with no
 *             runtime footprint at all.
 * shadow   -> cognition observes/evaluates, decisionInfluence is always
 *             false; no consumer may treat shadow output as advisory.
 * governed -> cognition MAY emit a GovernedCognitiveProjection,
 *             decisionInfluence "ADVISORY_ONLY" -- never authority.
 *
 * Single source of truth (FG-03): every mode-bearing lane (today:
 * longhorizon/bounds.js; future: L2/L4/L6) imports MODES from here instead
 * of declaring its own copy.
 */
const MODES = Object.freeze(["off", "shadow", "governed"]);

module.exports = { SCHEMA_VERSION, MODES };
