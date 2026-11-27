"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const registry = require("./registry");
const { createStateStore } = require("./stateStore");
const { ProductivityTokenStore } = require("./tokenStore");
const { createConnectService } = require("./connectService");
const mcpConfigStore = require("../configStore");

/**
 * index — composition root suite MCP Produktivitas.
 *
 * Menggabungkan: registry (data) + stateStore (konfigurasi terpusat
 * non-rahasia) + tokenStore (Secret Vault) + connectService (alur
 * Dashboard) + pabrik server stdio. Composition root yang sah dapat
 * menyuntikkan vault-nya sendiri (mis. komposisi trust produksi);
 * bawaan lokal memakai vault berkas AES-256-GCM repo
 * (src/runtime/vaultProviders/aesGcmCipher.js) di data/mcp-productivity.
 *
 * Data lokal suite (semua ter-ignore git):
 *   data/mcp-productivity/vault/     — envelope token terenkripsi
 *   data/mcp-productivity/vault.key  — kunci master lokal (ACL pengguna)
 *   data/mcp-productivity/refs.json  — SecretRef saja, tanpa nilai
 *   configs/mcp-productivity.json    — keadaan non-rahasia
 */

const SERVER_MODULES = Object.freeze({
    "google-workspace": () => require("./servers/google"),
    "microsoft-365": () => require("./servers/microsoft"),
    "notion": () => require("./servers/notion"),
    "slack": () => require("./servers/slack"),
    "github": () => require("./servers/github"),
    "spotify": () => require("./servers/spotify"),
    "todoist": () => require("./servers/todoist"),
    "blender": () => require("./servers/blender"),
    "filesystem": () => require("./servers/filesystem"),
    "web": () => require("./servers/web")
});

function defaultDataDir() {
    return process.env.DAMAR_MCP_PRODUCTIVITY_DIR
        || path.join(process.cwd(), "data", "mcp-productivity");
}

/**
 * Komposisi vault bawaan: AES-256-GCM (adapter produksi repo) +
 * file store. Kunci master: env DAMAR_VAULT_MASTER_KEY bila ada;
 * selain itu berkas kunci lokal yang dibuat sekali (mode 0600;
 * di Windows dilindungi ACL akun pengguna — adapter menuntut
 * pengakuan eksplisit allowPlatformManagedKeyFile untuk itu).
 * Gagal total → { vault: null } dan tokenStore fail-closed (jujur,
 * mengikuti preseden MD-007) — server non-OAuth tetap berjalan.
 */
function composeProductivityVault({ dataDir = defaultDataDir() } = {}) {
    try {
        const { createSecretVault } = require("../../runtime/vault");
        const { createFileSecretStore } = require("../../runtime/vault/store");
        const { createProductionCipherAdapter } = require("../../runtime/vaultProviders/aesGcmCipher");

        fs.mkdirSync(dataDir, { recursive: true });
        let cipherOptions = {};
        if (!process.env.DAMAR_VAULT_MASTER_KEY) {
            const keyFile = path.join(dataDir, "vault.key");
            if (!fs.existsSync(keyFile)) {
                fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
            }
            cipherOptions = { keyFile, allowPlatformManagedKeyFile: true };
        }
        const cipher = createProductionCipherAdapter(cipherOptions);
        const store = createFileSecretStore(path.join(dataDir, "vault"), { cipher });
        const vault = createSecretVault({ store, cipher });
        return { vault, note: "aes-256-gcm file vault" };
    } catch (e) {
        return { vault: null, note: `vault tidak terkomposisi: ${e.message}` };
    }
}

/**
 * Rakit suite lengkap.
 * @param {{ vault?: object|null, dataDir?: string, stateFile?: string,
 *           fetch?: Function, allowInsecureCipher?: boolean }} [options]
 *   vault undefined → komposisi bawaan; null → eksplisit tanpa vault
 *   (tokenStore fail-closed; untuk tes negatif).
 */
function createProductivitySuite(options = {}) {
    const dataDir = options.dataDir || defaultDataDir();
    let vault = options.vault;
    let vaultNote = "injected";
    if (vault === undefined) {
        const composed = composeProductivityVault({ dataDir });
        vault = composed.vault;
        vaultNote = composed.note;
    }
    const state = createStateStore({ file: options.stateFile });
    const tokenStore = new ProductivityTokenStore({
        vault,
        refsFile: path.join(dataDir, "refs.json"),
        allowInsecureCipher: options.allowInsecureCipher === true
    });
    const connect = createConnectService({
        tokenStore,
        state,
        fetch: options.fetch
    });

    /** Buat definisi server stdio untuk satu server suite. */
    function createServer(serverId, deps = {}) {
        const load = SERVER_MODULES[serverId];
        if (!load) throw new Error(`Server suite tidak dikenal: ${serverId}`);
        return load().createServer({
            tokenStore,
            state,
            fetch: options.fetch,
            ...deps
        });
    }

    return Object.freeze({
        registry,
        state,
        tokenStore,
        connect,
        createServer,
        vaultNote,
        dataDir
    });
}

/**
 * Daftarkan semua server suite ke configs/mcp.json (CRUD kanonik
 * configStore) agar McpClientManager menyalakan + menjembataninya
 * sebagai tool Damar. Idempoten: entri lama diperbarui, bukan diduplikasi.
 * Mengembalikan daftar id yang ditanam.
 */
function seedMcpConfig({ file, repoRoot = process.cwd() } = {}) {
    const scriptPath = path.join(repoRoot, "scripts", "mcp-productivity-server.js");
    const seeded = [];
    for (const server of registry.SERVERS) {
        mcpConfigStore.upsert({
            id: server.id,
            command: process.execPath,
            args: [scriptPath, server.id],
            allowedTools: server.tools.map(t => t.name)
        }, file);
        seeded.push(server.id);
    }
    return seeded;
}

module.exports = {
    createProductivitySuite,
    composeProductivityVault,
    seedMcpConfig,
    defaultDataDir,
    SERVER_MODULES,
    registry
};
