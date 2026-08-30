"use strict";

/**
 * DAMAR MANAGER — CANONICAL TRUSTED BOOTSTRAP (Lane 5).
 *
 * This is the ONLY place where the canonical application Manager instance is
 * created. It is NOT a public/downstream API surface beyond the frozen facade
 * it returns.
 *
 * CORE LAWS:
 *
 *   MANAGER != AUTHORITY
 *   FACTORY AVAILABLE != CANONICAL APPLICATION MANAGER INSTANCE
 *   FIRST COMPOSITION CREATION DOES NOT ESTABLISH SHARED TRUST
 *
 * The production canonical Manager is created by createDamarManager() which
 * takes NO options: the Lane 2/Lane 3/Lane 4 facades are the canonical
 * bootstrap-owned singletons, and NO test channel adapters are wired. The
 * canonical authentication path is fail-closed (the Lane 2 bootstrap's fixed
 * adapter) until a later lane wires real trusted auth infrastructure INTO the
 * bootstrap — the Manager can therefore never mint a principal that trusted
 * infrastructure did not establish.
 *
 * The production facade is EXACTLY:
 *
 *     Object.freeze({ handle, cancel,
 *                     isCanonicalManagerRequest, isCanonicalManagerResult })
 *
 * It MUST NOT and DOES NOT expose: the Lane 2/Lane 3/Lane 4 facades, the
 * planner, the verifier/actuator registries, the capability registrar, any
 * brand state, any composition factory, or any channel authority hook.
 */

const { createDamarManagerComposition } = require("./internal/managerBootstrap");
const { CHANNEL_ADAPTERS } = require("./channels");
const { createCanonicalActionFacade, createCanonicalActuationFacade, createCanonicalVerificationFacade } = require("../action/bootstrap");
const { fail, REASONS } = require("../action/errors");

// The ONE canonical application Manager, created exactly once, lazily.
let canonicalManager = null;

/**
 * Create the canonical application Damar Manager facade. Takes NO options.
 *
 * @returns {object} frozen least-privilege facade, EXACTLY:
 *     { handle, cancel, isCanonicalManagerRequest, isCanonicalManagerResult }
 */
function createDamarManager() {
    if (arguments[0] !== undefined) {
        throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
            "canonical manager creation accepts NO options; the Lane 2/3/4 facades, planner, and channel adapters are bootstrap-owned");
    }
    if (canonicalManager === null) {
        canonicalManager = createDamarManagerComposition({
            deps: {
                // Canonical certified fabric singletons (bootstrap-owned).
                lane2: createCanonicalActionFacade(),
                lane3: createCanonicalActuationFacade(),
                lane4: createCanonicalVerificationFacade(),
                // No production planner is wired in Lane 5 V1; cognition
                // integration is advisory and defaults to null (non-action
                // requests complete without it).
                planner: null
            },
            // Trusted built-in normalizers only; no caller-controlled registry
            // or adapter injection is exposed by this bootstrap.
            trustedChannelAdapters: CHANNEL_ADAPTERS.slice()
        });
    }
    return canonicalManager;
}

module.exports = { createDamarManager };
