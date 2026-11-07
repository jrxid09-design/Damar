const fs = require("node:fs");
const path = require("node:path");

/**
 * configStore — CRUD configs/mcp.json (server MCP eksternal → tool Damar).
 *
 * Backend manajemennya sudah ada (mcpClientManager membaca berkas ini,
 * restart() menyalakan ulang semua + bridge tool). Yang belum ada adalah
 * lapisan REST/UI — store ini tugasnya cuma menyimpan daftar dengan aman.
 */
const DEFAULT_FILE = path.join(process.cwd(), "configs", "mcp.json");

function read(file = process.env.DAMAR_MCP_CONFIG || DEFAULT_FILE) {

    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed?.servers) ? parsed.servers : [];
    }
    catch {
        return [];
    }

}

function write(servers, file = process.env.DAMAR_MCP_CONFIG || DEFAULT_FILE) {

    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    // Pertahankan _comment bila ada.
    let comment = null;
    try {
        comment = JSON.parse(fs.readFileSync(file, "utf8"))?._comment ?? null;
    } catch { /* berkas baru */ }

    fs.writeFileSync(file, JSON.stringify(
        comment ? { servers, _comment: comment } : { servers },
        null, 2
    ));

    return servers;

}

/** Validasi entri minimal; args boleh string (dipecah spasi) atau array. */
function normalize(body = {}) {

    const id = String(body.id ?? "").trim();
    const command = String(body.command ?? "").trim();

    if (!/^[a-z0-9_-]{2,40}$/i.test(id)) {
        throw new Error("id wajib 2–40 karakter [a-z0-9_-].");
    }
    if (!command) {
        throw new Error("command wajib diisi.");
    }

    let args = body.args ?? [];
    if (typeof args === "string") {
        args = args.trim() ? args.trim().split(/\s+/) : [];
    }
    if (!Array.isArray(args)) args = [];

    return {
        id,
        command,
        args: args.map(a => String(a)),
        env: body.env && typeof body.env === "object" ? body.env : undefined,
        cwd: body.cwd ? String(body.cwd) : undefined,
        allowedTools: Array.isArray(body.allowedTools)
            ? body.allowedTools.map(String)
            : null
    };

}

function upsert(server, file) {

    // Normalisasi selalu di store — pemanggil (REST/manual) sama amannya.
    const clean = normalize(server);

    const servers = read(file);
    const i = servers.findIndex(s => s.id === clean.id);

    if (i >= 0) servers[i] = { ...servers[i], ...clean };
    else servers.push(clean);

    write(servers, file);

    return clean;

}

function remove(id, file) {

    const servers = read(file);
    const next = servers.filter(s => s.id !== id);

    if (next.length === servers.length) return false;

    write(next, file);

    return true;

}

module.exports = { read, write, upsert, remove, normalize };
