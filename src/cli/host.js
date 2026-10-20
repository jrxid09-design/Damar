"use strict";

/**
 * W5-CLI REAL CONNECTED CLI — Phase C: THE CLI HOST COMPOSITION ROOT.
 *
 * ONE composition, TWO surfaces.  This module composes the SAME canonical
 * runtime the production daemon composes (src/server.js), in the SAME order,
 * and adds ONLY an authenticated local IPC surface in front of the certified
 * CLI session bridge:
 *
 *   1. Manager-owned identity capability runtime  (before composition, so the
 *      durable identity store resolves to a REAL authority-backed runtime)
 *   2. canonical authority + sealed OwnerTrust composition
 *      (src/authority/productionComposition — the same call the daemon makes)
 *   3. canonical capability fabric + MataDewa capability runtime
 *   4. canonical Manager facade (src/manager — the same call the daemon makes)
 *   5. the certified CLI session bridge + the hardened local IPC server
 *
 * It creates NO second identity authority, NO second manager, NO CLI
 * executor and NO alternate file-store authority.  A missing or corrupt
 * durable identity composition is a hard, fail-closed refusal to start.
 */

const os = require("node:os");
const path = require("node:path");

const { resolveCliStateDir, transportError } = require("./localIpc");
const { createCliIpcServer, clearStaleDiscovery } = require("./ipcServer");
const { createCliSessionBridge } = require("../integration/cliSessionBridge");

/**
 * Live authority store proxy.  Resolution is deferred to call time because
 * the composition that owns the store is composed AFTER the runtime installs
 * (the same live-resolution discipline as the canonical Lane 2 resolver).
 * There is deliberately NO ephemeral fallback: an unresolvable authority
 * store fails the authorization closed rather than inventing authority.
 */
function lazyProductionAuthorityStore() {
    function current() {
        const prod = require("../authority/productionComposition").getProductionAuthorityComposition();
        const store = prod && prod.canonicalOwner && prod.canonicalOwner.store;
        if (!store || typeof store.getCapability !== "function") {
            throw transportError("CLI_HOST_AUTHORITY_UNAVAILABLE", "the canonical authority store is not composed");
        }
        return store;
    }
    return Object.freeze({
        getCapability: (...a) => current().getCapability(...a),
        getGeneration: (...a) => current().getGeneration(...a),
        countConsumption: (...a) => current().countConsumption(...a)
    });
}

/**
 * Rollback-resistant identity replay substrate.  Mirrors the canonical Lane 3
 * pattern: a durable ledger ANCHORED to a separate durable witness, which
 * reports `rollbackResistance: "EXTERNAL"`.  Without that substrate the
 * Manager-owned runtime refuses consequential identity writes — it is never
 * silently replaced with an in-memory map.
 */
function resolveIdentityReplayStore(env = process.env) {
    const { createCanonicalReplayLedger } = require("../manager/internal/canonicalReplayLedger");
    const { createCanonicalReplayWitness } = require("../manager/internal/canonicalReplayWitness");
    const home = path.join(os.homedir(), ".damar");
    return createCanonicalReplayLedger({
        file: env.DAMAR_IDENTITY_REPLAY_DB || path.join(home, "canonical-identity-replay.sqlite"),
        rollbackAnchor: createCanonicalReplayWitness(
            env.DAMAR_IDENTITY_REPLAY_WITNESS || path.join(home, "canonical-identity-replay.witness.jsonl")
        )
    });
}

/**
 * Compose the CLI host.  `start()` binds the endpoint; `stop()` releases it.
 * The returned handle is the ONLY thing the process entrypoint touches.
 */
async function createCliHost({ stateDir = resolveCliStateDir(), logger = null } = {}) {
    // 0. Endpoint pre-flight, BEFORE any composition: a second host against a
    //    live state dir must fail on the real conflict, not on a composition
    //    lock it happens to trip over first.  A stale descriptor from a crashed
    //    host is cleared; a LIVE one fails closed.
    clearStaleDiscovery(stateDir);

    // 1. Manager-owned identity capability runtime, BEFORE any composition so
    //    the durable identity store is authority-backed from the very first
    //    read.  Installed once; a second install is a hard error.
    const managerBootstrap = require("../manager/bootstrap");
    const { createIdentityCapabilityRuntime } = require("../manager/internal/identityCapabilities");
    managerBootstrap.installIdentityCapabilityRuntime(createIdentityCapabilityRuntime({
        authorityStore: lazyProductionAuthorityStore(),
        replayStore: resolveIdentityReplayStore()
    }));

    // 2. Canonical authority + sealed OwnerTrust composition.
    const composition = await require("../authority/productionComposition").ensureProductionAuthorityComposed();
    const ownerTrust = composition.ownerTrust;
    if (!ownerTrust) {
        throw transportError(
            "CLI_HOST_OWNER_TRUST_UNAVAILABLE",
            composition.ownerTrustError ? String(composition.ownerTrustError.message ?? "") : "owner trust did not compose"
        );
    }
    if (!ownerTrust.identityStore) {
        throw transportError("CLI_HOST_IDENTITY_UNAVAILABLE", "no durable canonical identity store is composed");
    }

    // 3. Canonical capability fabric + the MataDewa capability runtime.
    require("../action/bootstrap").createCanonicalActionFacade();
    require("../mataDewa/composition").getOrCreateMataDewaService();

    // 4. The canonical Manager facade — the same entrypoint the daemon uses.
    const manager = require("../manager").createDamarManager();

    // 5. The certified CLI session bridge (INGRESS, never authority).
    const bridge = createCliSessionBridge({ manager, ownerTrust, channelId: "cli-surface" });
    const server = createCliIpcServer({ bridge, stateDir, logger });

    let started = null;

    async function start() {
        if (started !== null) return started;
        started = await server.start();
        return started;
    }

    async function stop() {
        try { await server.stop(); } catch { /* best effort */ }
        try { bridge.close(); } catch { /* best effort */ }
        try { composition.close(); } catch { /* best effort */ }
    }

    function status() {
        return Object.freeze({
            stateDir,
            endpoint: started === null ? null : started.endpoint,
            acl: started === null ? null : started.acl,
            identityStore: ownerTrust.identityStore ? "DURABLE" : "NONE",
            ownerTrustDurable: ownerTrust.durable === true
        });
    }

    return Object.freeze({ start, stop, status, bridge, server, manager, ownerTrust });
}

module.exports = Object.freeze({ createCliHost, lazyProductionAuthorityStore, resolveIdentityReplayStore });

// ---------------------------------------------------------------------------
// Process entrypoint: `node src/cli/host.js`   (bin: damar-session-host)
// ---------------------------------------------------------------------------

async function main() {
    const host = await createCliHost({ logger: (line) => process.stderr.write(`${line}\n`) });
    const info = await host.start();
    // The endpoint is published on stdout for the operator; the CHANNEL SECRET
    // is never printed — it lives only in the ACL-confined token file.
    process.stdout.write(`DAMAR_CLI_HOST_READY ${JSON.stringify({
        pid: process.pid,
        endpoint: info.endpoint,
        stateDir: info.stateDir,
        acl: info.acl
    })}\n`);

    let stopping = false;
    async function shutdown() {
        if (stopping) return;
        stopping = true;
        await host.stop();
        process.stdout.write("DAMAR_CLI_HOST_STOPPED\n");
        process.exit(0);
    }
    process.on("SIGINT", () => { shutdown(); });
    process.on("SIGTERM", () => { shutdown(); });

    // Portable graceful-stop hook for supervisors that cannot send a signal
    // (Windows has no SIGTERM delivery): closing our stdin asks for shutdown.
    if (process.argv.includes("--stop-on-stdin-eof")) {
        process.stdin.on("end", () => { shutdown(); });
        process.stdin.on("close", () => { shutdown(); });
        process.stdin.resume();
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`DAMAR_CLI_HOST_FAILED ${error?.code ?? "ERROR"} ${String(error?.message ?? "").slice(0, 512)}\n`);
        process.exit(1);
    });
}
