"use strict";

/* Registration and verification glue only. Host I/O is owned by the Lane 3
 * driver module outside src/action; this module creates no private runtime. */
const crypto = require("node:crypto");
const path = require("node:path");
const drivers = require("../../services/embodimentDrivers");
const { MEDIA, DESKTOP, BACKUP, KALI, NOTIFICATION, ML, CHECKPOINT, MCP, OPENCODE, IMMICH, SECURITY, parametersDigest, remember, requireObject, stringArg, videoId, shellCommand } = drivers;
const TERMINAL = "damar.terminal";
const TERMINAL_OPS = Object.freeze(["list", "run", "restart", "read", "stop"]);
const MEDIA_OPS = Object.freeze(["resolve", "download"]);
const DESKTOP_OPS = Object.freeze(["openApp", "fillForm", "typeText", "pressKey", "listWindows", "moveMouse", "click"]);
const BACKUP_OPS = Object.freeze(["copy"]);
const KALI_OPS = Object.freeze(["run", "which", "tools", "status"]);
const NOTIFICATION_OPS = Object.freeze(["broadcast"]);
const ML_OPS = Object.freeze(["probe", "run"]);
const CHECKPOINT_OPS = Object.freeze(["create"]);
const MCP_OPS = Object.freeze(["start", "call"]);
const OPENCODE_OPS = Object.freeze(["run"]);
const IMMICH_OPS = Object.freeze(["status", "up", "down"]);
const SECURITY_OPS = Object.freeze(["scanSecrets", "auditCode", "auditDeps"]);
function descriptor(id, operations, description) { return Object.freeze({ schemaVersion: 1, id, kind: "system", provider: "core", operations: Object.freeze([...operations]), requirements: Object.freeze([]), effects: Object.freeze([id]), description }); }
const DESCRIPTORS = Object.freeze([descriptor(TERMINAL, TERMINAL_OPS, "Governed persistent terminal operations."), descriptor(MEDIA, MEDIA_OPS, "Governed media resolution and download."), descriptor(DESKTOP, DESKTOP_OPS, "Governed fixed-allowlist desktop effects."), descriptor(BACKUP, BACKUP_OPS, "Governed non-destructive source-to-destination backup copy."), descriptor(KALI, KALI_OPS, "Governed caller-defined Kali shell execution with explicit binding."), descriptor(ML, ML_OPS, "Governed ML environment probes and experiments."), descriptor(CHECKPOINT, CHECKPOINT_OPS, "Governed recovery checkpoint creation."), descriptor(MCP, MCP_OPS, "Governed external MCP process and tool calls." ), descriptor(OPENCODE, OPENCODE_OPS, "Governed external coding-agent execution." ), descriptor(IMMICH, IMMICH_OPS, "Governed Immich container lifecycle and status."), descriptor(SECURITY, SECURITY_OPS, "Governed read-only repository security audits."), descriptor(NOTIFICATION, NOTIFICATION_OPS, "Governed autonomous WhatsApp notification broadcast.")]);

function wireEmbodimentCapabilities({ registrar } = {}) {
    if (!registrar || typeof registrar.register !== "function") throw new TypeError("canonical capability registrar required");
    const record = {};
    for (const d of DESCRIPTORS) { const r = registrar.register(JSON.stringify(d)); if (!r || typeof r.incarnationId !== "string") throw new Error(`canonical registration failed for ${d.id}`); record[d.id] = Object.freeze({ id: d.id, incarnationId: r.incarnationId }); }
    const scope = (id, op) => ({ resolver: (args) => {
        requireObject(args, "action arguments");
        if (id === TERMINAL) {
            const purpose = stringArg(args, "purpose", 128);
            if (op === "list") return Object.freeze(["terminal:list"]);
            const command = op === "run" || op === "restart" ? stringArg(args, "command", 4096) : "";
            return Object.freeze([`terminal:purpose:${purpose}`, ...(command ? [`command-sha256:${crypto.createHash("sha256").update(command).digest("hex")}`] : [])]);
        }
        if (id === MEDIA) return Object.freeze([`video:${videoId(args)}`]);
        if (id === BACKUP) return Object.freeze([`source:${path.normalize(stringArg({ value: args.source }, "value", 1024))}`, `dest:${path.normalize(stringArg({ value: args.dest }, "value", 1024))}`]);
        if (id === KALI) { if (op === "status" || op === "tools") return Object.freeze([`kali:${op}`]); if (op === "which") return Object.freeze([`tool:${stringArg(args, "tool", 128).replace(/[^\w.-]/g, "")}`]); const request = shellCommand(args); return Object.freeze([`command-sha256:${crypto.createHash("sha256").update(request.command).digest("hex")}`, `cwd:${request.cwd ?? "<default>"}`, `timeout:${request.timeout}`, `runtime:${process.platform}`, `environment:${process.env.DAMAR_KALI_DISTRO || "<detected>"}`]); }
        if (id === NOTIFICATION) return Object.freeze(["channel:whatsapp", `text-sha256:${parametersDigest({ text: stringArg(args, "text", 4096) })}`]);
        if (id === ML) return Object.freeze([`ml:${op}`, `parameters-sha256:${parametersDigest(args)}`]);
        if (id === CHECKPOINT) { const scope = stringArg(args, "scope", 32); const target = stringArg(args, "target", 2048); return Object.freeze([`checkpoint-scope:${scope}`, `checkpoint-target:${target}`, `parameters-sha256:${parametersDigest(args)}`]); }
        if (id === MCP) { const serverId = op === "start" ? (args.serverId == null ? "configured" : stringArg(args, "serverId", 128)) : stringArg(args, "serverId", 128); if (op === "start") return Object.freeze([`mcp-server:${serverId}`]); const tool = stringArg(args, "tool", 256); return Object.freeze([`mcp-server:${serverId}`, `mcp-tool:${tool}`, `parameters-sha256:${parametersDigest(args.arguments ?? {})}`]); }
        if (id === OPENCODE) { const instruction = stringArg(args, "instruction", 12000); return Object.freeze([`opencode-instruction-sha256:${crypto.createHash("sha256").update(instruction).digest("hex")}`, `opencode-dir:${String(args.dir ?? process.cwd())}`, `opencode-purpose:${String(args.purpose ?? "forge")}`]); }
        if (id === IMMICH) return Object.freeze([`immich-operation:${op}`]);
        if (id === SECURITY) return Object.freeze([`security-operation:${op}`, `parameters-sha256:${parametersDigest(args)}`]);
        return Object.freeze([`desktop:${op}`, `parameters-sha256:${parametersDigest(args)}`]);
    } });
    const scopeBindings = { [TERMINAL]: {}, [MEDIA]: {}, [DESKTOP]: {}, [BACKUP]: {}, [KALI]: {}, [NOTIFICATION]: {}, [ML]: {}, [CHECKPOINT]: {}, [MCP]: {}, [OPENCODE]: {}, [IMMICH]: {}, [SECURITY]: {} };
    for (const [id, ops] of [[TERMINAL, TERMINAL_OPS], [MEDIA, MEDIA_OPS], [DESKTOP, DESKTOP_OPS], [BACKUP, BACKUP_OPS], [KALI, KALI_OPS], [NOTIFICATION, NOTIFICATION_OPS], [ML, ML_OPS], [CHECKPOINT, CHECKPOINT_OPS], [MCP, MCP_OPS], [OPENCODE, OPENCODE_OPS], [IMMICH, IMMICH_OPS], [SECURITY, SECURITY_OPS]]) { for (const op of ops) scopeBindings[id][op] = scope(id, op).resolver; Object.freeze(scopeBindings[id]); }
    return Object.freeze({ terminal: record[TERMINAL], media: record[MEDIA], desktop: record[DESKTOP], backup: record[BACKUP], kali: record[KALI], notification: record[NOTIFICATION], ml: record[ML], checkpoint: record[CHECKPOINT], mcp: record[MCP], opencode: record[OPENCODE], immich: record[IMMICH], security: record[SECURITY], scopeBindings: Object.freeze(scopeBindings) });
}
function observeEmbodimentAvailability({ registry, wiring, availability = drivers.probeEmbodimentAvailability() } = {}) { if (!registry || typeof registry.observeAvailability !== "function" || !wiring) throw new TypeError("canonical capability registry required"); for (const entry of [wiring.terminal, wiring.media, wiring.desktop, wiring.backup, wiring.kali, wiring.ml, wiring.checkpoint, wiring.immich].filter(Boolean)) { const state = availability[entry.id] === "AVAILABLE" ? "AVAILABLE" : "UNKNOWN"; registry.observeAvailability(entry.id, state, { generation: 1, incarnationId: entry.incarnationId }); } if (wiring.notification) registry.observeAvailability(wiring.notification.id, "AVAILABLE", { generation: 1, incarnationId: wiring.notification.incarnationId }); }
function wireEmbodimentActuators({ actuatorRegistry, wiring } = {}) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function" || !wiring) throw new TypeError("canonical actuator wiring required");
    return Object.freeze([
        actuatorRegistry.register({ capabilityId: TERMINAL, operations: TERMINAL_OPS, capabilityIncarnationId: wiring.terminal.incarnationId, actuatorId: "act-damar-terminal", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.terminalDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: MEDIA, operations: MEDIA_OPS, capabilityIncarnationId: wiring.media.incarnationId, actuatorId: "act-damar-media", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.mediaDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: DESKTOP, operations: DESKTOP_OPS, capabilityIncarnationId: wiring.desktop.incarnationId, actuatorId: "act-damar-desktop", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.desktopDriver({ operation, parameters }); const bound = { ...result, binding: { ...(result.binding ?? {}), parametersDigest: parametersDigest(parameters) } }; remember(executionId, bound); return bound; } }),
        actuatorRegistry.register({ capabilityId: BACKUP, operations: BACKUP_OPS, capabilityIncarnationId: wiring.backup.incarnationId, actuatorId: "act-damar-backup", invoke: async ({ executionId, parameters }) => { const result = await drivers.backupDriver({ parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: KALI, operations: KALI_OPS, capabilityIncarnationId: wiring.kali.incarnationId, actuatorId: "act-damar-kali", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.kaliDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: NOTIFICATION, operations: NOTIFICATION_OPS, capabilityIncarnationId: wiring.notification.incarnationId, actuatorId: "act-damar-whatsapp-notification", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.notificationDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: ML, operations: ML_OPS, capabilityIncarnationId: wiring.ml.incarnationId, actuatorId: "act-damar-ml", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.mlDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: CHECKPOINT, operations: CHECKPOINT_OPS, capabilityIncarnationId: wiring.checkpoint.incarnationId, actuatorId: "act-damar-checkpoint", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.checkpointDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: MCP, operations: MCP_OPS, capabilityIncarnationId: wiring.mcp.incarnationId, actuatorId: "act-damar-mcp", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.mcpDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: OPENCODE, operations: OPENCODE_OPS, capabilityIncarnationId: wiring.opencode.incarnationId, actuatorId: "act-damar-opencode", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.opencodeDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: IMMICH, operations: IMMICH_OPS, capabilityIncarnationId: wiring.immich.incarnationId, actuatorId: "act-damar-immich", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.immichDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: SECURITY, operations: SECURITY_OPS, capabilityIncarnationId: wiring.security.incarnationId, actuatorId: "act-damar-security", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.securityDriver({ operation, parameters }); remember(executionId, result); return result; } })
    ]);
}
function wireEmbodimentVerifiers({ wiring } = {}) {
    if (!wiring) throw new TypeError("canonical verifier wiring required");
    const definition = (capabilityId, operations, entry, observe) => Object.freeze({ capabilityId, operations, capabilityIncarnationId: entry.incarnationId, verifierId: `ver-${capabilityId}`, readiness: "READY", observe });
    return Object.freeze([
        definition(TERMINAL, TERMINAL_OPS, wiring.terminal, (ctx) => { const result = drivers.observation(ctx.executionId); return { operation: ctx.operation, ok: result.ok === true, parametersMatch: ctx.operation === "list" || result.purpose === ctx.parameters?.purpose, verificationClass: result.outcome ?? "unknown" }; }),
        definition(MEDIA, MEDIA_OPS, wiring.media, drivers.verifyMedia),
        definition(DESKTOP, DESKTOP_OPS, wiring.desktop, drivers.verifyDesktop),
        definition(BACKUP, BACKUP_OPS, wiring.backup, drivers.verifyBackup),
        definition(KALI, KALI_OPS, wiring.kali, drivers.verifyKali),
        definition(NOTIFICATION, NOTIFICATION_OPS, wiring.notification, drivers.verifyNotification),
        definition(ML, ML_OPS, wiring.ml, (ctx) => { const result = drivers.observation(ctx.executionId); return { operation: result.operation === ctx.operation, parametersMatch: result.binding?.parametersDigest === parametersDigest(ctx.parameters ?? {}), completed: result.outcome === "EXECUTED" }; }),
        definition(CHECKPOINT, CHECKPOINT_OPS, wiring.checkpoint, (ctx) => { const result = drivers.observation(ctx.executionId); return { operation: result.operation === ctx.operation, parametersMatch: result.binding?.parametersDigest === parametersDigest(ctx.parameters ?? {}), completed: result.outcome === "EXECUTED" }; }),
        definition(MCP, MCP_OPS, wiring.mcp, (ctx) => { const result = drivers.observation(ctx.executionId); return { operation: result.operation === ctx.operation, completed: result.outcome === "EXECUTED" }; }),
        definition(OPENCODE, OPENCODE_OPS, wiring.opencode, (ctx) => { const result = drivers.observation(ctx.executionId); return { operation: result.operation === ctx.operation, parametersMatch: result.binding?.parametersDigest === parametersDigest(ctx.parameters ?? {}), completed: result.outcome === "EXECUTED", outputPresent: typeof result.output === "string" }; }),
        definition(IMMICH, IMMICH_OPS, wiring.immich, (ctx) => { const result = drivers.observation(ctx.executionId); return { operation: result.operation === ctx.operation, completed: result.completed === true, verified: result.outcome === "EXECUTED", uncertain: result.uncertain === true }; }),
        definition(SECURITY, SECURITY_OPS, wiring.security, (ctx) => { const result = drivers.observation(ctx.executionId); return { operation: result.operation === ctx.operation, parametersMatch: result.binding?.project === (ctx.parameters?.project ?? process.cwd()), completed: result.completed === true }; })
    ]);
}
module.exports = Object.freeze({ TERMINAL, MEDIA, DESKTOP, BACKUP, KALI, NOTIFICATION, ML, CHECKPOINT, MCP, OPENCODE, IMMICH, SECURITY, TERMINAL_OPS, MEDIA_OPS, DESKTOP_OPS, BACKUP_OPS, KALI_OPS, NOTIFICATION_OPS, ML_OPS, CHECKPOINT_OPS, MCP_OPS, OPENCODE_OPS, IMMICH_OPS, SECURITY_OPS, DESCRIPTORS, wireEmbodimentCapabilities, observeEmbodimentAvailability, wireEmbodimentActuators, wireEmbodimentVerifiers });
