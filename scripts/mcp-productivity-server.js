#!/usr/bin/env node
"use strict";

/**
 * mcp-productivity-server — entry proses untuk server MCP suite
 * produktivitas Damar.
 *
 *   node scripts/mcp-productivity-server.js <serverId>
 *
 * Disalakan oleh McpClientManager (configs/mcp.json; lihat
 * seedMcpConfig di src/mcp/productivity/index.js) dan berbicara
 * MCP stdio (JSON-RPC newline-delimited). Komposisi memakai suite
 * bawaan: token dari Secret Vault lokal, keadaan dari konfigurasi
 * terpusat. Server tanpa login (filesystem/web/blender) tetap jalan
 * penuh walau vault tidak terkomposisi.
 */

const { createProductivitySuite } = require("../src/mcp/productivity");
const { runStdioServer } = require("../src/mcp/productivity/serverRuntime");
const { SERVER_BY_ID } = require("../src/mcp/productivity/registry");

function main() {
    const serverId = process.argv[2];
    if (!serverId || !SERVER_BY_ID.has(serverId)) {
        process.stderr.write(
            `Pemakaian: node scripts/mcp-productivity-server.js <${[...SERVER_BY_ID.keys()].join("|")}>\n`);
        process.exit(2);
    }
    const suite = createProductivitySuite();
    const server = suite.createServer(serverId);
    runStdioServer(server);
}

main();
