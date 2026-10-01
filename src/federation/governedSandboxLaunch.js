"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { APPCONTAINER_NAME, HOST_EXE } = require("./appContainerSandbox");
const { SHIM_SOURCE } = require("./sandboxShim");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");

function parseNativeResult(stdoutChunk) {
    const begin = "SANDBOXHOST_RESULT_BEGIN ";
    const end = "SANDBOXHOST_RESULT_END";
    const bi = stdoutChunk.indexOf(begin);
    if (bi < 0) return null;
    const lineEnd = stdoutChunk.indexOf("\n", bi);
    if (lineEnd < 0) return null;
    const declared = Number(stdoutChunk.slice(bi + begin.length, lineEnd).trim());
    if (!Number.isFinite(declared) || declared <= 0) return null;
    const bodyStart = lineEnd + 1;
    const ei = stdoutChunk.indexOf("\n" + end, bodyStart);
    return ei < 0 ? stdoutChunk.slice(bodyStart) : stdoutChunk.slice(bodyStart, ei);
}

function launchGovernedSandbox({ artifactPath, artifactDigest, executionId,
    toolArgs = {}, envMaterial = {}, nodeExecutable = process.execPath, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
        if (process.platform !== "win32") return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, "AppContainer sandbox requires Windows (R3-02)"));
        if (!fs.existsSync(HOST_EXE)) return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, "native/sandbox-host/sandbox-host.exe missing — governed external execution fails closed (R3-03)"));
        if (typeof artifactPath !== "string" || artifactPath.length === 0) return reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "governed sandbox requires an artifact source path"));
        if (typeof artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(artifactDigest)) return reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "governed sandbox requires the 64-hex pinned artifact digest (R5-04)"));
        const nodeSrc = String(nodeExecutable);
        if (!fs.existsSync(nodeSrc)) return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, "node executable source unavailable"));
        const hostArgs = ["--governed", "--app-container", APPCONTAINER_NAME,
            "--execution-id", String(executionId || crypto.randomBytes(16).toString("hex")).slice(0, 128),
            "--node-source", nodeSrc,
            "--node-digest", crypto.createHash("sha256").update(fs.readFileSync(nodeSrc)).digest("hex"),
            "--artifact-source", artifactPath, "--artifact-digest", artifactDigest,
            "--timeout-ms", String(Math.floor(Number(timeoutMs) || 30000)), "--", SHIM_SOURCE,
            JSON.stringify(toolArgs ?? {}), JSON.stringify(envMaterial ?? {})];
        const child = spawn(HOST_EXE, hostArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "", stderr = "", killed = false;
        child.stdout.on("data", d => { stdout += d.toString(); if (Buffer.byteLength(stdout, "utf8") > 1024 * 1024) { killed = true; child.kill("SIGKILL"); } });
        child.stderr.on("data", d => { stderr += d.toString(); if (Buffer.byteLength(stderr, "utf8") > 64 * 1024) { killed = true; child.kill("SIGKILL"); } });
        child.on("error", err => { if (!killed) reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, "sandbox-host spawn failed: " + String(err.message).slice(0, 140))); });
        child.on("close", code => {
            if (killed) return reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox output exceeded cap"));
            if (code === 124) return reject(meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, `sandbox timeout (${timeoutMs}ms)`));
            const framed = parseNativeResult(stdout);
            if (framed === null) return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, `sandbox produced no result (host code=${code}) ${stderr.slice(-200).trim()}`));
            if (Buffer.byteLength(framed, "utf8") > 256 * 1024) return reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox result exceeds output cap"));
            let parsed;
            try { parsed = JSON.parse(framed); } catch { return reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "sandbox produced non-JSON result")); }
            if (parsed && parsed.ok === true) return resolve(Object.freeze({ ok: true, output: parsed.output ?? null, sandboxPid: Number(parsed.pid) || 0, mechanism: "AppContainer", sandboxId: APPCONTAINER_NAME, stagedDigest: artifactDigest }));
            if (parsed && String(parsed.error).includes("OUTPUT_EXCEEDS_CAP")) return reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox result exceeds output cap"));
            reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, `sandbox error: ${String((parsed && parsed.error) || "unknown").slice(0, 300)}`));
        });
    });
}

module.exports = Object.freeze({ launchGovernedSandbox });
