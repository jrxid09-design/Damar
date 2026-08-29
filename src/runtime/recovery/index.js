"use strict";

/**
 * Damar Recovery Capsule V0 — RECOVERY SUBSTRATE.
 *
 * CONSTITUTIONAL INVARIANT: RECOVERY != AUTHORITY.
 * A capsule may preserve EVIDENCE that authority existed; it can never
 * create, widen, or reactivate authority, and RESTORE is never an
 * authority decision. Authority restoration will be delegated to the
 * canonical Authority subsystem after integration; until then privileged
 * state is opaque/restricted data.
 */

const ids = require("./ids");
const { canonicalJson, canonicalBytes, CanonicalizationError } = require("./canonicalJson");
const digest = require("./digest");
const config = require("./config");
const diagnostics = require("./diagnostics");
const classification = require("./classification");
const provider = require("./provider");
const manifest = require("./manifest");
const { validateCapsule } = require("./validation");
const checkpoint = require("./checkpoint");
const { analyzeLineage } = require("./lineage");
const selector = require("./selector");
const restore = require("./restore");
const { GenerationLedger } = require("./generation");
const { RecoveryStatusTracker } = require("./status");
const ports = require("./ports");

module.exports = Object.freeze({
    ids,
    canonicalJson,
    canonicalBytes,
    CanonicalizationError,
    digest,
    config,
    diagnostics,
    classification,
    provider,
    manifest,
    validateCapsule,
    checkpoint,
    analyzeLineage,
    selector,
    restore,
    GenerationLedger,
    RecoveryStatusTracker,
    ports
});
