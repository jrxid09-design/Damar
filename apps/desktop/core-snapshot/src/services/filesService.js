const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

/**
 * filesService — penjelajah berkas lokal (READ-ONLY).
 *
 * Data nyata dari filesystem mesin (dev laptop / PC rumah). Hanya
 * MENDAFTAR isi folder; tak menulis/menghapus/menyajikan isi berkas
 * sembarang lewat HTTP. Daemon sudah localhost + token, jadi ini alat
 * navigasi pribadi, bukan endpoint publik.
 */

const HOME = os.homedir();

async function drives() {
    if (process.platform !== "win32") return [{ name: "/", path: "/" }];
    // Enumerasi huruf drive yang ada tanpa dependensi.
    const out = [];
    for (const L of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const p = `${L}:\\`;
        try { await fs.access(p); out.push({ name: `${L}:`, path: p }); }
        catch { /* drive tak ada */ }
    }
    return out;
}

async function list(dir) {
    const target = dir ? path.resolve(dir) : HOME;

    const entries = await fs.readdir(target, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
        // Lewati yang tak bisa di-stat (izin) alih-alih menggagalkan semua.
        try {
            const full = path.join(target, e.name);
            const st = await fs.stat(full).catch(() => null);
            const isDir = e.isDirectory();
            items.push({
                name: e.name,
                type: isDir ? "dir" : "file",
                size: isDir ? null : (st?.size ?? 0),
                mtime: st?.mtime?.toISOString() ?? null,
                ext: isDir ? null : path.extname(e.name).slice(1).toLowerCase()
            });
        }
        catch { /* lewati entri bermasalah */ }
    }

    items.sort((a, b) =>
        a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, "id"));

    const parent = path.dirname(target);
    return {
        path: target,
        parent: parent !== target ? parent : null,
        home: HOME,
        drives: await drives(),
        items
    };
}

module.exports = { list };
