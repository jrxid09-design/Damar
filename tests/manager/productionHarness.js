"use strict";

/**
 * DAMAR MANAGER — TEST-ONLY PRODUCTION-PATH HARNESS (Lane 5, wiring ONLY).
 *
 * This harness exercises the REAL production Manager implementation:
 *   src/manager/internal/managerBootstrap.js::createDamarManagerComposition
 *
 * It contains NO Manager logic copies. It is WIRING ONLY:
 *   - it imports the SAME trusted composition function the canonical
 *     application uses (src/manager/bootstrap.js calls it with
 *     trustedChannelAdapters = [] and canonical Lane 2/3/4 facades);
 *   - it supplies test-only Lane 2/Lane 3/Lane 4 facades (from the certified
 *     test harnesses of those lanes) and test channel adapters, consumed ONLY
 *     at composition time.
 *
 * AVAILABLE != AUTHORIZED: this harness's composition-time wiring is
 * test-only privilege; it does NOT widen production runtime authority.
 *
 * PER-COMPOSITION PROVENANCE (Lane 4 R5 lesson): every harness invocation is
 * an INDEPENDENT trust domain. Artifacts minted by one harness are NOT
 * canonical to another harness or to the canonical application Manager.
 */

const { createDamarManagerComposition } = require("../../src/manager/internal/managerBootstrap");
const { createMediaContextAuthority } = require("../../src/manager/internal/mediaContext");
const { makeActuationHarness } = require("../actuation/harness");
const { makeVerificationHarness } = require("../verification/harness");
const { CHANNEL_ADAPTERS } = require("../../src/manager/channels");

/**
 * Build a production-path Manager harness:
 *   {
 *     manager,        // REAL production Manager facade (handle/cancel/isCanonical*)
 *     lane2, lane3, lane4,   // the certified lane test harnesses backing it
 *     adapters,       // the composition-time channel adapter snapshots
 *   }
 *
 * @param {object} [opts]
 * @param {object}   [opts.scopeBindings] — Lane 2 scope bindings
 * @param {Array}    [opts.trustedVerifiers] — Lane 4 composition-time verifiers
 * @param {Function} [opts.planner] — advisory cognition hook (PLAN != AUTHORITY)
 * @param {boolean}  [opts.withAdapters] — wire the 5 built-in channel adapters
 */
async function makeManagerHarness({
    scopeBindings,
    trustedVerifiers = [],
    planner = null,
    mediaProcessor = null,
    // Contract tests may supply this at composition time only.  It is never
    // forwarded from RuntimeHost, a channel adapter, or a Manager request.
    authenticate = undefined,
    withAdapters = true,
    // R3-04: optional narrow Wave 6 lane-3 seam (route authorized intents
    // through distributed execution). Null = frozen behavior.
    wave6Distributed = null
} = {}) {
    // Lane 3 actuation harness (canonical execution results for this domain)
    const lane3h = await makeActuationHarness({ scopeBindings, ...(authenticate ? { authenticate } : {}) });
    // Lane 4 verification harness composed over the SAME Lane 3 domain
    const lane4h = await makeVerificationHarness({ scopeBindings, trustedVerifiers, ...(authenticate ? { authenticate } : {}) });

    // The REAL production Manager composition with test-supplied deps.
    const mediaContextAuthority = createMediaContextAuthority();
    const manager = createDamarManagerComposition({
        deps: {
            lane2: {
                admit: lane3h.lane2.admit,
                evaluate: lane3h.lane2.evaluate,
                authenticate: lane3h.lane2.authDomain.authenticate,
                session: lane3h.lane2.session
            },
            lane3: { execute: lane3h.execute },
            lane4: { verify: lane4h.verify, compensate: lane4h.compensate },
            planner
        },
        trustedChannelAdapters: withAdapters ? CHANNEL_ADAPTERS.slice() : [],
        mediaProcessor,
        mediaContextAuthority,
        ...(wave6Distributed ? { wave6Distributed } : {})
    });

    return {
        manager,
        lane3: lane3h,
        lane4: lane4h,
        adapters: withAdapters ? CHANNEL_ADAPTERS : [],
        mediaContextMint: mediaContextAuthority.mint
    };
}

module.exports = { makeManagerHarness };
