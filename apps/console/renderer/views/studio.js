import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, toast } from "../lib/ui.js";

/**
 * Studio — tempat mengelola tool buatan Damar & buatan sendiri.
 *
 * Tiga bagian: draft menunggu persetujuan (karya Damar yang
 * belum aktif), tool aktif buatan pengguna, dan editor untuk
 * membuat/mengubah tool manual.
 */

// Form editor bertahan antar render selama satu sesi view.
let editing = null;

export const studio = {

    id: "studio",
    label: "Studio",
    icon: "tool",
    title: "Studio",
    subtitle: "Buat, tinjau, dan kelola tool buatan Damar maupun buatanmu.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Studio</h1>
                    <p>Buat, tinjau, dan kelola tool — buatan Damar maupun buatanmu.</p>
                </div>
                <div class="actions">
                    <button class="btn ghost sm" id="st-refresh">${icon("refresh")} Muat ulang</button>
                    <button class="btn primary sm" id="st-new">${icon("plus")} Tool baru</button>
                </div>
            </div>

            <div class="stack">
                <div id="st-drafts"></div>
                <div id="st-active"></div>
                <div class="panel" id="st-editor" style="display:none"></div>
            </div>`;

    },

    async mount(root) {

        root.querySelector("#st-refresh").addEventListener("click", () => load(root));

        root.querySelector("#st-new").addEventListener("click", () => {
            editing = blankForm();
            openEditor(root);
        });

        await load(root);

    },

    unmount() {
        editing = null;
    }

};

async function load(root) {

    const draftsHost = root.querySelector("#st-drafts");
    const activeHost = root.querySelector("#st-active");

    try {

        const data = await api.forgeList();

        draftsHost.innerHTML = draftsSection(data.drafts);
        activeHost.innerHTML = activeSection(data.active);

        wireDrafts(root);
        wireActive(root);

    }

    catch (error) {
        draftsHost.innerHTML =
            `<div class="panel"><div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div></div>`;
        activeHost.innerHTML = "";
    }

}

function draftsSection(drafts) {

    if (!drafts || drafts.length === 0) {
        return "";
    }

    return `
        <div class="panel" style="border-color:rgba(251,191,36,.3)">
            <div class="panel-head">
                <h2>${icon("alert")} Menunggu persetujuan</h2>
                <span class="hint push">${drafts.length} draft buatan Damar</span>
            </div>
            <div class="stack">
                ${drafts.map(d => `
                    <div class="list-item" data-draft="${esc(d.id)}" style="flex-wrap:wrap">
                        <div style="min-width:0;flex:1">
                            <div class="title">${esc(d.name)} <span class="tag mono">${esc(d.id)}</span></div>
                            <div class="sub">${esc(d.description || "—")}</div>
                            ${d.risks?.length
                                ? `<div class="small warn-text" style="margin-top:4px">${icon("alert")} ${d.risks.map(esc).join(" · ")}</div>`
                                : `<div class="small dim" style="margin-top:4px">tidak ada pola berisiko terdeteksi</div>`}
                        </div>
                        <button class="btn sm ghost" data-view-code>${icon("terminal")} Kode</button>
                        <button class="btn sm" data-approve>${icon("check")} Aktifkan</button>
                        <button class="btn sm danger" data-reject>${icon("x")} Tolak</button>
                        <pre class="code-view" data-code style="display:none"></pre>
                    </div>`).join("")}
            </div>
        </div>`;

}

function activeSection(active) {

    return `
        <div class="panel flush">
            <div class="panel-head" style="padding:16px 18px 0">
                <h2>Tool buatan sendiri</h2>
                <span class="hint push">${active.length}</span>
            </div>
            <div style="padding:10px 0 0">
                ${active.length === 0
                    ? `<div class="empty">${icon("tool")}
                        <div>Belum ada tool buatan sendiri.</div>
                        <div class="dim">Buat lewat tombol "Tool baru", atau minta Damar membuatnya lewat percakapan.</div></div>`
                    : active.map(t => `
                        <div class="list-item" data-active="${esc(t.id)}">
                            <div style="min-width:0;flex:1">
                                <div class="title">${esc(t.name)} <span class="tag mono">${esc(t.id)}</span>
                                    ${t.origin === "damar" ? pill("oleh Damar", "ok") : ""}</div>
                                <div class="sub">${esc(t.description || "—")}</div>
                            </div>
                            ${t.risks?.length ? `<span class="tag warn-text">${t.risks.length} risiko</span>` : ""}
                            <button class="btn sm ghost" data-edit>${icon("tool")} Edit</button>
                            <button class="btn sm danger" data-remove>${icon("trash")}</button>
                        </div>`).join("")}
            </div>
        </div>`;

}

function wireDrafts(root) {

    root.querySelectorAll("[data-draft]").forEach(row => {

        const id = row.dataset.draft;

        row.querySelector("[data-view-code]").addEventListener("click", async () => {
            const pre = row.querySelector("[data-code]");
            if (pre.style.display === "none") {
                const detail = await api.forgeRead(id);
                pre.textContent = detail.source;
                pre.style.display = "block";
            }
            else {
                pre.style.display = "none";
            }
        });

        row.querySelector("[data-approve]").addEventListener("click", async () => {
            try {
                await api.forgeApprove(id);
                toast(`Tool '${id}' diaktifkan`, "ok");
                await load(root);
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });

        row.querySelector("[data-reject]").addEventListener("click", async () => {
            if (!window.confirm(`Tolak & hapus draft '${id}'?`)) return;
            try {
                await api.forgeReject(id);
                toast(`Draft '${id}' ditolak`, "warn");
                await load(root);
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });

    });

}

function wireActive(root) {

    root.querySelectorAll("[data-active]").forEach(row => {

        const id = row.dataset.active;

        row.querySelector("[data-edit]").addEventListener("click", async () => {
            try {
                const detail = await api.forgeRead(id);
                editing = fromDetail(detail);
                openEditor(root);
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });

        row.querySelector("[data-remove]").addEventListener("click", async () => {
            if (!window.confirm(`Hapus tool '${id}'?`)) return;
            try {
                await api.forgeRemove(id);
                toast(`Tool '${id}' dihapus`, "ok");
                await load(root);
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });

    });

}

// ---- Editor ---------------------------------------------------------

function blankForm() {
    return {
        id: "",
        name: "",
        description: "",
        toolName: "",
        mode: "form",
        params: [{ name: "", type: "string", description: "", required: true, extra: "" }],
        code: "// args berisi parameter. Kembalikan objek hasil.\nreturn { ok: true };",
        raw: RAW_TEMPLATE,
        isEdit: false
    };
}

const RAW_TEMPLATE = `// Mode kode penuh — kamu menulis seluruh tool.js.
// Boleh lebih dari satu tool, import, dan helper.
class MyTool {
    constructor() {
        this.name = "myTool";
        this.description = "Apa yang dilakukan tool ini";
        // Parameter bebas: string/number/boolean/array/object/enum,
        // default, dll. Kosongkan {} untuk argumen bebas.
        this.parameters = {
            input: { type: "string", description: "masukan", required: true }
        };
    }
    async execute(context, args = {}) {
        return { ok: true, echo: args.input };
    }
}

module.exports = [ new MyTool() ];
`;

function fromDetail(detail) {

    const spec = detail.spec ?? {};

    // Tool mode kode penuh disimpan sebagai { raw }.
    if (spec.raw) {
        return {
            id: detail.id,
            name: detail.manifest?.name ?? detail.id,
            description: detail.manifest?.description ?? "",
            toolName: "",
            mode: "raw",
            params: [{ name: "", type: "string", description: "", required: true, extra: "" }],
            code: "return { ok: true };",
            raw: spec.raw,
            isEdit: true
        };
    }

    const params = Object.entries(spec.parameters ?? {}).map(([name, p]) => ({
        name,
        type: p.enum ? "enum" : (p.type ?? "string"),
        description: p.description ?? "",
        required: Boolean(p.required),
        extra: p.enum ? p.enum.join(", ") : (p.default !== undefined ? String(p.default) : "")
    }));

    return {
        id: detail.id,
        name: detail.manifest?.name ?? detail.id,
        description: spec.description ?? detail.manifest?.description ?? "",
        toolName: spec.toolName ?? "",
        mode: "form",
        params: params.length ? params : [{ name: "", type: "string", description: "", required: true, extra: "" }],
        code: spec.code ?? "return { ok: true };",
        raw: RAW_TEMPLATE,
        isEdit: true
    };

}

function openEditor(root) {

    const host = root.querySelector("#st-editor");

    host.style.display = "";

    host.innerHTML = `
        <div class="panel-head">
            <h2>${editing.isEdit ? "Edit tool" : "Tool baru"}</h2>
            <div class="tabs push" style="padding:3px">
                <button class="tab ${editing.mode === "form" ? "active" : ""}" data-mode="form">Formulir</button>
                <button class="tab ${editing.mode === "raw" ? "active" : ""}" data-mode="raw">Kode penuh</button>
            </div>
            <button class="btn ghost sm" id="ed-close" style="margin-left:8px">${icon("x")} Tutup</button>
        </div>

        <div class="grid cols-3" style="gap:10px">
            <div class="field">
                <label>Id plugin</label>
                <input type="text" id="ed-id" value="${esc(editing.id)}"
                    placeholder="ping-host" ${editing.isEdit ? "readonly" : ""}>
            </div>
            <div class="field">
                <label>Nama tampilan</label>
                <input type="text" id="ed-name" value="${esc(editing.name)}" placeholder="Ping Host">
            </div>
            <div class="field" data-form-only>
                <label>Nama fungsi (dipanggil model)</label>
                <input type="text" id="ed-toolname" value="${esc(editing.toolName)}" placeholder="pingHost">
            </div>
        </div>

        <div class="field">
            <label>Deskripsi</label>
            <input type="text" id="ed-desc" value="${esc(editing.description)}"
                placeholder="Apa yang dilakukan tool ini">
        </div>

        <div data-form-only>
            <div class="field">
                <label>Parameter <span class="dim">(kosongkan untuk argumen bebas)</span></label>
                <div id="ed-params" class="stack" style="gap:6px"></div>
                <button class="btn ghost sm" id="ed-addparam" style="align-self:flex-start;margin-top:6px">
                    ${icon("plus")} Parameter
                </button>
            </div>

            <div class="field">
                <label>Kode — badan fungsi execute(context, args)</label>
                <textarea id="ed-code" rows="8" spellcheck="false">${esc(editing.code)}</textarea>
                <span class="help">JavaScript (Node). Boleh require bawaan & fetch. Gunakan <span class="mono">return { ... }</span>.</span>
            </div>
        </div>

        <div class="field" data-raw-only>
            <label>tool.js — kode penuh</label>
            <textarea id="ed-raw" rows="16" spellcheck="false" class="mono">${esc(editing.raw)}</textarea>
            <span class="help">Seluruh isi tool.js. Boleh banyak tool, import, helper. Harus <span class="mono">module.exports = [ ... ]</span>.</span>
        </div>

        <div class="row" style="margin-top:8px">
            <button class="btn" id="ed-draft">${icon("check")} Simpan sebagai draft</button>
            <button class="btn primary" id="ed-activate">${icon("play")} Simpan &amp; aktifkan</button>
        </div>`;

    const applyMode = () => {
        host.querySelectorAll("[data-form-only]").forEach(el =>
            el.style.display = editing.mode === "form" ? "" : "none");
        host.querySelectorAll("[data-raw-only]").forEach(el =>
            el.style.display = editing.mode === "raw" ? "" : "none");
        host.querySelectorAll("[data-mode]").forEach(b =>
            b.classList.toggle("active", b.dataset.mode === editing.mode));
    };

    if (editing.mode === "form") {
        drawParams(host);
    }
    applyMode();

    host.querySelectorAll("[data-mode]").forEach(btn => {
        btn.addEventListener("click", () => {
            editing.mode = btn.dataset.mode;
            if (editing.mode === "form") drawParams(host);
            applyMode();
        });
    });

    host.querySelector("#ed-close").addEventListener("click", () => {
        host.style.display = "none";
        host.innerHTML = "";
        editing = null;
    });

    host.querySelector("#ed-addparam").addEventListener("click", () => {
        editing.params.push({ name: "", type: "string", description: "", required: false, extra: "" });
        drawParams(host);
    });

    host.querySelector("#ed-draft").addEventListener("click", () => save(root, false));
    host.querySelector("#ed-activate").addEventListener("click", () => save(root, true));

    host.scrollIntoView({ behavior: "smooth", block: "nearest" });

}

function drawParams(host) {

    const list = host.querySelector("#ed-params");

    const TYPES = ["string", "number", "boolean", "array", "object", "enum"];

    list.innerHTML = editing.params.map((p, i) => `
        <div class="row" data-param="${i}" style="gap:6px">
            <input type="text" data-p-name value="${esc(p.name)}" placeholder="nama" style="flex:1">
            <select data-p-type style="width:100px">
                ${TYPES.map(t => `<option value="${t}" ${t === p.type ? "selected" : ""}>${t}</option>`).join("")}
            </select>
            <input type="text" data-p-desc value="${esc(p.description)}" placeholder="deskripsi" style="flex:1.4">
            <input type="text" data-p-extra value="${esc(p.extra ?? "")}"
                placeholder="${p.type === "enum" ? "pilihan: a, b, c" : "default"}" style="flex:1"
                title="${p.type === "enum" ? "opsi enum, pisah koma" : "nilai default (opsional)"}">
            <label class="switch" title="wajib"><input type="checkbox" data-p-req ${p.required ? "checked" : ""}><span class="track"></span></label>
            <button class="icon-btn" data-p-del>${icon("x")}</button>
        </div>`).join("");

    list.querySelectorAll("[data-param]").forEach(rowEl => {
        const i = Number(rowEl.dataset.param);
        // Ubah placeholder kolom "extra" saat tipe berganti.
        rowEl.querySelector("[data-p-type]").addEventListener("change", (e) => {
            editing.params[i].type = e.target.value;
            editing.params[i].name = rowEl.querySelector("[data-p-name]").value;
            editing.params[i].description = rowEl.querySelector("[data-p-desc]").value;
            editing.params[i].extra = rowEl.querySelector("[data-p-extra]").value;
            editing.params[i].required = rowEl.querySelector("[data-p-req]").checked;
            drawParams(host);
        });
        rowEl.querySelector("[data-p-del]").addEventListener("click", () => {
            editing.params.splice(i, 1);
            if (editing.params.length === 0) {
                editing.params.push({ name: "", type: "string", description: "", required: false, extra: "" });
            }
            drawParams(host);
        });
    });

}

function collect(host) {

    // Mode kode penuh: kirim raw apa adanya.
    if (editing.mode === "raw") {
        return {
            id: host.querySelector("#ed-id").value.trim(),
            name: host.querySelector("#ed-name").value.trim(),
            description: host.querySelector("#ed-desc").value.trim(),
            origin: "manual",
            raw: host.querySelector("#ed-raw").value
        };
    }

    const params = {};

    host.querySelectorAll("[data-param]").forEach(rowEl => {
        const name = rowEl.querySelector("[data-p-name]").value.trim();
        if (!name) return;

        const type = rowEl.querySelector("[data-p-type]").value;
        const extra = rowEl.querySelector("[data-p-extra]").value.trim();

        const spec = {
            type: type === "enum" ? "string" : type,
            description: rowEl.querySelector("[data-p-desc]").value.trim(),
            required: rowEl.querySelector("[data-p-req]").checked
        };

        if (type === "enum" && extra) {
            spec.enum = extra.split(",").map(s => s.trim()).filter(Boolean);
        }
        else if (extra) {
            // Nilai default; angka/boolean dikonversi seperlunya.
            spec.default = type === "number" ? Number(extra)
                : type === "boolean" ? (extra === "true")
                : extra;
        }

        if (type === "array") {
            spec.items = { type: "string" };
        }

        params[name] = spec;
    });

    return {
        id: host.querySelector("#ed-id").value.trim(),
        name: host.querySelector("#ed-name").value.trim(),
        description: host.querySelector("#ed-desc").value.trim(),
        origin: "manual",
        tool: {
            name: host.querySelector("#ed-toolname").value.trim(),
            description: host.querySelector("#ed-desc").value.trim(),
            parameters: params,
            code: host.querySelector("#ed-code").value
        }
    };

}

async function save(root, activate) {

    const host = root.querySelector("#st-editor");

    const body = collect(host);

    const valid = body.raw
        ? (body.id && body.raw.trim())
        : (body.id && body.tool.name && body.tool.code.trim());

    if (!valid) {
        toast(body.raw
            ? "Id dan kode wajib diisi."
            : "Id, nama fungsi, dan kode wajib diisi.", "warn");
        return;
    }

    body.activate = activate;

    try {

        const result = await api.forgeCreate(body);

        toast(
            activate
                ? `Tool '${body.id}' aktif`
                : `Draft '${body.id}' disimpan${result.risks?.length ? ` (${result.risks.length} peringatan risiko)` : ""}`,
            "ok"
        );

        host.style.display = "none";
        host.innerHTML = "";
        editing = null;

        await load(root);

    }

    catch (error) {
        toast(error.message, "danger", 6000);
    }

}
