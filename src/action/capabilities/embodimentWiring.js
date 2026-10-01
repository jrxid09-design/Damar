"use strict";

/* Registration and verification glue only. Host I/O is owned by the Lane 3
 * driver module outside src/action; this module creates no private runtime. */
const crypto = require("node:crypto");
const path = require("node:path");
const drivers = require("../../services/embodimentDrivers");
const { MEDIA, DESKTOP, BACKUP, KALI, NOTIFICATION, parametersDigest, remember, requireObject, stringArg, videoId, shellCommand } = drivers;
const MEDIA_OPS = Object.freeze(["resolve", "download"]);
const DESKTOP_OPS = Object.freeze(["openApp", "fillForm", "typeText", "pressKey", "listWindows", "moveMouse", "click"]);
const BACKUP_OPS = Object.freeze(["copy"]);
const KALI_OPS = Object.freeze(["run", "which", "tools", "status"]);
const NOTIFICATION_OPS = Object.freeze(["broadcast"]);
function descriptor(id, operations, description) { return Object.freeze({ schemaVersion: 1, id, kind: "system", provider: "core", operations: Object.freeze([...operations]), requirements: Object.freeze([]), effects: Object.freeze([id]), description }); }
const DESCRIPTORS = Object.freeze([descriptor(MEDIA, MEDIA_OPS, "Governed media resolution and download."), descriptor(DESKTOP, DESKTOP_OPS, "Governed fixed-allowlist desktop effects."), descriptor(BACKUP, BACKUP_OPS, "Governed non-destructive source-to-destination backup copy."), descriptor(KALI, KALI_OPS, "Governed caller-defined Kali shell execution with explicit binding."), descriptor(NOTIFICATION, NOTIFICATION_OPS, "Governed autonomous WhatsApp notification broadcast.")]);

function wireEmbodimentCapabilities({ registrar } = {}) {
    if (!registrar || typeof registrar.register !== "function") throw new TypeError("canonical capability registrar required");
    const record = {};
    for (const d of DESCRIPTORS) { const r = registrar.register(JSON.stringify(d)); if (!r || typeof r.incarnationId !== "string") throw new Error(`canonical registration failed for ${d.id}`); record[d.id] = Object.freeze({ id: d.id, incarnationId: r.incarnationId }); }
    const scope = (id, op) => ({ resolver: (args) => {
        requireObject(args, "action arguments");
        if (id === MEDIA) return Object.freeze([`video:${videoId(args)}`]);
        if (id === BACKUP) return Object.freeze([`source:${path.normalize(stringArg({ value: args.source }, "value", 1024))}`, `dest:${path.normalize(stringArg({ value: args.dest }, "value", 1024))}`]);
        if (id === KALI) { if (op === "status" || op === "tools") return Object.freeze([`kali:${op}`]); if (op === "which") return Object.freeze([`tool:${stringArg(args, "tool", 128).replace(/[^\w.-]/g, "")}`]); const request = shellCommand(args); return Object.freeze([`command-sha256:${crypto.createHash("sha256").update(request.command).digest("hex")}`, `cwd:${request.cwd ?? "<default>"}`, `timeout:${request.timeout}`, `runtime:${process.platform}`, `environment:${process.env.DAMAR_KALI_DISTRO || "<detected>"}`]); }
        if (id === NOTIFICATION) return Object.freeze(["channel:whatsapp", `text-sha256:${parametersDigest({ text: stringArg(args, "text", 4096) })}`]);
        return Object.freeze([`desktop:${op}`, `parameters-sha256:${parametersDigest(args)}`]);
    } });
    const scopeBindings = { [MEDIA]: {}, [DESKTOP]: {}, [BACKUP]: {}, [KALI]: {}, [NOTIFICATION]: {} };
    for (const [id, ops] of [[MEDIA, MEDIA_OPS], [DESKTOP, DESKTOP_OPS], [BACKUP, BACKUP_OPS], [KALI, KALI_OPS], [NOTIFICATION, NOTIFICATION_OPS]]) { for (const op of ops) scopeBindings[id][op] = scope(id, op).resolver; Object.freeze(scopeBindings[id]); }
    return Object.freeze({ media: record[MEDIA], desktop: record[DESKTOP], backup: record[BACKUP], kali: record[KALI], notification: record[NOTIFICATION], scopeBindings: Object.freeze(scopeBindings) });
}
function observeEmbodimentAvailability({ registry, wiring, availability = drivers.probeEmbodimentAvailability() } = {}) { if (!registry || typeof registry.observeAvailability !== "function" || !wiring) throw new TypeError("canonical capability registry required"); for (const entry of [wiring.media, wiring.desktop, wiring.backup, wiring.kali]) { const state = availability[entry.id] === "AVAILABLE" ? "AVAILABLE" : "UNKNOWN"; registry.observeAvailability(entry.id, state, { generation: 1, incarnationId: entry.incarnationId }); } if (wiring.notification) registry.observeAvailability(wiring.notification.id, "AVAILABLE", { generation: 1, incarnationId: wiring.notification.incarnationId }); }
function wireEmbodimentActuators({ actuatorRegistry, wiring } = {}) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function" || !wiring) throw new TypeError("canonical actuator wiring required");
    return Object.freeze([
        actuatorRegistry.register({ capabilityId: MEDIA, operations: MEDIA_OPS, capabilityIncarnationId: wiring.media.incarnationId, actuatorId: "act-damar-media", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.mediaDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: DESKTOP, operations: DESKTOP_OPS, capabilityIncarnationId: wiring.desktop.incarnationId, actuatorId: "act-damar-desktop", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.desktopDriver({ operation, parameters }); const bound = { ...result, binding: { ...(result.binding ?? {}), parametersDigest: parametersDigest(parameters) } }; remember(executionId, bound); return bound; } }),
        actuatorRegistry.register({ capabilityId: BACKUP, operations: BACKUP_OPS, capabilityIncarnationId: wiring.backup.incarnationId, actuatorId: "act-damar-backup", invoke: async ({ executionId, parameters }) => { const result = await drivers.backupDriver({ parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: KALI, operations: KALI_OPS, capabilityIncarnationId: wiring.kali.incarnationId, actuatorId: "act-damar-kali", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.kaliDriver({ operation, parameters }); remember(executionId, result); return result; } }),
        actuatorRegistry.register({ capabilityId: NOTIFICATION, operations: NOTIFICATION_OPS, capabilityIncarnationId: wiring.notification.incarnationId, actuatorId: "act-damar-whatsapp-notification", invoke: async ({ executionId, operation, parameters }) => { const result = await drivers.notificationDriver({ operation, parameters }); remember(executionId, result); return result; } })
    ]);
}
function wireEmbodimentVerifiers({ wiring } = {}) {
    if (!wiring) throw new TypeError("canonical verifier wiring required");
    const definition = (capabilityId, operations, entry, observe) => Object.freeze({ capabilityId, operations, capabilityIncarnationId: entry.incarnationId, verifierId: `ver-${capabilityId}`, readiness: "READY", observe });
    return Object.freeze([
        definition(MEDIA, MEDIA_OPS, wiring.media, drivers.verifyMedia),
        definition(DESKTOP, DESKTOP_OPS, wiring.desktop, drivers.verifyDesktop),
        definition(BACKUP, BACKUP_OPS, wiring.backup, drivers.verifyBackup),
        definition(KALI, KALI_OPS, wiring.kali, drivers.verifyKali),
        definition(NOTIFICATION, NOTIFICATION_OPS, wiring.notification, drivers.verifyNotification)
    ]);
}
module.exports = Object.freeze({ MEDIA, DESKTOP, BACKUP, KALI, NOTIFICATION, MEDIA_OPS, DESKTOP_OPS, BACKUP_OPS, KALI_OPS, NOTIFICATION_OPS, DESCRIPTORS, wireEmbodimentCapabilities, observeEmbodimentAvailability, wireEmbodimentActuators, wireEmbodimentVerifiers });
