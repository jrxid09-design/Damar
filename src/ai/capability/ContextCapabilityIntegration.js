"use strict";

const CapabilityIndex = require("../tools/CapabilityIndex");

/**
 * CANONICAL CONTEXT-CAPABILITY INTEGRATION
 *
 * This is a read-only projection over existing runtime sources. It does not
 * register, discover, authorize, or execute anything. AIToolRegistry remains
 * the runtime candidate source; the V1 CapabilityRegistry is joined only when
 * a tool explicitly names its capability id(s) in metadata.
 */

const UNKNOWN = "UNKNOWN";

function asCapabilityIds(tool) {
    const meta = tool?.meta;
    if (!meta || typeof meta !== "object") return [];
    const raw = meta.capabilityIds ?? meta.capabilityId;
    const ids = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    return [...new Set(ids.filter(id => typeof id === "string" && id.trim()).map(id => id.trim()))];
}

function contextTextFrom(contextSelection, messages = []) {
    const selectedMessages = Array.isArray(contextSelection?.messages)
        ? contextSelection.messages : messages;
    const messageText = selectedMessages
        .map(message => typeof message?.content === "string" ? message.content : "")
        .join("\n");
    const systemText = typeof contextSelection?.systemContent === "string"
        ? contextSelection.systemContent : "";
    return `${systemText}\n${messageText}`.trim();
}

function contextConstraints(tool) {
    const raw = tool?.meta?.contextConstraints;
    if (!raw || typeof raw !== "object") return { requires: [], excludes: [] };
    const words = value => (Array.isArray(value) ? value : [])
        .filter(item => typeof item === "string" && item.trim())
        .map(item => item.trim().toLowerCase());
    return { requires: words(raw.requires), excludes: words(raw.excludes) };
}

function evaluateContextConstraint(tool, contextText) {
    const constraints = contextConstraints(tool);
    const text = String(contextText ?? "").toLowerCase();
    const missing = constraints.requires.filter(term => !text.includes(term));
    const incompatible = constraints.excludes.filter(term => text.includes(term));
    if (missing.length) return {
        relevant: false,
        reason: `required-context-missing:${missing.join(",")}`
    };
    if (incompatible.length) return {
        relevant: false,
        reason: `context-incompatible:${incompatible.join(",")}`
    };
    return { relevant: true, reason: "context-applicable" };
}

function registryEvidence(tool, capabilityRegistry) {
    const ids = asCapabilityIds(tool);
    if (ids.length === 0) {
        return {
            capabilityIds: [],
            registered: true,
            availability: UNKNOWN,
            runtimeReachable: true,
            dependencyStatus: UNKNOWN,
            available: true,
            reachable: true,
            reasons: ["aitool-registry-snapshot", "no-explicit-capability-join"]
        };
    }

    if (!capabilityRegistry || typeof capabilityRegistry.get !== "function") {
        return {
            capabilityIds: ids,
            registered: UNKNOWN,
            availability: UNKNOWN,
            runtimeReachable: UNKNOWN,
            dependencyStatus: UNKNOWN,
            available: false,
            reachable: false,
            reasons: ["capability-registry-not-provided"]
        };
    }

    const records = ids.map(id => ({ id, record: capabilityRegistry.get(id) }));
    const missing = records.filter(item => !item.record).map(item => item.id);
    const known = records.filter(item => item.record).map(item => item.record);
    const availability = known.length === 0 ? UNKNOWN
        : known.some(record => record.availability === "UNAVAILABLE") ? "UNAVAILABLE"
        : known.some(record => record.availability === "DEGRADED") ? "DEGRADED"
        : known.every(record => record.availability === "AVAILABLE") ? "AVAILABLE"
        : UNKNOWN;
    const dependencyReports = known.map(record => {
        if (typeof capabilityRegistry.resolveDependencyStatus !== "function") return null;
        return capabilityRegistry.resolveDependencyStatus(record.id);
    }).filter(Boolean);
    const dependencyStatus = dependencyReports.length === 0 ? UNKNOWN
        : dependencyReports.every(report => report.ok) ? "SATISFIED" : "MISSING";
    const reasons = [];
    if (missing.length) reasons.push(`unregistered:${missing.join(",")}`);
    if (availability === "UNAVAILABLE") reasons.push("capability-unavailable");
    if (availability === UNKNOWN) reasons.push("capability-availability-unknown");
    if (dependencyStatus === "MISSING") reasons.push("dependency-missing");
    if (dependencyStatus === UNKNOWN) reasons.push("dependency-status-unknown");
    const available = missing.length === 0 && availability === "AVAILABLE" && dependencyStatus !== "MISSING";
    return {
        capabilityIds: ids,
        registered: missing.length === 0,
        availability,
        runtimeReachable: available,
        dependencyStatus,
        available,
        reachable: available,
        reasons: reasons.length ? reasons : ["capability-available"]
    };
}

function project({ tools = [], messages = [], contextSelection = null, capabilityRegistry = null } = {}) {
    const contextText = contextTextFrom(contextSelection, messages);
    const items = CapabilityIndex.build(tools).map(record => {
        const evidence = registryEvidence(record.raw, capabilityRegistry);
        const contextual = evaluateContextConstraint(record.raw, contextText);
        const reasons = [...evidence.reasons, contextual.reason];
        return Object.freeze({
            name: record.name,
            source: record.source,
            provider: record.provider,
            codeExists: true,
            registered: evidence.registered,
            composed: true,
            runtimeReachable: evidence.runtimeReachable,
            userReachable: UNKNOWN,
            governed: UNKNOWN,
            tested: UNKNOWN,
            certified: UNKNOWN,
            relevant: contextual.relevant,
            available: evidence.available,
            availability: evidence.availability,
            capabilityIds: evidence.capabilityIds,
            dependencyStatus: evidence.dependencyStatus,
            reasons,
            contextProvenance: contextSelection?.diagnostics ? "Context Pipeline output" : "assembled runtime messages"
        });
    });

    const excluded = new Set(items
        .filter(item => !item.available || !item.relevant)
        .map(item => item.name));
    return Object.freeze({
        contextText,
        candidates: Object.freeze(tools.filter(tool => !excluded.has(tool.name))),
        items: Object.freeze(items),
        excluded: Object.freeze([...excluded].sort()),
        authorityGranted: false,
        reasons: Object.freeze(Object.fromEntries(items.map(item => [item.name, item.reasons])))
    });
}

module.exports = { project, contextTextFrom, contextConstraints, evaluateContextConstraint, asCapabilityIds, UNKNOWN };
