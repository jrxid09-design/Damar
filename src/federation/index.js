"use strict";

/**
 * WAVE 6 L4 — public surface (External Capability, MCP & Skill Federation).
 */

const { ExternalCapabilityFederation, LIFECYCLE, TRANSITIONS, INSPECTION_RULES } = require("./federation");

module.exports = Object.freeze({
    ExternalCapabilityFederation, LIFECYCLE, TRANSITIONS, INSPECTION_RULES,
    laws: Object.freeze({
        SKILL_DISCOVERY_NOT_SKILL_ENABLEMENT: true,
        MCP_DISCOVERY_NOT_CAPABILITY_ENABLEMENT: true,
        PLUGIN_INSTALLATION_NOT_EXECUTION_AUTHORITY: true,
        PANDAWA_RECOMMENDATION_NOT_INSTALL_AUTHORITY: true,
        SKILL_NOT_CAPABILITY: true
    })
});
