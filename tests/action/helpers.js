"use strict";

/** Shared helpers for action intent + authority gate tests (SIXTH targeted
 *  repair: canonical bootstrap ownership — caller-selectable verifier removed).
 *
 *  This module now forwards to tests/action/bootstrapHarness.js, the trusted
 *  test bootstrap that mirrors src/action/bootstrap.js. All composition goes
 *  through the trusted harness: canonical state, the AuthenticationDomain,
 *  and the identity verifier are constructed INSIDE the harness closure; no
 *  test can supply a verifier, domain, runtime, or store to it.
 *
 *  (Kept as a separate file name because several suites require ./helpers;
 *  the historical in-file harness that composed runtimes through the removed
 *  public factories is gone.)
 */

const {
    manualClock,
    makeHarness,
    composeIsolatedTrustDomain,
    composeRuntimeOverStore,
    defaultScopeResolver,
    authenticate,
    CLOCK_START
} = require("./bootstrapHarness");

module.exports = { manualClock, makeHarness, composeIsolatedTrustDomain, composeRuntimeOverStore, defaultScopeResolver, authenticate, CLOCK_START };
