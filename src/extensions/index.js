"use strict";

/**
 * EXTENSION KERNEL V1 — public surface.
 *
 * CORE + OPTIONAL CAPABILITIES: this kernel is the canonical foundation for
 * extensions (Home Assistant, OSINT, MCP, device providers, community
 * extensions, ...). V1 builds the kernel only; no legacy integration is
 * migrated and nothing here executes extension code.
 *
 * Laws (enforced structurally — this domain imports no Authority mutators,
 * no tool executors, no process/network facilities):
 *   Installed != Enabled          Enabled != Healthy
 *   Healthy != Authorized         Advertised != Granted
 *   Extension != Authority        Extension != Core
 *   Manifest claim != trusted permission
 *   Discovery != execution        Configuration != authority
 */

const { ExtensionKernelError, REASONS } = require("./errors");
const ids = require("./ids");
const semver = require("./semver");
const { parseExtensionManifest, MANIFEST_SCHEMA_VERSION, BOUNDS } = require("./manifest");
const lifecycle = require("./lifecycle");
const health = require("./health");
const dependencies = require("./dependencies");
const { ExtensionRegistry, DEFAULTS } = require("./registry");
const discovery = require("./discovery");

module.exports = {
    // core types
    ExtensionRegistry,
    parseExtensionManifest,
    MANIFEST_SCHEMA_VERSION,
    MANIFEST_BOUNDS: BOUNDS,
    REGISTRY_DEFAULTS: DEFAULTS,

    // contracts / read-models
    lifecycle,
    health,
    dependencies,
    discovery,
    ids,
    semver,

    // error contract
    ExtensionKernelError,
    REASONS
};
