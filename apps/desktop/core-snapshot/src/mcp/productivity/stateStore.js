"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * stateStore — keadaan NON-RAHASIA suite produktivitas di konfigurasi
 * terpusat Core (configs/mcp-productivity.json; berkas lokal mesin,
 * ter-ignore git seperti configs/mcp.json).
 *
 * Isinya hanya konfigurasi yang memang milik pengguna dan tidak
 * rahasia:
 *   - layanan aktif per suite (Gmail/Drive/Calendar, dsb.),
 *   - folder lokal yang diberikan akses ke server filesystem,
 *   - host/port jembatan Blender.
 * Token & kredensial TIDAK PERNAH di sini — itu urusan tokenStore
 * (Secret Vault). Berkas rusak/hilang → default aman (semua layanan
 * suite aktif, tanpa folder terberi, Blender 127.0.0.1:9876).
 */

const DEFAULT_FILE = path.join(process.cwd(), "configs", "mcp-productivity.json");

const DEFAULTS = Object.freeze({
    services: Object.freeze({
        "google-workspace": Object.freeze({ gmail: true, drive: true, calendar: true }),
        "microsoft-365": Object.freeze({ mail: true, drive: true, calendar: true })
    }),
    filesystem: Object.freeze({ grants: Object.freeze([]) }),
    blender: Object.freeze({ host: "127.0.0.1", port: 9876 })
});

function defaultState() {
    return {
        services: {
            "google-workspace": { gmail: true, drive: true, calendar: true },
            "microsoft-365": { mail: true, drive: true, calendar: true }
        },
        filesystem: { grants: [] },
        blender: { host: "127.0.0.1", port: 9876 }
    };
}

function createStateStore({ file = process.env.DAMAR_MCP_PRODUCTIVITY_STATE || DEFAULT_FILE } = {}) {

    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            const base = defaultState();
            if (parsed && typeof parsed === "object") {
                if (parsed.services && typeof parsed.services === "object") {
                    for (const [k, v] of Object.entries(parsed.services)) {
                        if (v && typeof v === "object") base.services[k] = { ...(base.services[k] ?? {}), ...v };
                    }
                }
                if (Array.isArray(parsed.filesystem?.grants)) {
                    base.filesystem.grants = parsed.filesystem.grants.filter(g => typeof g === "string");
                }
                if (parsed.blender && typeof parsed.blender === "object") {
                    if (typeof parsed.blender.host === "string") base.blender.host = parsed.blender.host;
                    if (Number.isInteger(parsed.blender.port)) base.blender.port = parsed.blender.port;
                }
            }
            return base;
        } catch {
            return defaultState();
        }
    }

    function write(state) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, file);
        return state;
    }

    function update(fn) {
        const state = read();
        fn(state);
        return write(state);
    }

    return Object.freeze({
        file,
        read,
        write,
        update,
        /** Layanan aktif untuk server suite; null = server tanpa layanan. */
        enabledServices(serverId, allServices) {
            if (!allServices) return null;
            const state = read();
            const flags = state.services[serverId] ?? {};
            return allServices.filter(key => flags[key] !== false);
        },
        setServiceEnabled(serverId, service, enabled) {
            return update(state => {
                state.services[serverId] = { ...(state.services[serverId] ?? {}), [service]: Boolean(enabled) };
            });
        },
        filesystemGrants() {
            return [...read().filesystem.grants];
        },
        setFilesystemGrants(grants) {
            const clean = [...new Set((grants ?? []).filter(g => typeof g === "string" && g.trim()).map(g => path.resolve(g.trim())))];
            update(state => { state.filesystem.grants = clean; });
            return clean;
        },
        blenderTarget() {
            const b = read().blender;
            return { host: b.host, port: b.port };
        },
        setBlenderTarget({ host, port } = {}) {
            return update(state => {
                if (typeof host === "string" && host) state.blender.host = host;
                if (Number.isInteger(port)) state.blender.port = port;
            });
        }
    });
}

module.exports = { createStateStore, DEFAULTS, defaultState };
