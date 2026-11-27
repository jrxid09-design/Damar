"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { SERVER_BY_ID } = require("../registry");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server filesystem — akses berkas lokal TERBATAS pada folder yang
 * diberikan pengguna (grant), tercatat di konfigurasi terpusat
 * (stateStore.filesystemGrants). Ini baseline produktivitas tanpa
 * login: Damar hanya dapat menyentuh jalur di dalam grant.
 *
 * Penjagaan jalur (wajib, bukan hiasan):
 *   - target di-resolve absolut, lalu realpath (mengikuti symlink)
 *     harus tetap berada di dalam realpath salah satu grant;
 *   - untuk jalur yang belum ada (tulis baru), realpath induknya yang
 *     diperiksa dengan aturan yang sama;
 *   - grant itu sendiri tidak dapat dihapus.
 * Penolakan selalu PATH_NOT_GRANTED — tidak ada fallback diam-diam.
 */

const SERVER_ID = "filesystem";

function createServer({ state } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);

    function grants() {
        const list = state ? state.filesystemGrants() : [];
        return list.map(g => {
            let real = g;
            try { real = fs.realpathSync(g); } catch { /* grant hilang → tetap dicocokkan tekstual */ }
            return { raw: path.resolve(g), real };
        });
    }

    /** Pastikan target berada di dalam grant; kembalikan jalur absolut aman. */
    function assertGranted(target) {
        if (typeof target !== "string" || !target.trim()) {
            throw new ToolError("Path wajib diisi.", "PATH_REQUIRED");
        }
        const abs = path.resolve(target);
        const gs = grants();
        if (gs.length === 0) {
            throw new ToolError(
                "Belum ada folder yang diberikan akses. Tambahkan lewat Control Dashboard → Produktivitas.",
                "PATH_NOT_GRANTED"
            );
        }
        // Jalur nyata target: realpath induk terdekat yang ada + sisa
        // jalur — symlink di tengah jalan tidak bisa menyelundupkan
        // target keluar dari grant.
        let probe = abs;
        while (!fs.existsSync(probe)) {
            const parent = path.dirname(probe);
            if (parent === probe) break;
            probe = parent;
        }
        let realProbe = probe;
        try { realProbe = fs.realpathSync(probe); } catch { /* pakai apa adanya */ }
        const realAbs = path.join(realProbe, path.relative(probe, abs));

        for (const g of gs) {
            for (const base of [g.real, g.raw]) {
                const rel = path.relative(base, realAbs);
                if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
                    return { abs: realAbs, grant: g };
                }
            }
        }
        throw new ToolError(`Jalur di luar folder yang diberikan akses: ${target}`, "PATH_NOT_GRANTED");
    }

    async function callTool(name, args = {}) {
        switch (name) {

            case "fs_list_dir": {
                const { abs } = assertGranted(args.path);
                const entries = await fsp.readdir(abs, { withFileTypes: true });
                return {
                    path: abs,
                    entries: entries.map(e => ({
                        name: e.name,
                        type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other"
                    }))
                };
            }

            case "fs_read_text": {
                const { abs } = assertGranted(args.path);
                const cap = args.maxBytes ?? 65536;
                const buf = await fsp.readFile(abs);
                return {
                    path: abs,
                    truncated: buf.length > cap,
                    content: buf.subarray(0, cap).toString("utf8")
                };
            }

            case "fs_write_text": {
                const { abs } = assertGranted(args.path);
                await fsp.mkdir(path.dirname(abs), { recursive: true });
                await fsp.writeFile(abs, String(args.content ?? ""), "utf8");
                return { written: true, path: abs, bytes: Buffer.byteLength(String(args.content ?? "")) };
            }

            case "fs_create_directory": {
                const { abs } = assertGranted(args.path);
                await fsp.mkdir(abs, { recursive: true });
                return { created: true, path: abs };
            }

            case "fs_delete_path": {
                const { abs, grant } = assertGranted(args.path);
                if (abs === grant.real || abs === grant.raw) {
                    throw new ToolError("Folder grant itu sendiri tidak dapat dihapus.", "PATH_PROTECTED");
                }
                await fsp.rm(abs, { recursive: true, force: false });
                return { deleted: true, path: abs };
            }

            default:
                throw new ToolError(`Tool tidak dikenal: ${name}`, "UNKNOWN_TOOL");
        }
    }

    return createServerDefinition({
        name: SERVER_ID,
        tools: descriptor.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        callTool,
        health: async () => ({ ok: true, grants: grants().length })
    });
}

module.exports = { createServer, SERVER_ID };
