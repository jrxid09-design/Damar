"use strict";

const { createMediaContextAuthority } = require("./mediaContext");

/**
 * DAMAR MANAGER — TRUSTED INTERNAL COMPOSITION (Lane 5, TARGETED lessons from
 * Lane 4 R5: composition == provenance domain).
 *
 * This module is the ONLY place where the production Damar Manager
 * composition is implemented. It is an INTERNAL trusted module:
 *
 *   - it is NOT re-exported through src/manager/index.js (the public surface);
 *   - ordinary downstream callers CANNOT reach it through the canonical
 *     bootstrap facade (the facade exposes exactly
 *     { handle, cancel, isCanonicalManagerRequest, isCanonicalManagerResult });
 *   - the production runtime calls it via src/manager/bootstrap.js with
 *     trustedChannelAdapters = [] and default deps;
 *   - the test-only production harness (tests/manager/productionHarness.js)
 *     calls the SAME function with test-supplied deps/adapters, so
 *     certification proofs exercise the REAL production implementation.
 *
 * PER-COMPOSITION PROVENANCE (Lane 4 R5 lesson — APPLIED VERBATIM):
 *   The ManagerRequest / ManagerResult brand WeakSets are declared FRESH
 *   INSIDE createDamarManagerComposition. Every composition instance owns an
 *   INDEPENDENT provenance domain:
 *
 *     COMPOSITION INSTANCE != SHARED TRUST DOMAIN
 *     TRUSTED IMPLEMENTATION != SHARED TRUST DOMAIN
 *     FACTORY AVAILABLE != CANONICAL APPLICATION MANAGER INSTANCE
 *     FIRST COMPOSITION CREATION DOES NOT ESTABLISH SHARED TRUST
 *
 *   An attacker-controlled alternate composition CANNOT mint artifacts
 *   accepted by the canonical application Manager, and cross-domain
 *   handle/cancel is rejected before the action fabric.
 *
 * DEPENDENCY CAPTURE: Lane 2/Lane 3/Lane 4 facades, planner, and channel
 * adapters are captured ONCE at composition time from the trusted deps bag.
 * Post-composition mutation of caller-owned dep objects has zero semantic
 * effect (facade references + function identities captured once; adapters are
 * frozen snapshots).
 *
 * WHAT THE MANAGER DOES (orchestration only):
 *   - normalizes inbound channel material into a canonical ManagerRequest
 *     (canonical authentication FIRST, then principal binding);
 *   - classifies requests (non-action cognition completes without Lane 2/3);
 *   - routes ACTION requests exclusively through Lane 2 → Lane 3 → Lane 4;
 *   - maps lower-layer states to a UNIFORM outcome classification;
 *   - requests Lane 4 compensation through the Lane 4 facade when policy
 *     indicates (never calls a compensator directly);
 *   - projects immutable ManagerResults back to channels.
 *
 * WHAT THE MANAGER NEVER DOES:
 *   - return ALLOW itself / construct bearer AuthorityDecisions;
 *   - invoke actuators or verifiers directly;
 *   - register actuators or verifiers;
 *   - mark arbitrary results VERIFIED;
 *   - directly execute compensation;
 *   - mutate capability graph authority;
 *   - treat memory/model/channel/Pandawa output as authority.
 */

const crypto5 = require("node:crypto");
const { types: utilTypes5 } = require("node:util");

const {
    LIFECYCLE: MLC, OUTCOME: MOUTCOME, REASONS: MREASONS, fail: mfail
} = require("../../manager/errors");
const {
    REQUEST_SCHEMA_VERSION: MREQ_SCHEMA, RESULT_SCHEMA_VERSION: MRES_SCHEMA,
    BOUNDS: MBOUNDS, isChannelType: isChannelType5
} = require("../../manager/schema");
const {
    REQUEST_CLASS, classifyPlannerOutput, requiresActionFabric
} = require("../../manager/channelAdapter");
const {
    VERIFICATION_STATE: VSTATE_L4, REASONS: VREASONS_L4
} = require("../../action/verification/errors");
const { RESULT_STATE: RESULT_STATE_L3 } = require("../../action/actuation/errors");
const { DECISION: DECISION_L2 } = require("../../action/gate");
const { fail: afail, REASONS: ACTION_REASONS } = require("../../action/errors");

// ---------------------------------------------------------------------------
// INERT HOSTILE-INPUT DETACHMENT (shared principle, no authority)
// Manager request payloads / intent material are declarative only: bounded,
// detached, no functions/symbols/accessors/class instances/cycles/dangerous
// keys. This mirrors the safe-detach principle used by the certified lanes;
// it carries NO authority and grants NO membership.
// ---------------------------------------------------------------------------
const M_DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

function mIsPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function mDetach(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) {
        throw mfail(MREASONS.BOUND_EXCEEDED, `payload exceeds node budget (${state.maxNodes})`);
    }
    if (value === null) return null;
    const t = typeof value;
    if (t === "string") {
        return value.length > state.maxString ? value.slice(0, state.maxString) : value;
    }
    if (t === "boolean") return value;
    if (t === "number") return Number.isFinite(value) ? value : null;
    if (t === "function") throw mfail(MREASONS.FUNCTION_VALUE, "function values are not permitted");
    if (t === "symbol" || t === "bigint" || t === "undefined") {
        throw mfail(MREASONS.SYMBOL_VALUE, `${t} values are not permitted`);
    }
    // Zero-trap Proxy gate (Lane 4 R1 lesson): internal-slot probe only.
    if (utilTypes5.isProxy(value)) {
        throw mfail(MREASONS.NON_PLAIN_OBJECT, "proxy-like value is not permitted (zero-trap fail-closed)");
    }
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw mfail(MREASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > MBOUNDS.GLOBAL_MAX_ARRAY_LENGTH) throw mfail(MREASONS.BOUND_EXCEEDED, "array length exceeds global bound");
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = mDetach(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!mIsPlainObject(value)) {
        throw mfail(MREASONS.NON_PLAIN_OBJECT, "non-plain object is not permitted");
    }
    if (state.path.has(value)) throw mfail(MREASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (M_DANGEROUS_KEYS.has(key)) throw mfail(MREASONS.DANGEROUS_KEY, `dangerous key '${key}' in payload`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            throw mfail(MREASONS.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        }
        out[key] = mDetach(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw mfail(MREASONS.SYMBOL_VALUE, "symbol keys are not permitted");
    }
    state.path.delete(value);
    return out;
}

function mRequireString(value, field, maxChars, { optional = false, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return "";
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, `${field} is required`);
    }
    if (typeof value !== "string") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, `${field} must be a string, got ${typeof value}`);
    }
    const s = value.trim();
    if (!optional && !allowEmpty && s.length === 0) {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, `${field} must not be empty`);
    }
    if (s.length > maxChars) throw mfail(MREASONS.BOUND_EXCEEDED, `${field} exceeds ${maxChars} chars`);
    return s;
}

function mRequireSafeInteger(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return value;
}

function deepFreezeM(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreezeM(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

/**
 * Create the canonical Damar Manager composition (trusted internal factory).
 *
 * @param {object} opts
 * @param {object} opts.deps — bootstrap-owned dependencies, captured ONCE:
 *   {
 *     lane2: { admit, evaluate, authenticate, session },   // canonical Lane 2 facade
 *     lane3: { execute },                                  // canonical Lane 3 facade
 *     lane4: { verify, compensate },                       // canonical Lane 4 facade
 *     planner: async ({ request }) => declarative output   // advisory cognition
 *   }
 * @param {Array} [opts.trustedChannelAdapters] — composition-time-only
 *   adapter registrations: { channelType, normalizeInbound, renderOutbound }.
 *   Production passes [] (adapters are wired by the trusted runtime layer).
 * @returns {object} frozen least-privilege facade:
 *   { handle, cancel, isCanonicalManagerRequest, isCanonicalManagerResult }
 */
function createDamarManagerComposition({
    deps,
    trustedChannelAdapters = [],
    mediaProcessor = null,
    mediaContextAuthority = createMediaContextAuthority()
} = {}) {
    if (deps === null || typeof deps !== "object") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "manager composition requires deps");
    }
    const {
        lane2, lane3, lane4, planner = null
    } = deps;
    if (!lane2 || typeof lane2.admit !== "function" || typeof lane2.evaluate !== "function" ||
        typeof lane2.authenticate !== "function" || typeof lane2.session !== "function") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "deps.lane2 must provide admit/evaluate/authenticate/session");
    }
    if (!lane3 || typeof lane3.execute !== "function") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "deps.lane3 must provide execute");
    }
    if (!lane4 || typeof lane4.verify !== "function" || typeof lane4.compensate !== "function") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "deps.lane4 must provide verify/compensate");
    }
    if (planner !== null && typeof planner !== "function") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "deps.planner must be a function or null");
    }
    if (mediaProcessor !== null && typeof mediaProcessor !== "function") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "mediaProcessor must be a function or null");
    }
    if (!mediaContextAuthority || typeof mediaContextAuthority.recognize !== "function") {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "mediaContextAuthority is invalid");
    }
    if (!Array.isArray(trustedChannelAdapters)) {
        throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "trustedChannelAdapters must be an array");
    }

    // ---- PER-COMPOSITION PROVENANCE DOMAIN (Lane 4 R5 lesson) -------------
    const mRequestBrandSet = new WeakSet();
    const mResultBrandSet = new WeakSet();

    // ---- DEPENDENCY CAPTURE (once; post-composition mutation has no effect)
    const capturedLane2 = lane2;
    const capturedLane3 = lane3;
    const capturedLane4 = lane4;
    const capturedPlanner = planner;
    const capturedMediaProcessor = mediaProcessor;
    const recognizeMediaContext = mediaContextAuthority.recognize;

    // Channel adapters: frozen snapshots, keyed by channel type. Composition-
    // time-only wiring; after composition NO caller can register/replace.
    const adaptersByType = new Map();
    for (const adapter of trustedChannelAdapters) {
        if (adapter === null || typeof adapter !== "object" ||
            !isChannelType5(adapter.channelType) ||
            typeof adapter.normalizeInbound !== "function" ||
            typeof adapter.renderOutbound !== "function") {
            throw mfail(MREASONS.CHANNEL_ADAPTER_ERROR,
                "channel adapter must provide channelType + normalizeInbound + renderOutbound");
        }
        adaptersByType.set(adapter.channelType, Object.freeze({
            channelType: adapter.channelType,
            normalizeInbound: adapter.normalizeInbound,
            renderOutbound: adapter.renderOutbound
        }));
    }

    // ---- Duplicate-request orchestration guard (PROCESS-LOCAL; Lane 3
    // remains the final actuation duplicate boundary).
    const inFlightByCorrelation = new Map();
    const MAX_ACTIVE = MBOUNDS.MAX_ACTIVE_REQUESTS;

    function canonicalNow() {
        const v = Date.now();
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
            throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "canonical clock returned an invalid timestamp");
        }
        return v;
    }

    // ---- canonical ManagerRequest former (composition-private) ------------
    function formManagerRequest(input) {
        if (input === null || typeof input !== "object") {
            throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "manager request input must be a plain object");
        }
        // Reject a hostile top-level transport object before reading any
        // caller-controlled property. util.types.isProxy is an internal-slot
        // probe and does not invoke Proxy traps.
        if (utilTypes5.isProxy(input)) {
            throw mfail(MREASONS.NON_PLAIN_OBJECT, "proxy-like manager request is not permitted");
        }
        const channelType = mRequireString(input.channelType, "channelType", 32);
        if (!isChannelType5(channelType)) {
            throw mfail(MREASONS.INVALID_MANAGER_REQUEST, `unsupported channelType '${channelType}'`);
        }
        const channelId = mRequireString(input.channelId, "channelId", MBOUNDS.MAX_CHANNEL_ID_CHARS);
        const sessionId = mRequireString(input.sessionId, "sessionId", MBOUNDS.MAX_CHANNEL_ID_CHARS);
        const peer = mRequireString(input.peer ?? "", "peer", MBOUNDS.MAX_CHANNEL_ID_CHARS, { optional: true, allowEmpty: true });
        const correlationId = mRequireString(input.correlationId ?? sessionId, "correlationId", MBOUNDS.MAX_CORRELATION_CHARS, { optional: true, allowEmpty: true });
        const receivedAtMs = input.receivedAtMs === undefined
            ? canonicalNow()
            : mRequireSafeInteger(input.receivedAtMs, "receivedAtMs");

        // HOSTILE-INPUT DETACHMENT FIRST (zero-trap): the raw payload is
        // detached/bounded BEFORE any adapter sees it, so a hostile Proxy
        // payload cannot execute attacker-controlled traps during adapter
        // normalization. Adapters receive ONLY already-safe detached data.
        let payload = (input.payload === undefined || input.payload === null)
            ? null : input.payload;
        let metadata = input.metadata ?? null;
        if (payload !== null) {
            const rawState = { nodes: 0, maxNodes: MBOUNDS.MAX_PAYLOAD_NODES, maxString: MBOUNDS.MAX_PAYLOAD_STRING_CHARS, path: new Set() };
            payload = deepFreezeM(mDetach(payload, rawState));
        }
        if (metadata !== undefined && metadata !== null) {
            const rawMetaState = { nodes: 0, maxNodes: MBOUNDS.MAX_PAYLOAD_NODES, maxString: MBOUNDS.MAX_PAYLOAD_STRING_CHARS, path: new Set() };
            metadata = deepFreezeM(mDetach(metadata, rawMetaState));
        }

        // Adapter normalization hook (trusted, composition-time captured).
        // Adapters receive ONLY already-detached safe data; they may ONLY
        // shape payload/metadata; they can never change channelType, mint
        // identity, or inject authority.
        const adapter = adaptersByType.get(channelType);
        if (adapter) {
            const normalized = adapter.normalizeInbound({
                channelType, channelId, peer, sessionId, payload, metadata
            });
            payload = normalized?.payload ?? payload;
            metadata = normalized?.metadata ?? metadata;
            // Re-detach the adapter output (defense in depth: the adapter is
            // trusted but its output is still bounded/detached before use).
            if (payload !== null && payload !== undefined) {
                const postState = { nodes: 0, maxNodes: MBOUNDS.MAX_PAYLOAD_NODES, maxString: MBOUNDS.MAX_PAYLOAD_STRING_CHARS, path: new Set() };
                payload = deepFreezeM(mDetach(payload, postState));
            }
            if (metadata !== null && metadata !== undefined) {
                const postMetaState = { nodes: 0, maxNodes: MBOUNDS.MAX_PAYLOAD_NODES, maxString: MBOUNDS.MAX_PAYLOAD_STRING_CHARS, path: new Set() };
                metadata = deepFreezeM(mDetach(metadata, postMetaState));
            }
        }

        // Payload and metadata are ALREADY detached above (pre-adapter).
        const detachedPayload = (payload === undefined || payload === null)
            ? deepFreezeM({}) : payload;
        if (Object.getOwnPropertyNames(detachedPayload).length > MBOUNDS.MAX_PAYLOAD_KEYS) {
            throw mfail(MREASONS.BOUND_EXCEEDED, `payload exceeds ${MBOUNDS.MAX_PAYLOAD_KEYS} keys`);
        }
        const detachedMetadata = (metadata === undefined || metadata === null)
            ? deepFreezeM({}) : metadata;

        // Declarative intent material (PLAN != AUTHORITY): detached, bounded.
        let intentMaterial = deepFreezeM({});
        if (input.intentMaterial !== undefined && input.intentMaterial !== null) {
            const imState = { nodes: 0, maxNodes: MBOUNDS.MAX_INTENT_MATERIAL_NODES, maxString: MBOUNDS.MAX_PAYLOAD_STRING_CHARS, path: new Set() };
            intentMaterial = deepFreezeM(mDetach(input.intentMaterial, imState));
        }

        // CLASSIFICATION: caller may propose a class, but the Manager never
        // grants a more privileged class than the material supports. Requests
        // carrying a declarative action proposal are ACTION_PROPOSAL; an
        // explicit requestedOperation is an ACTION.
        const requestedOperation = (input.requestedOperation && typeof input.requestedOperation === "object")
            ? input.requestedOperation : null;
        // Preserve the complete declarative operation, including verification
        // and compensation policy, after bounded detachment. Dropping policy
        // here would silently turn a requested compensating action into a
        // non-compensating one; it never grants authority.
        let detachedOperation = null;
        if (requestedOperation !== null) {
            const operationState = { nodes: 0, maxNodes: MBOUNDS.MAX_PAYLOAD_NODES,
                maxString: MBOUNDS.MAX_PAYLOAD_STRING_CHARS, path: new Set() };
            detachedOperation = mDetach(requestedOperation, operationState);
            if (detachedOperation === null || typeof detachedOperation !== "object" || Array.isArray(detachedOperation)) {
                throw mfail(MREASONS.INVALID_MANAGER_REQUEST, "requestedOperation must be a plain object");
            }
            detachedOperation = deepFreezeM(detachedOperation);
        }
        let requestClass;
        if (detachedOperation !== null &&
            typeof detachedOperation.capabilityId === "string" &&
            typeof detachedOperation.operation === "string") {
            requestClass = REQUEST_CLASS.ACTION;
        } else if (intentMaterial !== null && typeof intentMaterial === "object" &&
            Object.getOwnPropertyNames(intentMaterial).length > 0) {
            requestClass = classifyPlannerOutput(intentMaterial);
        } else {
            requestClass = REQUEST_CLASS.INFORMATIONAL;
        }

        // Cancellation token identity (opaque string only).
        const cancellationId = mRequireString(
            input.cancellationId ?? `canc-${crypto5.randomUUID()}`,
            "cancellationId", MBOUNDS.MAX_CANCELLATION_ID_CHARS, { allowEmpty: false }
        );

        const requestId = crypto5.randomUUID();
        const request = deepFreezeM({
            schemaVersion: MREQ_SCHEMA,
            requestId,
            channelType,
            channelId,
            sessionProvenance: deepFreezeM({ channelType, sessionId, peer }),
            correlationId,
            receivedAtMs,
            payload: detachedPayload,
            metadata: detachedMetadata,
            intentMaterial,
            requestedOperation: detachedOperation === null ? null : deepFreezeM({
                ...detachedOperation,
                capabilityId: mRequireString(detachedOperation.capabilityId, "requestedOperation.capabilityId", 256),
                operation: mRequireString(detachedOperation.operation, "requestedOperation.operation", 256),
                arguments: detachedOperation.arguments === undefined ? deepFreezeM({}) : detachedOperation.arguments
            }),
            requestClass,
            cancellationId
            // NOTE: principal is NOT taken from input. It is bound AFTER
            // canonical authentication inside handle() (see below).
        });
        mRequestBrandSet.add(request);
        return request;
    }

    // ---- canonical ManagerResult former (composition-private) -------------
    function formManagerResult({
        request, lifecycleState, outcome, detail = "",
        authorityEvidence = null, actionIntentId = null, executionId = null,
        verificationId = null, compensationId = null, evidenceSummary = null,
        errorReason = "", startedAtMs, completedAtMs
    }) {
        const result = deepFreezeM({
            schemaVersion: MRES_SCHEMA,
            managerRequestId: request.requestId,
            actionIntentId,
            authorityEvidence: authorityEvidence === null ? null : deepFreezeM({
                decision: authorityEvidence.decision ?? null,
                reasonCode: authorityEvidence.reasonCode ?? null,
                evaluatedAtMs: authorityEvidence.evaluatedAtMs ?? null
            }),
            executionId,
            verificationId,
            compensationId,
            lifecycleState,
            outcome,
            detail: String(detail ?? "").slice(0, MBOUNDS.MAX_DETAIL_CHARS),
            evidenceSummary: evidenceSummary === null ? null : evidenceSummary,
            errorReason,
            startedAtMs,
            completedAtMs
            // MANAGER RESULT != AUTHORITY: no bearer token, no decision copy
            // usable as authority — only historical references.
        });
        mResultBrandSet.add(result);
        return result;
    }

    // ---- uniform outcome projection (composition-private) ------------------
    const outcomeForVerification = (state) => require("../../manager/errors").outcomeForVerificationState(state, MOUTCOME);
    const outcomeForExecution = (state) => require("../../manager/errors").outcomeForExecutionState(state, MOUTCOME);

    // ---- handle(): the ONLY downstream request capability ------------------
    async function handle(input, { signal, mediaContext } = {}) {
        // Lane 2 media is an internal, least-privilege processing input.  The
        // canonical envelope remains inert; Manager accepts only the already
        // issued per-attachment handles and never receives a resolver/store.
        const startedAtMs = canonicalNow();
        let request;
        try {
            request = formManagerRequest(input);
        } catch (e) {
            // Invalid request: typed Manager error, no lifecycle fabricated.
            throw e;
        }

        // DUPLICATE ORCHESTRATION GUARD (process-local): same correlation in
        // flight reuses the SAME lifecycle promise (no duplicate dispatch).
        if (inFlightByCorrelation.has(request.correlationId)) {
            return inFlightByCorrelation.get(request.correlationId).promise;
        }
        const entry = { promise: null, cancelled: false };
        if (inFlightByCorrelation.size >= MAX_ACTIVE) {
            const first = inFlightByCorrelation.keys().next().value;
            if (first !== undefined) inFlightByCorrelation.delete(first);
        }
        inFlightByCorrelation.set(request.correlationId, entry);
        const runPromise = (async () => {
            try {
                return await runHandleBody(request, entry, startedAtMs, signal, mediaContext);
            } finally {
                inFlightByCorrelation.delete(request.correlationId);
            }
        })();
        entry.promise = runPromise;
        return runPromise;
    }

    async function runHandleBody(request, entry, startedAtMs, signal, mediaContext) {
        const now = () => canonicalNow();

        // ---- 1. CANCELLATION CHECK (pre-authentication) --------------------
        if (entry.cancelled || isAborted(signal)) {
            return formManagerResult({
                request, lifecycleState: MLC.CANCELLED, outcome: MOUTCOME.CANCELLED,
                detail: "cancelled before normalization", startedAtMs,
                completedAtMs: now(), errorReason: MREASONS.REQUEST_CANCELLED
            });
        }

        // ---- 2. CANONICAL AUTHENTICATION FIRST, THEN PRINCIPAL BINDING ----
        // CHANNEL != AUTHORITY: the caller/channel can NEVER bind the
        // principal through payload/metadata/intent fields. Authentication
        // goes through the canonical Lane 2 authentication path, which is
        // FAIL-CLOSED in the production composition until a later lane wires
        // real trusted auth infrastructure INTO the bootstrap.
        let session = null;
        let authenticatedPrincipal = null;
        try {
            const evidence = {
                channelType: request.channelType,
                channelId: request.channelId,
                sessionId: request.sessionProvenance.sessionId,
                peer: request.sessionProvenance.peer,
                correlationId: request.correlationId
                // NOTE: no caller-supplied principal field is forwarded.
            };
            session = capturedLane2.authenticate(evidence);
            authenticatedPrincipal = session && typeof session === "object"
                ? session.principal : null;
        } catch {
            session = null;
            authenticatedPrincipal = null;
        }
        if (!session || typeof authenticatedPrincipal !== "string" || authenticatedPrincipal.length === 0) {
            return formManagerResult({
                request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.AUTHENTICATION_REQUIRED,
                detail: "canonical authentication failed closed; no session minted",
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.AUTHENTICATION_REQUIRED
            });
        }
        const principal = authenticatedPrincipal;

        if (mediaContext !== undefined && !recognizeMediaContext(mediaContext)) {
            throw new TypeError("MEDIA_CONTEXT_INVALID");
        }
        if (mediaContext && capturedMediaProcessor) {
            await capturedMediaProcessor(Object.freeze({ request, mediaContext }));
        }

        // ---- 3. NON-ACTION COGNITION (no Lane 2/3 entry) -------------------
        if (!requiresActionFabric(request.requestClass)) {
            // Informational / reasoning / memory-lookup / planning: advisory
            // cognition only. Planning output is untrusted declarative
            // material — it is projected as advisory, NEVER as authority.
            let plannerOutput = null;
            if (capturedPlanner) {
                try {
                    plannerOutput = await capturedPlanner({ request, principal });
                } catch {
                    plannerOutput = null;
                }
            }
            return formManagerResult({
                request, lifecycleState: MLC.COMPLETED, outcome: MOUTCOME.COMPLETED,
                detail: "non-action request completed without the action fabric",
                evidenceSummary: plannerOutput === null ? null : { advisory: true },
                startedAtMs, completedAtMs: now()
            });
        }

        // ---- 4. ACTION PROPOSAL: PLANNER (PLAN != AUTHORITY) ---------------
        // If the caller supplied intent material, run the planner (if any) to
        // normalize a declarative proposal. Planner output NEVER grants
        // authority and NEVER carries a decision; only the declarative
        // proposal fields are read.
        let proposal = request.requestedOperation;
        if (proposal === null && request.requestClass === REQUEST_CLASS.ACTION_PROPOSAL) {
            let plannerProposal = null;
            if (capturedPlanner) {
                try {
                    plannerOutput = await capturedPlanner({ request, principal });
                    const classified = classifyPlannerOutput(plannerOutput ?? {});
                    if (classified === REQUEST_CLASS.ACTION_PROPOSAL) {
                        const p = (plannerOutput.actionProposal ?? plannerOutput.proposal);
                        plannerProposal = {
                            capabilityId: String(p.capabilityId ?? "").slice(0, 256),
                            operation: String(p.operation ?? "").slice(0, 256),
                            arguments: p.arguments ?? {}
                        };
                    }
                } catch {
                    plannerProposal = null;
                }
            }
            if (plannerProposal === null) {
                return formManagerResult({
                    request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.INVALID_REQUEST,
                    detail: "no actionable proposal available from planner material",
                    startedAtMs, completedAtMs: now(),
                    errorReason: MREASONS.INTENT_REJECTED
                });
            }
            proposal = plannerProposal;
        }
        if (proposal === null) {
            return formManagerResult({
                request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.INVALID_REQUEST,
                detail: "action request without a declarative proposal",
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.INTENT_REJECTED
            });
        }

        // ---- 5. CANONICAL INTENT FORMATION (via Lane 2 admit ONLY) ---------
        let intent;
        try {
            intent = capturedLane2.admit(JSON.stringify({
                schemaVersion: 1,
                capabilityId: proposal.capabilityId,
                operation: proposal.operation,
                arguments: proposal.arguments ?? {}
            }), { source: `manager:${request.channelType}` });
        } catch (e) {
            return formManagerResult({
                request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.INVALID_REQUEST,
                detail: `intent rejected at admission: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.INTENT_REJECTED
            });
        }
        entry.lastIntent = intent;

        // ---- 6. LANE 2 AUTHORITY (the ONLY authorization path) -------------
        if (entry.cancelled || isAborted(signal)) {
            return formManagerResult({
                request, lifecycleState: MLC.CANCELLED, outcome: MOUTCOME.CANCELLED,
                actionIntentId: intent.intentId,
                detail: "cancelled before authority evaluation",
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.REQUEST_CANCELLED
            });
        }
        let decision = null;
        try {
            decision = await capturedLane2.evaluate(intent, session);
        } catch (e) {
            return formManagerResult({
                request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.AUTHORITY_DENIED,
                actionIntentId: intent.intentId,
                detail: `authority evaluation failed: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.AUTHORITY_DENIED
            });
        }
        const authorityEvidence = {
            decision: decision?.decision ?? null,
            reasonCode: decision?.reasonCode ?? null,
            evaluatedAtMs: now()
        };
        if (!decision || decision.decision !== DECISION_L2.ALLOW) {
            // AUTHORITY DENIED: zero Lane 3 dispatch. The Manager never
            // returns ALLOW itself and never carries the decision forward as
            // a bearer token — Lane 3 revalidates freshly.
            return formManagerResult({
                request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.AUTHORITY_DENIED,
                actionIntentId: intent.intentId,
                authorityEvidence,
                detail: `authority denied: ${decision?.reasonCode ?? "no decision"}`,
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.AUTHORITY_DENIED
            });
        }

        // ---- 7. LANE 3 ACTUATION (canonical fabric only) --------------------
        if (entry.cancelled || isAborted(signal)) {
            return formManagerResult({
                request, lifecycleState: MLC.CANCELLED, outcome: MOUTCOME.CANCELLED,
                actionIntentId: intent.intentId, authorityEvidence,
                detail: "cancelled before dispatch",
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.REQUEST_CANCELLED
            });
        }
        entry.lifecycle = MLC.DISPATCHED;
        let executionResult = null;
        try {
            executionResult = await capturedLane3.execute({
                intent,
                authSession: session,
                parameters: proposal.arguments ?? {}
            });
        } catch (e) {
            return formManagerResult({
                request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.FAILED,
                actionIntentId: intent.intentId, authorityEvidence,
                detail: `actuation dispatch failed: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.ACTUATION_REJECTED
            });
        }
        const executionId = executionResult?.executionId ?? null;

        // ---- 8. OUTCOME MAPPING (uniform; ambiguity preserved) -------------
        // Lane 3 TIMED_OUT != FAILED "no side effect"; CANCELLED-after-dispatch
        // preserves ambiguity.
        if (executionResult.state !== RESULT_STATE_L3.EXECUTED) {
            const outcome = outcomeForExecution(executionResult.state);
            const lifecycleState = executionResult.state === RESULT_STATE_L3.TIMED_OUT
                ? MLC.INCONCLUSIVE
                : executionResult.state === RESULT_STATE_L3.CANCELLED
                    ? MLC.CANCELLED : MLC.FAILED;
            return formManagerResult({
                request, lifecycleState, outcome,
                actionIntentId: intent.intentId, authorityEvidence,
                executionId,
                detail: executionResult.state === RESULT_STATE_L3.TIMED_OUT
                    ? "actuation timed out; effect ambiguity preserved"
                    : `actuation did not complete (${executionResult.state})`,
                startedAtMs, completedAtMs: now(),
                errorReason: executionResult.state === RESULT_STATE_L3.TIMED_OUT
                    ? MREASONS.VERIFICATION_TIMED_OUT
                    : MREASONS.ACTUATION_REJECTED
            });
        }

        // ---- 9. LANE 4 VERIFICATION (canonical facade only) -----------------
        entry.lifecycle = MLC.VERIFYING;
        let verification = null;
        try {
            verification = await capturedLane4.verify({
                executionResult,
                expectedPostcondition: (request.requestedOperation?.expectedPostcondition) ?? (proposal.expectedPostcondition) ?? undefined
            });
        } catch (e) {
            // Verification could not run (e.g. no verifier registered): the
            // actuator-reported EXECUTED state stands as EXECUTED_UNVERIFIED —
            // NEVER as verified success.
            return formManagerResult({
                request, lifecycleState: MLC.EXECUTED, outcome: MOUTCOME.EXECUTED_UNVERIFIED,
                actionIntentId: intent.intentId, authorityEvidence, executionId,
                detail: `actuator reported completion; verification unavailable (${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)})`,
                startedAtMs, completedAtMs: now(),
                errorReason: MREASONS.VERIFICATION_ERROR
            });
        }

        const outcomeV = outcomeForVerification(verification.verificationState);
        const lifecycleForVerification = verification.verificationState === VSTATE_L4.VERIFIED_SUCCESS
            ? MLC.VERIFIED
            : verification.verificationState === VSTATE_L4.VERIFIED_FAILURE
                ? MLC.VERIFIED
                : verification.verificationState === VSTATE_L4.TIMED_OUT
                    ? MLC.INCONCLUSIVE
                    : verification.verificationState === VSTATE_L4.INCONCLUSIVE
                        ? MLC.INCONCLUSIVE
                        : MLC.FAILED;

        // ---- 10. COMPENSATION ROUTING (through Lane 4 facade ONLY) ---------
        // VERIFIED_FAILURE may indicate a compensable condition. The Manager
        // NEVER calls a compensator directly: it requests compensation via
        // the Lane 4 facade, which forms a fresh canonical action (fresh Lane
        // 2 authority → Lane 3 → Lane 4 verification).
        if (verification.verificationState === VSTATE_L4.VERIFIED_FAILURE &&
            request.requestedOperation?.compensationPolicy?.attempt === true) {
            entry.lifecycle = MLC.COMPENSATING;
            try {
                const compensation = await capturedLane4.compensate({
                    verification,
                    capabilityId: request.requestedOperation.compensationPolicy.capabilityId,
                    operation: request.requestedOperation.compensationPolicy.operation,
                    principal,
                    scope: intent.scope ?? [],
                    parameters: request.requestedOperation.compensationPolicy.parameters ?? {},
                    reason: `compensation for manager request ${request.requestId}`
                });
                const compOutcome = compensation.state === "COMPENSATION_EXECUTED"
                    ? MOUTCOME.EXECUTED_UNVERIFIED   // COMPENSATION_EXECUTED != RESTORED
                    : MOUTCOME.FAILED;
                const compLifecycle = compensation.state === "COMPENSATION_EXECUTED"
                    ? MLC.COMPENSATING
                    : MLC.FAILED;
                return formManagerResult({
                    request, lifecycleState: compLifecycle, outcome: compOutcome,
                    actionIntentId: intent.intentId, authorityEvidence, executionId,
                    verificationId: verification.verificationId,
                    compensationId: compensation.compensationId,
                    evidenceSummary: { verificationState: verification.verificationState, compensationState: compensation.state },
                    detail: compensation.state === "COMPENSATION_EXECUTED"
                        ? "verification failed; compensation action executed through the canonical fabric — restoration NOT claimed until a fresh verification succeeds"
                        : "verification failed; compensation did not execute",
                    startedAtMs, completedAtMs: now(),
                    errorReason: compensation.state === "COMPENSATION_EXECUTED"
                        ? "" : MREASONS.COMPENSATION_FAILED
                });
            } catch (e) {
                return formManagerResult({
                    request, lifecycleState: MLC.FAILED, outcome: MOUTCOME.FAILED,
                    actionIntentId: intent.intentId, authorityEvidence, executionId,
                    verificationId: verification.verificationId,
                    detail: `compensation not indicated/failed: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                    startedAtMs, completedAtMs: now(),
                    errorReason: MREASONS.COMPENSATION_NOT_INDICATED
                });
            }
        }

        // ---- 11. UNIFIED RESULT --------------------------------------------
        return formManagerResult({
            request, lifecycleState: lifecycleForVerification, outcome: outcomeV,
            actionIntentId: intent.intentId, authorityEvidence, executionId,
            verificationId: verification.verificationId,
            evidenceSummary: { verificationState: verification.verificationState },
            detail: verification.verificationState === VSTATE_L4.VERIFIED_SUCCESS
                ? "action verified against the expected postcondition"
                : verification.verificationState === VSTATE_L4.VERIFIED_FAILURE
                    ? "action executed but the expected postcondition did not hold"
                    : verification.verificationState === VSTATE_L4.INCONCLUSIVE
                        ? "action result could not be verified (ambiguity preserved)"
                        : verification.verificationState === VSTATE_L4.TIMED_OUT
                            ? "verification timed out; ambiguity preserved"
                            : "verification infrastructure error",
            startedAtMs, completedAtMs: now(),
            errorReason: outcomeV === MOUTCOME.COMPLETED ? "" : (
                verification.verificationState === VSTATE_L4.INCONCLUSIVE ? MREASONS.VERIFICATION_INCONCLUSIVE
                    : verification.verificationState === VSTATE_L4.TIMED_OUT ? MREASONS.VERIFICATION_TIMED_OUT
                        : verification.verificationState === VSTATE_L4.ERROR ? MREASONS.VERIFICATION_ERROR
                            : MREASONS.ACTUATION_REJECTED)
        });
    }

    function isAborted(signal) {
        return Boolean(signal && typeof signal === "object" && signal.aborted === true);
    }

    // ---- cancel(): cooperative lifecycle cancellation -----------------------
    function cancel(requestOrId) {
        const id = (requestOrId !== null && typeof requestOrId === "object")
            ? String(requestOrId.correlationId ?? "")
            : String(requestOrId ?? "");
        const entry = inFlightByCorrelation.get(id);
        if (!entry) return false;
        entry.cancelled = true;
        return true;
    }

    return Object.freeze({
        // least-privilege downstream surface
        handle,
        cancel,

        // PURE brand-recognition predicates — BRAND-FIRST, per-composition:
        // closure-only WeakSet membership decides before any property read.
        isCanonicalManagerRequest(value) {
            if (value === null || typeof value !== "object") return false;
            if (!mRequestBrandSet.has(value)) return false;
            return true;
        },
        isCanonicalManagerResult(value) {
            if (value === null || typeof value !== "object") return false;
            if (!mResultBrandSet.has(value)) return false;
            return true;
        }
    });
}

module.exports = { createDamarManagerComposition };
