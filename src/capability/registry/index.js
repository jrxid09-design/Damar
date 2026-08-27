"use strict";

/**
 * CAPABILITY REGISTRY V1 — public surface.
 *
 * DESCRIPTIVE ONLY. This module answers: what capabilities exist or may
 * exist, where they come from, what they depend on, and whether they are
 * currently available. It NEVER answers authorization, execution, or
 * admission questions — those belong to Authority, later Wave-4 lanes, and
 * the Governor respectively.
 *
 * The public surface contains NO execution verbs (execute/invoke/run/
 * dispatch/actuate/spawn/shell/callTool/performAction) and NO authority
 * verbs (grant/authorize/approve/ratify/delegate/elevate/trustAsAuthority).
 *
 * This module imports no Authority, Governor, tool, or process/network code.
 */

const { CapabilityRegistry, DEFAULTS } = require("./registry");
const { parseCapabilityDescriptor, parseObservationMetadata, DESCRIPTOR_SCHEMA_VERSION, BOUNDS: DESCRIPTOR_BOUNDS } = require("./descriptor");
const { CapabilityRegistryError, REASONS } = require("./errors");
const { KINDS, canonicalKind } = require("./kinds");
const { AVAILABILITY, canonicalAvailability } = require("./availability");
const { canonicalCapabilityId, canonicalProvenance, isValidCapabilityId, isValidProvenance, AUTHORITY_VOCABULARY } = require("./ids");
const { GRAPH_BOUNDS } = require("./graph");

/**
 * NOTE: the registrar factory (`createCapabilityRegistrarFactory`) and the
 * identity-establishment function (`establishIdentity`) are INTENTIONALLY not
 * re-exported here. They are the runtime-owned composition-root boundary and
 * live in `./registry`; trusted runtime composition imports them directly.
 * The public surface exposes NO registrar mint surface and NO mint token.
 */
module.exports = {
    CapabilityRegistry,
    REGISTRY_DEFAULTS: DEFAULTS,
    parseCapabilityDescriptor,
    parseObservationMetadata,
    DESCRIPTOR_SCHEMA_VERSION,
    DESCRIPTOR_BOUNDS,
    GRAPH_BOUNDS,
    CapabilityRegistryError,
    REASONS,
    KINDS,
    AVAILABILITY,
    canonicalKind,
    canonicalAvailability,
    canonicalCapabilityId,
    canonicalProvenance,
    isValidCapabilityId,
    isValidProvenance,
    AUTHORITY_VOCABULARY
};
