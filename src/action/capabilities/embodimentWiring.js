"use strict";

/*
 * Canonical embodiment wiring for the recovery batches.
 *
 * This module is deliberately a wiring/driver module, not a runtime factory.
 * It is called only from action/bootstrap.js while the canonical Lane 2
 * registry, Lane 3 actuator registry, and Lane 4 verifier registry are being
 * composed.  It never creates a Manager, authority store, replay ledger, or
 * CanonicalCapabilityExecution instance of its own.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const pexec = promisify(execFile);

const MEDIA = "damar.media";
const DESKTOP = "damar.desktop";
const BACKUP = "damar.backup";

const MEDIA_OPS = Object.freeze(["resolve", "download"]);
const DESKTOP_OPS = Object.freeze(["openApp", "fillForm", "typeText", "pressKey", "listWindows", "moveMouse", "click"]);
const BACKUP_OPS = Object.freeze(["copy"]);

const DESKTOP_APPS = Object.freeze({
    notepad: "notepad.exe",
    calculator: "calc.exe",
    browser: "msedge.exe",
    edge: "msedge.exe",
    chrome: "chrome.exe"
});

const CACHE_DIR = path.join(os.tmpdir(), "damar-media");
const observations = new Map();

function remember(executionId, result) {
    if (typeof executionId !== "string" || executionId.length === 0) return;
    if (observations.size >= 4096) observations.delete(observations.keys().next().value);
    observations.set(executionId, result);
}

function descriptor(id, operations, description) {
    return Object.freeze({
        schemaVersion: 1,
        id,
        kind: "system",
        provider: "core",
        operations: Object.freeze([...operations]),
        requirements: Object.freeze([]),
        effects: Object.freeze([id]),
        description
    });
}

const DESCRIPTORS = Object.freeze([
    descriptor(MEDIA, MEDIA_OPS, "Governed media resolution and download."),
    descriptor(DESKTOP, DESKTOP_OPS, "Governed fixed-allowlist desktop effects."),
    descriptor(BACKUP, BACKUP_OPS, "Governed non-destructive source-to-destination backup copy.")
]);

function requireObject(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
}

function stringArg(parameters, key, max = 4096) {
    const value = parameters?.[key];
    if (typeof value !== "string" || value.trim() === "" || value.length > max) {
        throw new Error(`invalid ${key}`);
    }
    return value;
}

function finiteCoord(parameters, key) {
    const value = Number(parameters?.[key]);
    if (!Number.isFinite(value) || value < -100000 || value > 100000) throw new Error(`invalid ${key}`);
    return Math.round(value);
}

function videoId(parameters) {
    const id = stringArg(parameters, "videoId", 32).trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("invalid videoId");
    return id;
}

function mediaBin() {
    return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function mediaOutput(id) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    return path.join(CACHE_DIR, `${id}.mp4`);
}

async function mediaDriver({ operation, parameters }) {
    const id = videoId(parameters);
    const url = `https://www.youtube.com/watch?v=${id}`;
    if (operation === "resolve") {
        const { stdout } = await pexec(mediaBin(), ["-f", "18/best[ext=mp4][acodec!=none][vcodec!=none]", "-g", "--no-warnings", "--no-playlist", url], {
            timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024
        });
        const resolved = String(stdout ?? "").trim().split(/\r?\n/)[0].trim();
        if (!/^https?:\/\//.test(resolved)) throw new Error("media resolver returned no URL");
        return { ok: true, videoId: id, url: resolved, binding: { videoId: id } };
    }
    const output = mediaOutput(id);
    if (fs.existsSync(output) && fs.statSync(output).size > 0) {
        return { ok: true, videoId: id, output, bytes: fs.statSync(output).size, binding: { videoId: id, output } };
    }
    try {
        await pexec(mediaBin(), ["--extractor-args", "youtube:player_client=mweb", "-f", "18/best[ext=mp4][acodec!=none][vcodec!=none]", "-o", output, "--retries", "3", "--fragment-retries", "3", "--no-warnings", "--no-playlist", "--no-part", url], {
            timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024
        });
    } catch (error) {
        try { if (fs.statSync(output).size <= 0) fs.unlinkSync(output); } catch { /* fail closed below */ }
        throw error;
    }
    if (!fs.existsSync(output) || fs.statSync(output).size <= 0) throw new Error("media output postcondition failed");
    return { ok: true, videoId: id, output, bytes: fs.statSync(output).size, binding: { videoId: id, output } };
}

function psScript(script, env = {}) {
    return pexec("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024,
        env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [`DAMAR_${k}`, String(v)])) }
    });
}

async function desktopDriver({ operation, parameters }) {
    if (operation === "openApp") {
        const requested = stringArg(parameters, "name", 64).trim().toLowerCase();
        const target = DESKTOP_APPS[requested];
        if (!target) throw new Error("desktop app is not allowlisted");
        await psScript("$ErrorActionPreference='Stop'; Start-Process -FilePath $env:DAMAR_TARGET; Write-Output 'ok'", { TARGET: target });
        return { ok: true, operation, app: requested, target, verificationClass: "process-started" };
    }
    if (operation === "listWindows") {
        const { stdout } = await psScript("Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 25 ProcessName,MainWindowTitle | ConvertTo-Json -Compress");
        let windows = [];
        try { const parsed = JSON.parse(String(stdout ?? "[]")); windows = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ app: p.ProcessName, title: p.MainWindowTitle })); } catch { windows = []; }
        return { ok: true, operation, windows, verificationClass: "observed-list" };
    }
    if (operation === "typeText") {
        const text = stringArg(parameters, "text", 4096);
        await psScript("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:DAMAR_TEXT); Write-Output 'ok'", { TEXT: text });
        return { ok: true, operation, length: text.length, verificationClass: "invocation-only" };
    }
    if (operation === "pressKey") {
        const key = stringArg(parameters, "key", 256);
        await psScript("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:DAMAR_KEY); Write-Output 'ok'", { KEY: key });
        return { ok: true, operation, key, verificationClass: "invocation-only" };
    }
    if (operation === "fillForm") {
        const field = stringArg(parameters, "field", 512);
        const value = stringArg(parameters, "value", 4096);
        const { stdout } = await psScript("Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $root=[System.Windows.Automation.AutomationElement]::RootElement; $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$env:DAMAR_FIELD); $el=$root.FindFirst([System.Windows.Automation.TreeScope]::Subtree,$cond); if(-not $el){Write-Output 'not-found'; exit 0}; $vp=$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $vp.SetValue($env:DAMAR_VALUE); Write-Output 'ok'", { FIELD: field, VALUE: value });
        if (String(stdout).trim() !== "ok") throw new Error("desktop field not found or not writable");
        return { ok: true, operation, field, verificationClass: "value-pattern" };
    }
    if (operation === "moveMouse") {
        const x = finiteCoord(parameters, "x"); const y = finiteCoord(parameters, "y");
        await psScript("$s='[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y);'; Add-Type -MemberDefinition $s -Name DamarMove -Namespace Damar; if(-not [Damar.DamarMove]::SetCursorPos([int]$env:DAMAR_X,[int]$env:DAMAR_Y)){throw 'SetCursorPos failed'}; Write-Output 'ok'", { X: x, Y: y });
        return { ok: true, operation, x, y, verificationClass: "cursor-position" };
    }
    const button = String(parameters?.button ?? "left").toLowerCase();
    if (!["left", "right", "middle"].includes(button)) throw new Error("invalid mouse button");
    const x = parameters?.x == null ? null : finiteCoord(parameters, "x");
    const y = parameters?.y == null ? null : finiteCoord(parameters, "y");
    if ((x == null) !== (y == null)) throw new Error("mouse coordinates must be paired");
    const flags = { left: [2, 4], right: [8, 16], middle: [32, 64] }[button];
    await psScript("$s='[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);'; Add-Type -MemberDefinition $s -Name DamarClick -Namespace Damar; [Damar.DamarClick]::mouse_event([uint32]$env:DAMAR_DOWN,0,0,0,0); [Damar.DamarClick]::mouse_event([uint32]$env:DAMAR_UP,0,0,0,0); Write-Output 'ok'", { DOWN: flags[0], UP: flags[1], X: x ?? "", Y: y ?? "" });
    return { ok: true, operation: "click", button, x, y, verificationClass: "invocation-only" };
}

function safePath(value) {
    const p = stringArg({ value }, "value", 1024);
    if (!path.isAbsolute(p)) throw new Error("backup paths must be absolute");
    return path.normalize(p);
}

async function backupDriver({ parameters }) {
    const source = safePath(parameters?.source);
    const dest = safePath(parameters?.dest);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error("backup source directory missing");
    fs.mkdirSync(dest, { recursive: true });
    const args = process.platform === "win32"
        ? [source, dest, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NP"]
        : ["-a", `${source.replace(/\\?$/, "/")}`, `${dest.replace(/\\?$/, "/")}`];
    const cmd = process.platform === "win32" ? "robocopy" : "rsync";
    let result;
    try { result = await pexec(cmd, args, { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 }); }
    catch (error) { if (process.platform !== "win32" || error.code === undefined) throw error; result = error; }
    const code = Number(result?.code ?? 0);
    const ok = process.platform === "win32" ? code < 8 : code === 0;
    if (!ok) throw new Error(`backup command failed (${code})`);
    if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) throw new Error("backup destination postcondition failed");
    return { ok: true, source, dest, code, binding: { source, dest }, verificationClass: "destination-exists" };
}

function wireEmbodimentCapabilities({ registrar } = {}) {
    if (!registrar || typeof registrar.register !== "function") throw new TypeError("canonical capability registrar required");
    const record = {};
    for (const d of DESCRIPTORS) {
        const r = registrar.register(JSON.stringify(d));
        if (!r || typeof r.incarnationId !== "string") throw new Error(`canonical registration failed for ${d.id}`);
        record[d.id] = Object.freeze({ id: d.id, incarnationId: r.incarnationId });
    }
    const scope = (id, op) => ({ id, op, resolver: (args) => {
        requireObject(args, "action arguments");
        if (id === MEDIA) return Object.freeze([`video:${videoId(args)}`]);
        if (id === BACKUP) return Object.freeze([`source:${safePath(args.source)}`, `dest:${safePath(args.dest)}`]);
        return Object.freeze([`desktop:${op}`]);
    } });
    const scopeBindings = { [MEDIA]: {}, [DESKTOP]: {}, [BACKUP]: {} };
    for (const [id, ops] of [[MEDIA, MEDIA_OPS], [DESKTOP, DESKTOP_OPS], [BACKUP, BACKUP_OPS]]) {
        for (const op of ops) scopeBindings[id][op] = scope(id, op).resolver;
        Object.freeze(scopeBindings[id]);
    }
    return Object.freeze({
        media: record[MEDIA], desktop: record[DESKTOP], backup: record[BACKUP],
        scopeBindings: Object.freeze(scopeBindings)
    });
}

function wireEmbodimentActuators({ actuatorRegistry, wiring } = {}) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function" || !wiring) throw new TypeError("canonical actuator wiring required");
    const bindings = [];
    bindings.push(actuatorRegistry.register({ capabilityId: MEDIA, operations: MEDIA_OPS, capabilityIncarnationId: wiring.media.incarnationId, actuatorId: "act-damar-media", invoke: async ({ executionId, operation, parameters }) => { const result = await mediaDriver({ operation, parameters }); remember(executionId, result); return result; } }));
    bindings.push(actuatorRegistry.register({ capabilityId: DESKTOP, operations: DESKTOP_OPS, capabilityIncarnationId: wiring.desktop.incarnationId, actuatorId: "act-damar-desktop", invoke: async ({ executionId, operation, parameters }) => { const result = await desktopDriver({ operation, parameters }); remember(executionId, result); return result; } }));
    bindings.push(actuatorRegistry.register({ capabilityId: BACKUP, operations: BACKUP_OPS, capabilityIncarnationId: wiring.backup.incarnationId, actuatorId: "act-damar-backup", invoke: async ({ executionId, parameters }) => { const result = await backupDriver({ parameters }); remember(executionId, result); return result; } }));
    return Object.freeze(bindings);
}

function wireEmbodimentVerifiers({ wiring } = {}) {
    if (!wiring) throw new TypeError("canonical verifier wiring required");
    const definition = (capabilityId, operations, entry, observe) => Object.freeze({ capabilityId, operations, capabilityIncarnationId: entry.incarnationId, verifierId: `ver-${capabilityId}`, readiness: "READY", observe });
    return Object.freeze([
        definition(MEDIA, MEDIA_OPS, wiring.media, (ctx) => {
            const result = observations.get(ctx.executionId) ?? {};
            if (ctx.operation === "download") {
                const output = typeof result.output === "string" ? result.output : "";
                return { binding: result.videoId, exists: Boolean(output && fs.existsSync(output) && fs.statSync(output).size > 0), bytes: output && fs.existsSync(output) ? fs.statSync(output).size : 0 };
            }
            return { binding: result.videoId, url: typeof result.url === "string" && /^https?:\/\//.test(result.url) };
        }),
        definition(DESKTOP, DESKTOP_OPS, wiring.desktop, (ctx) => {
            const result = observations.get(ctx.executionId) ?? {};
            return { operation: ctx.operation, invoked: result.ok === true, verificationClass: result.verificationClass ?? "unknown", windows: ctx.operation === "listWindows" && Array.isArray(result.windows) ? result.windows : undefined, observed: ctx.operation === "listWindows" ? Array.isArray(result.windows) : result.ok === true };
        }),
        definition(BACKUP, BACKUP_OPS, wiring.backup, (ctx) => {
            const result = observations.get(ctx.executionId) ?? {};
            return { source: result.source, dest: result.dest, exists: Boolean(result.dest && fs.existsSync(result.dest) && fs.statSync(result.dest).isDirectory()), commandOk: result.ok === true };
        })
    ]);
}

module.exports = Object.freeze({
    MEDIA, DESKTOP, BACKUP, MEDIA_OPS, DESKTOP_OPS, BACKUP_OPS, DESCRIPTORS,
    wireEmbodimentCapabilities, wireEmbodimentActuators, wireEmbodimentVerifiers
});
