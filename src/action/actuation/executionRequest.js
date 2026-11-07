"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — execution request vocabulary (Lane 3, FIRST
 * targeted repair: inert bounds ONLY — no request former).
 *
 * An ExecutionRequest is the IMMUTABLE canonical binding between a (revalidated
 * at-formation) canonical ActionIntent + authenticated principal + capability
 * incarnation + canonical scope + authority generation and the actuation that
 * will (if dispatch survives pre-actuation revalidation) be performed.
 *
 * CORE LAW: AUTHORITY DECISION IS HISTORICAL EVIDENCE, NOT A BEARER TOKEN.
 * The ExecutionRequest is bound at formation time to the canonical truth
 * OBSERVED at formation; before dispatch the dispatcher MUST revalidate that
 * the same canonical truth still holds. The executionId is NOT a bearer
 * execution token.
 *
 * FIRST TARGETED REPAIR: `formExecutionRequest` is NOT exported. The request
 * former implementation lives ONLY inside the trusted bootstrap's private
 * composition closure (src/action/bootstrap.js), exactly like every other
 * privileged Lane 3 constructor. This module exports ONLY the inert schema
 * version + bounds vocabulary (for downstream recognition), never construction.
 *
 * The canonical request SCHEMA (informational, for consumers):
 *
 *   {
 *     schemaVersion: 1,
 *     executionId, intentId, capabilityId, capabilityIncarnationId,
 *     operation, principal, scope[], authorityGeneration,
 *     admittedAtMs, requestedAtMs, parameters{}, metadata{}
 *   }
 *
 * Hostile-input boundaries enforced by the trusted former: detached/bounded
 * payloads, no functions/symbols/accessors/class instances/cycles, no
 * prototype pollution, authority-shaped metadata keys rejected recursively.
 */

const REQUEST_SCHEMA_VERSION = 1;

const BOUNDS = Object.freeze({
    MAX_EXECUTION_ID_CHARS: 128,
    MAX_INTENT_ID_CHARS: 128,
    MAX_CAPABILITY_ID_CHARS: 256,
    MAX_OPERATION_CHARS: 256,
    MAX_PRINCIPAL_CHARS: 128,
    MAX_PARAMETERS_BYTES: 64 * 1024,
    MAX_PARAMETERS_KEYS: 64,
    MAX_METADATA_NODES: 512,
    MAX_METADATA_DEPTH: 8,
    MAX_METADATA_KEY_CHARS: 128,
    MAX_METADATA_STRING_CHARS: 256,
    GLOBAL_MAX_ARRAY_LENGTH: 1024
});

module.exports = {
    // inert frozen vocabulary ONLY
    REQUEST_SCHEMA_VERSION,
    BOUNDS
};
