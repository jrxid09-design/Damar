import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, bytes, relativeTime, toast } from "../lib/ui.js";

/**
 * Files — penjelajah berkas lokal (read-only). Data nyata dari daemon.
 * Navigasi folder + pindah drive; tak menulis/menghapus.
 */
let cwd = null;

export const files = {

    id: "files",
    label: "Files",
    icon: "folder",
    title: "Files",
    subtitle: "Jelajahi berkas di mesin ini (hanya-baca).",

    render(root) {
        root.innerHTML = `
            <div class="view-head">
                <div><h1>Files</h1><p>Jelajahi berkas di mesin ini (hanya-baca).</p></div>
                <div class="actions">
                    <button class="btn ghost sm" id="fl-home">${icon("home")} Home</button>
                    <button class="btn ghost sm" id="fl-up">${icon("refresh")} Naik</button>
                </div>
            </div>
            <div class="stack">
                <div class="panel" style="padding:12px 14px">
                    <div class="row" id="fl-drives" style="gap:6px;flex-wrap:wrap"></div>
                    <div class="row" style="margin-top:8px;gap:8px">
                        <input type="text" id="fl-path" placeholder="C:\\Users\\…" style="flex:1" class="mono">
                        <button class="btn sm" id="fl-go">${icon("search")} Buka</button>
                    </div>
                </div>
                <div class="panel flush"><div id="fl-list"></div></div>
            </div>`;
    },

    async mount(root) {
        const go = p => load(root, p);
        root.querySelector("#fl-home").addEventListener("click", () => go(null));
        root.querySelector("#fl-up").addEventListener("click", () => { const p = root._parent; if (p) go(p); });
        root.querySelector("#fl-go").addEventListener("click", () => go(root.querySelector("#fl-path").value.trim() || null));
        root.querySelector("#fl-path").addEventListener("keydown", e => { if (e.key === "Enter") go(root.querySelector("#fl-path").value.trim() || null); });
        await load(root, cwd);
    }

};

async function load(root, dir) {
    const list = root.querySelector("#fl-list");
    list.innerHTML = `<div class="row" style="padding:16px"><span class="spinner"></span><span class="small muted">Membaca…</span></div>`;

    let data;
    try { data = await api.files(dir); }
    catch (e) { list.innerHTML = `<div class="empty">${icon("alert")}<div class="danger-text">${esc(e.message)}</div></div>`; return; }

    cwd = data.path;
    root._parent = data.parent;
    root.querySelector("#fl-path").value = data.path;

    root.querySelector("#fl-drives").innerHTML = (data.drives ?? []).map(d =>
        `<button class="tag" data-drive="${esc(d.path)}" style="cursor:pointer">${icon("server")} ${esc(d.name)}</button>`).join("");
    root.querySelectorAll("[data-drive]").forEach(b =>
        b.addEventListener("click", () => load(root, b.dataset.drive)));

    if (!data.items.length) {
        list.innerHTML = `<div class="empty">${icon("folder")}<div>Folder kosong.</div></div>`;
        return;
    }

    list.innerHTML = `<div class="scroll-x"><table class="table">
        <thead><tr><th>Nama</th><th style="width:120px">Ukuran</th><th style="width:150px">Diubah</th></tr></thead>
        <tbody>${data.items.map(it => `
            <tr ${it.type === "dir" ? `data-dir="${esc(data.path)}${sep(data.path)}${esc(it.name)}" style="cursor:pointer"` : ""}>
                <td><span class="row" style="gap:9px">
                    ${icon(it.type === "dir" ? "folder" : "file")}
                    <span class="truncate" style="max-width:52ch">${esc(it.name)}</span>
                    ${it.ext ? `<span class="tag">${esc(it.ext)}</span>` : ""}
                </span></td>
                <td class="mono small dim">${it.type === "dir" ? "—" : bytes(it.size)}</td>
                <td class="small dim">${it.mtime ? relativeTime(it.mtime) : "—"}</td>
            </tr>`).join("")}</tbody></table></div>`;

    list.querySelectorAll("[data-dir]").forEach(tr =>
        tr.addEventListener("click", () => load(root, tr.dataset.dir)));
}

function sep(p) {
    if (p.endsWith("\\") || p.endsWith("/")) return "";
    return p.includes("\\") ? "\\" : "/";
}
