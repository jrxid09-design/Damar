"use strict";

/**
 * W5-CLI REAL CONNECTED CLI — Phase D: THE PRODUCTION CLI ENTRYPOINT.
 *
 *   node src/cli/session.js <command> [options]        (bin: damar-session)
 *
 * Runs as its OWN operating-system process, connects to the Damar host over
 * the authenticated local endpoint, and drives the eight canonical bridge
 * operations.  It is a THIN CLIENT:
 *
 *   - it holds no authority, no identity store and no capability runtime;
 *   - a session handle is NOT authorization — every consequential submit
 *     still needs a FRESH one-use Owner proof, obtained here from the Owner
 *     credential the operator points at (`--key-file`);
 *   - it never enrolls an owner, never pairs a device and never creates an
 *     authority: those remain sealed ceremonies owned by the host.
 *
 * COMMANDS
 *   status              ingress readiness (authenticated channel required)
 *   auth-begin          mint a one-use device+surface challenge
 *   auth-complete       complete the Owner ceremony => session handle
 *   session             inspect the live session (live revalidation)
 *   capabilities        canonical capability discovery
 *   action-challenge    mint a fresh one-use owner-proof challenge
 *   submit              submit a governed command through the Manager
 *   logout              revoke the session and drop the handle
 */

const crypto = require("node:crypto");
const fs = require("node:fs");

const { canonicalChallenge } = require("../authority/ownerTrust");
const { c, symbols } = require("./theme");
const {
    clientStatePath,
    resolveCliStateDir,
    writeProtected,
    redact
} = require("./localIpc");
const { connectCliIpc } = require("./ipcClient");

const COMMANDS = Object.freeze([
    "status", "auth-begin", "auth-complete", "session",
    "capabilities", "action-challenge", "submit", "logout"
]);

const USAGE = `damar-session — connected Damar CLI (local authenticated channel)

usage: damar-session [--json] <command> [options]

commands:
  status                              ingress readiness
  auth-begin    --device <id> --surface <id>
  auth-complete --device <id> --surface <id>
                (--signature <b64url> [--nonce <hex>] | --key-file <pem>)
                (--binding-secret-stdin | --binding-secret-file <path>)
  session       [--connection <id>]
  capabilities  [--connection <id>]
  action-challenge [--connection <id>]
  submit        --capability <id> --operation <op>
                [--arguments <json>] [--connection <id>]
                (--proof-file <json> | --key-file <pem>)
  logout        [--connection <id>]

options:
  --json         print the canonical result as JSON
  --key-file     Owner credential (PKCS8/SPKI PEM) used to sign a FRESH
                 challenge locally; never echoed, never transmitted
  --help         this text
`;

function parseArgv(argv) {
    const options = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            options._.push(arg);
            continue;
        }
        const name = arg.slice(2);
        if (["json", "help", "binding-secret-stdin"].includes(name)) {
            options[name] = true;
            continue;
        }
        const value = argv[++i];
        if (value === undefined) throw new Error(`missing value for --${name}`);
        options[name] = value;
    }
    return options;
}

function readStdinLine() {
    try {
        const data = fs.readFileSync(0, "utf8");
        return data.split(/\r?\n/)[0].trim();
    } catch {
        return "";
    }
}

function ownerPrivateKey(file) {
    const pem = fs.readFileSync(file, "utf8");
    return crypto.createPrivateKey(pem);
}

function signChallenge(privateKey, challenge) {
    return crypto.sign(null, canonicalChallenge({
        purpose: challenge.purpose,
        credentialId: challenge.credentialId,
        nonce: challenge.nonce,
        context: challenge.context
    }), privateKey).toString("base64url");
}

function loadClientState(stateDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(clientStatePath(stateDir), "utf8"));
        return raw && typeof raw === "object" ? raw : null;
    } catch {
        return null;
    }
}

function saveClientState(stateDir, state) {
    // The handle is not a bearer credential, but it is still confined to the
    // owning OS principal like every other piece of CLI channel state.
    writeProtected(clientStatePath(stateDir), `${JSON.stringify(state)}\n`);
}

function clearClientState(stateDir) {
    try { fs.unlinkSync(clientStatePath(stateDir)); } catch { /* already gone */ }
}

function requireConnection(options, stateDir) {
    if (typeof options.connection === "string") return options.connection;
    const state = loadClientState(stateDir);
    if (!state || typeof state.connectionId !== "string") {
        throw new Error("no active CLI session: run `auth-complete` first (or pass --connection)");
    }
    return state.connectionId;
}

function bindingSecretFrom(options) {
    if (options["binding-secret-stdin"] === true) {
        const value = readStdinLine();
        if (value === "") throw new Error("no binding secret on stdin");
        return value;
    }
    if (typeof options["binding-secret-file"] === "string") {
        const value = fs.readFileSync(options["binding-secret-file"], "utf8").trim();
        if (value === "") throw new Error("binding secret file is empty");
        return value;
    }
    throw new Error("one of --binding-secret-stdin or --binding-secret-file is required");
}

function printHuman(command, result) {
    if (result.ok !== true) {
        process.stderr.write(`${symbols.err} ${c.danger(result.code ?? "DENIED")}${result.detail ? ` ${c.muted(result.detail)}` : ""}\n`);
        return;
    }
    switch (command) {
        case "status":
            process.stdout.write(`${symbols.ok} ingress ${c.ok("ready")}  ${c.muted(`manager=${result.manager ?? "n/a"} identity=${result.identityStore ?? "n/a"}`)}\n`);
            break;
        case "auth-begin":
            process.stdout.write(`${symbols.ok} challenge ${c.cyan(result.challenge.nonce)} ${c.muted(`device=${result.challenge.deviceId} surface=${result.challenge.surfaceId}`)}\n`);
            break;
        case "auth-complete":
            process.stdout.write(`${symbols.ok} session ${c.ok("established")}  connection=${c.cyan(result.connectionId)}  principal=${result.principalId}\n`);
            break;
        case "session":
            process.stdout.write(`${symbols.ok} session ${c.cyan(result.sessionId)}  device=${result.deviceId}  surface=${result.surfaceId}\n`);
            break;
        case "capabilities":
            process.stdout.write(`${symbols.ok} ${result.count} canonical capabilities\n`);
            for (const entry of result.capabilities) {
                process.stdout.write(`  ${c.cyan(entry.capabilityId)} ${c.muted(`${entry.kind} ${entry.availability}`)}\n`);
            }
            break;
        case "action-challenge":
            process.stdout.write(`${symbols.ok} owner-proof challenge ${c.cyan(result.challenge.nonce)}\n`);
            break;
        case "submit":
            process.stdout.write(`${symbols.ok} ${c.ok(result.outcome)} ${c.muted(`authority=${result.authorityDecision ?? "n/a"} execution=${result.executionId ?? "none"}`)}\n`);
            break;
        case "logout":
            process.stdout.write(`${symbols.ok} ${result.revoked ? "session revoked" : "no session to revoke"}\n`);
            break;
        default:
            process.stdout.write(`${JSON.stringify(result)}\n`);
    }
}

async function run(argv) {
    const options = parseArgv(argv);
    if (options.help === true || options._.length === 0) {
        process.stdout.write(USAGE);
        return 0;
    }
    const command = options._[0];
    if (!COMMANDS.includes(command)) {
        process.stderr.write(`${symbols.err} unknown command "${command}"\n${USAGE}`);
        return 2;
    }

    const stateDir = resolveCliStateDir();
    const client = await connectCliIpc({ stateDir });
    try {
        let result;
        switch (command) {
            case "status":
                result = await client.request("status");
                break;

            case "auth-begin":
                result = await client.request("authBegin", {
                    deviceId: String(options.device ?? ""),
                    surfaceId: String(options.surface ?? "")
                });
                break;

            case "auth-complete": {
                const deviceId = String(options.device ?? "");
                const surfaceId = String(options.surface ?? "");
                let nonce = options.nonce;
                let signature = options.signature;
                if (signature === undefined && typeof options["key-file"] === "string") {
                    const begin = await client.request("authBegin", { deviceId, surfaceId });
                    if (begin.ok !== true) { result = begin; break; }
                    nonce = begin.challenge.nonce;
                    signature = signChallenge(ownerPrivateKey(options["key-file"]), begin.challenge);
                }
                if (typeof signature !== "string") throw new Error("--signature or --key-file is required");
                result = await client.request("authComplete", {
                    deviceId, surfaceId, nonce, signature,
                    bindingSecret: bindingSecretFrom(options)
                });
                if (result.ok === true) {
                    saveClientState(stateDir, {
                        connectionId: result.connectionId,
                        sessionId: result.sessionId,
                        principalId: result.principalId,
                        deviceId: result.deviceId,
                        surfaceId: result.surfaceId,
                        expiresAtMs: result.expiresAtMs ?? null,
                        endpoint: client.endpoint
                    });
                }
                break;
            }

            case "session":
                result = await client.request("session", { connectionId: requireConnection(options, stateDir) });
                break;

            case "capabilities":
                result = await client.request("capabilities", { connectionId: requireConnection(options, stateDir) });
                break;

            case "action-challenge":
                result = await client.request("actionChallenge", { connectionId: requireConnection(options, stateDir) });
                break;

            case "submit": {
                const connectionId = requireConnection(options, stateDir);
                const capabilityId = String(options.capability ?? "");
                const operation = String(options.operation ?? "");
                const args = options.arguments === undefined ? {} : JSON.parse(options.arguments);
                let authProof = null;
                if (typeof options["proof-file"] === "string") {
                    authProof = JSON.parse(fs.readFileSync(options["proof-file"], "utf8"));
                } else if (typeof options["key-file"] === "string") {
                    // ALWAYS a fresh one-use proof: never a cached or replayed one.
                    const challenge = await client.request("actionChallenge", { connectionId });
                    if (challenge.ok !== true) { result = challenge; break; }
                    authProof = {
                        kind: "owner-proof",
                        credentialId: challenge.challenge.credentialId,
                        nonce: challenge.challenge.nonce,
                        signature: signChallenge(ownerPrivateKey(options["key-file"]), challenge.challenge)
                    };
                }
                result = await client.request("submit", {
                    connectionId, capabilityId, operation, arguments: args,
                    ...(authProof === null ? {} : { authProof })
                });
                break;
            }

            case "logout": {
                const connectionId = requireConnection(options, stateDir);
                result = await client.request("logout", { connectionId });
                clearClientState(stateDir);
                break;
            }

            default:
                throw new Error(`unhandled command ${command}`);
        }

        if (options.json === true) {
            process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
            printHuman(command, result);
        }
        if (!result || result.ok !== true) return 1;
        // A canonical DENY is an accurate, non-zero result, never a success.
        if (command === "submit" && ["AUTHORITY_DENIED", "AUTHENTICATION_REQUIRED", "SUSPENDED"].includes(result.outcome)) return 1;
        return 0;
    } finally {
        client.close();
    }
}

/** Diagnostics must never echo proof material; redaction is applied here too. */
function safeError(error) {
    return redact({ code: error?.code ?? "ERROR", message: String(error?.message ?? "").slice(0, 512) });
}

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }).catch((error) => {
        const safe = safeError(error);
        process.stderr.write(`${symbols.err} ${c.danger(safe.code)} ${c.muted(safe.message)}\n`);
        process.exitCode = 1;
    });
}

module.exports = Object.freeze({ run, COMMANDS, USAGE, parseArgv });
