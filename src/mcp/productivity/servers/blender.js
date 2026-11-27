"use strict";

const net = require("node:net");
const { SERVER_BY_ID } = require("../registry");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server blender — jembatan lokal ke Blender yang sedang berjalan.
 *
 * Pola standar Blender MCP: sebuah ADDON di dalam Blender membuka
 * server socket di 127.0.0.1:9876 dan menerima perintah JSON. Bedanya
 * di sini: addon Damar (tools/blender-mcp/damar_blender_addon.py)
 * hanya menerima perintah TERTULIS (typed) — tidak ada eksekusi kode
 * arbitrer — agar permukaan ini tetap sejalan dengan model otoritas
 * Damar. Protokol kawatnya sederhana dan terdokumentasi:
 *
 *   → {"type": "<perintah>", "params": {...}}\n
 *   ← {"status": "ok", "result": {...}} | {"status": "error", "message": "..."}
 *
 * Tanpa login; target host/port dari konfigurasi terpusat. Blender
 * yang tidak berjalan → error jujur BLENDER_UNREACHABLE.
 */

const SERVER_ID = "blender";
const DEFAULT_TIMEOUT_MS = 15000;

function createBridge({ host = "127.0.0.1", port = 9876, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {

    function send(type, params = {}) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host, port });
            let buf = "";
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new ToolError(`Blender tidak menjawab dalam ${timeoutMs}ms.`, "BLENDER_TIMEOUT"));
            }, timeoutMs);

            socket.on("connect", () => {
                socket.write(JSON.stringify({ type, params }) + "\n");
            });
            socket.on("data", (chunk) => {
                buf += chunk.toString("utf8");
                const nl = buf.indexOf("\n");
                if (nl < 0) return;
                clearTimeout(timer);
                socket.end();
                let msg;
                try { msg = JSON.parse(buf.slice(0, nl)); }
                catch {
                    reject(new ToolError("Balasan Blender tidak sah (bukan JSON).", "BLENDER_BAD_RESPONSE"));
                    return;
                }
                if (msg.status === "ok") resolve(msg.result ?? {});
                else reject(new ToolError(`Blender: ${String(msg.message || "error").slice(0, 200)}`, "BLENDER_ERROR"));
            });
            socket.on("error", (e) => {
                clearTimeout(timer);
                reject(new ToolError(
                    `Blender tidak terjangkau di ${host}:${port} (${e.code || e.message}). Pastikan Blender berjalan dan addon Damar aktif.`,
                    "BLENDER_UNREACHABLE"
                ));
            });
        });
    }

    return Object.freeze({ send, host, port });
}

function createServer({ state, bridge } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const target = state ? state.blenderTarget() : { host: "127.0.0.1", port: 9876 };
    const conn = bridge || createBridge(target);

    async function callTool(name, args = {}) {
        switch (name) {
            case "blender_get_scene_info":
                return conn.send("get_scene_info");
            case "blender_list_objects":
                return conn.send("list_objects");
            case "blender_get_object_info":
                return conn.send("get_object_info", { name: args.name });
            case "blender_set_object_transform":
                return conn.send("set_object_transform", {
                    name: args.name,
                    location: args.location,
                    rotation: args.rotation,
                    scale: args.scale
                });
            case "blender_render_image":
                return conn.send("render_image", { filepath: args.filepath });
            default:
                throw new ToolError(`Tool tidak dikenal: ${name}`, "UNKNOWN_TOOL");
        }
    }

    return createServerDefinition({
        name: SERVER_ID,
        tools: descriptor.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        callTool,
        health: async () => {
            try {
                const info = await conn.send("get_scene_info");
                return { ok: true, connected: true, scene: info?.scene ?? null };
            } catch (e) {
                return { ok: false, connected: false, error: e.code || "BLENDER_UNREACHABLE" };
            }
        }
    });
}

module.exports = { createServer, createBridge, SERVER_ID };
