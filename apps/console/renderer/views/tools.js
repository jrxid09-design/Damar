import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, toast } from "../lib/ui.js";

/**
 * Tools — registri kapabilitas yang bisa dipanggil AI. Data nyata dari
 * /tools (ToolRegistry). Bisa dijalankan langsung dari sini (tanpa model)
 * untuk uji cepat; argumen diisi sebagai JSON.
 */
let allTools = [];

export const tools = {

    id: "tools",
    label: "Tools",
    icon: "tool",
    title: "Tools",
    subtitle: "Kapabilitas yang tersedia untuk Damar dan agent-nya.",

    render(root) {
        root.innerHTML = `
            <div class="view-head">
                <div><h1>Tools</h1><p>Kapabilitas yang tersedia untuk Damar dan agent-nya.</p></div>
                <div class="actions">
                    <input type="text" id="tl-search" placeholder="Cari tool…" style="width:220px">
                    <button class="btn ghost sm" id="tl-refresh">${icon("refresh")} Muat ulang</button>
                </div>
            </div>
            <div id="tl-body"><div class="row" style="padding:16px"><span class="spinner"></span><span class="small muted">Memuat…</span></div></div>`;
    },

    async mount(root) {
        await load(root);
        root.querySelector("#tl-refresh").addEventListener("click", () => load(root));
        root.querySelector("#tl-search").addEventListener("input", e => paint(root, e.target.value.trim().toLowerCase()));
    }

};

async function load(root) {
    try {
        const data = await api.tools();
        allTools = data.tools ?? [];
        paint(root, "");
    }
    catch (e) {
        root.querySelector("#tl-body").innerHTML = `<div class="panel"><div class="empty">${icon("alert")}<div class="danger-text">${esc(e.message)}</div></div></div>`;
    }
}

function paint(root, q) {
    const body = root.querySelector("#tl-body");
    const list = q ? allTools.filter(t =>
        (t.name ?? "").toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)) : allTools;

    if (!list.length) {
        body.innerHTML = `<div class="panel"><div class="empty">${icon("tool")}<div>Tak ada tool.</div></div></div>`;
        return;
    }

    body.innerHTML = `<div class="grid cols-2">${list.map(card).join("")}</div>`;

    body.querySelectorAll("[data-run]").forEach(btn =>
        btn.addEventListener("click", () => run(btn.dataset.run)));
}

function card(t) {
    const params = Object.keys(t.parameters?.properties ?? {});
    const required = new Set(t.parameters?.required ?? []);
    return `
        <div class="panel agent-card">
            <div class="top">
                <span class="tile">${icon("tool")}</span>
                <div style="flex:1;min-width:0">
                    <div class="nm mono">${esc(t.name)}</div>
                    ${t.pluginId ? `<div class="rl">${esc(t.pluginId)}</div>` : ""}
                </div>
                <button class="btn ghost sm" data-run="${esc(t.name)}">${icon("play")} Jalankan</button>
            </div>
            ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}
            ${params.length ? `<div class="skills">${params.map(p =>
                `<span class="tag">${esc(p)}${required.has(p) ? "*" : ""}</span>`).join("")}</div>` : ""}
        </div>`;
}

async function run(name) {
    let args = {};
    const raw = window.prompt(`Argumen untuk "${name}" (JSON):`, "{}");
    if (raw === null) return;
    try { args = raw.trim() ? JSON.parse(raw) : {}; }
    catch { toast("JSON argumen tidak valid.", "warn"); return; }

    try {
        const r = await api.runTool(name, args);
        toast(`${name} selesai (${r.duration ?? 0}ms)`, "ok");
        window.alert(JSON.stringify(r.result, null, 2).slice(0, 4000));
    }
    catch (e) {
        toast(e.message, "danger");
    }
}
