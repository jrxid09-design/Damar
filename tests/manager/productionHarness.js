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
const { isCanonicalWave6ExecutionAdapter } = require("../../src/manager/internal/wave6AdapterBrand");
const { makeActuationHarness } = require("../actuation/harness");
const { makeVerificationHarness } = require("../verification/harness");
const { CHANNEL_ADAPTERS } = require("../../src/manager/channels");

/**
 * TEST-ONLY: pass-through for a test-supplied Wave 6 lane-3 adapter so it can be
 * injected through the trusted-internal composition seam. R5-02 removed the
 * production branding primitive entirely (`__brandWave6Adapter` no longer exists);
 * this helper does NOT import or invoke any production privileged mutator. It is
 * test-only scaffolding — never a production export, never reachable by a
 * RuntimeHost/channel. The production RuntimeHost composition owns its own
 * adapter via closure; tests drive the internal composition directly.
 */
function brandTestWave6Adapter(adapter) {
    if (adapter === null || typeof adapter !== "object" ||
        typeof adapter.tryDistributed !== "function") {
        throw new TypeError("brandTestWave6Adapter requires { tryDistributed }");
    }
    return adapter;
}

/**
 * TEST-ONLY Wave 6 lane-3 facade builder (former production
 * `createWave6Lane3Facade`). R4-04 removed the caller-controlled callback
 * facade from the production/public surface; tests that need a seam to probe
 * the Manager's Lane-3 boundary construct one HERE and brand it via
 * brandTestWave6Adapter. This is composition-time test privilege only — it is
 * never a production export and can never be reached by a RuntimeHost/channel.
 */
function createTestWave6Lane3Facade({
    route = null,
    claim = null,
    execute = null
} = {}) {
    if (route !== null && typeof route !== "function") {
        throw new TypeError("createTestWave6Lane3Facade: route must be a function or null");
    }
    if (claim !== null && typeof claim !== "function") {
        throw new TypeError("createTestWave6Lane3Facade: claim must be a function or null");
    }
    if (execute !== null && typeof execute !== "function") {
        throw new TypeError("createTestWave6Lane3Facade: execute must be a function or null");
    }
    const adapter = Object.freeze({
        disabled: route === null,
        async tryDistributed({ intent, parameters = {} }) {
            if (route === null || claim === null || execute === null) {
                return Object.freeze({ distributed: false });
            }
            try {
                const routed = await route(intent, parameters);
                if (!routed || !routed.targetNodeId) {
                    return Object.freeze({ distributed: false });
                }
                const claimId = await claim({
                    intent,
                    toolId: routed.toolId ?? `tool.${intent.capabilityId}`,
                    sandboxNeeds: routed.sandboxNeeds ?? {},
                    toolArtifactPath: routed.toolArtifactPath ?? null
                });
                if (!claimId) {
                    return Object.freeze({ distributed: true, error: "WAVE6_CLAIM_FAILED" });
                }
                const result = await execute({ claimId, args: intent.arguments ?? parameters });
                return Object.freeze({
                    distributed: true,
                    executionId: result.executionId ?? null,
                    targetNodeId: routed.targetNodeId,
                    decisionDigest: result.decisionDigest ?? null,
                    output: result.output ?? null
                });
            } catch (e) {
                return Object.freeze({
                    distributed: true,
                    error: "WAVE6_ROUTE_FAILED",
                    reason: String((e && (e.reasonCode || e.message)) || "unknown").slice(0, 200)
                });
            }
        }
    });
    return Object.freeze({
        ...adapter,
        disabled: adapter.disabled
    });
}

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
 * @param {object}   [opts.wave6Adapter] — TEST-ONLY: trusted-internal Wave 6
 *   lane-3 adapter wired through the internal composition seam. NOT a production
 *   option; never forwarded from RuntimeHost/channel/Manager requests. Null =
 *   frozen behavior. Passed UNBRANDED (R5-02 removed production branding).
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
    // R5-02: TRUSTED-INTERNAL Wave 6 lane-3 adapter (test-only composition
    // privilege). Null = frozen behavior. Duck-typed objects are rejected by
    // the test-only harness pass-through. Production never receives this.
    wave6Adapter = null
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
        // R5-02: trusted-internal seam, wired to the internal composition param
        // directly (NO production brand / NO caller callback facade).
        ...(wave6Adapter ? { wave6Adapter } : {})
    });

    return {
        manager,
        lane3: lane3h,
        lane4: lane4h,
        adapters: withAdapters ? CHANNEL_ADAPTERS : [],
        mediaContextMint: mediaContextAuthority.mint
    };
}

module.exports = { makeManagerHarness, brandTestWave6Adapter, createTestWave6Lane3Facade, isCanonicalWave6ExecutionAdapter };
