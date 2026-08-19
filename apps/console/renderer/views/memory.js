import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, relativeTime, truncateText, toast } from "../lib/ui.js";
import { createMemoryGraph } from "../lib/viz/memoryGraph.js";

/** Tab aktif dipertahankan antar kunjungan supaya tidak menyentak. */
let activeTab = "browse";

const TYPE_TONE = {
    semantic: "ok",
    episodic: "idle",
    preference: "warn",
    procedural: "danger"
};

export const memory = {

    id: "memory",
    label: "Memory",
    icon: "brain",
    title: "Memory",
    subtitle: "Apa yang diingat Aether tentang kamu dan rumahmu.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Memory</h1>
                    <p>Apa yang diingat Aether tentang kamu dan rumahmu.</p>
                </div>
                <div class="actions">
                    <button class="btn ghost sm" id="mem-backfill">${icon("cpu")} Isi embedding</button>
                    <button class="btn ghost sm" id="mem-consolidate">${icon("refresh")} Konsolidasi</button>
                </div>
            </div>

            <div class="stack">

                <div id="mem-stats" class="grid cols-4"></div>

                <div class="tabs" id="mem-tabs">
                    ${tab("graph", "Graf", "activity")}
                    ${tab("codegraph", "Graf Koding", "terminal")}
                    ${tab("browse", "Jelajah", "box")}
                    ${tab("search", "Cari", "activity")}
                    ${tab("entities", "Entitas", "link")}
                    ${tab("documents", "Dokumen", "terminal")}
                </div>

                <div id="mem-panel"></div>

            </div>`;

    },

    unmount() {
        // Lepas canvas graf saat meninggalkan view (hemat daya).
        graphViz?.destroy();
        graphViz = null;
    },

    async mount(root) {

        const panel = root.querySelector("#mem-panel");

        await drawStats(root);

        root.querySelectorAll("[data-tab]").forEach(button => {

            button.addEventListener("click", () => {
                activeTab = button.dataset.tab;
                syncTabs(root);
                open(panel, activeTab, root);
            });

        });

        syncTabs(root);

        await open(panel, activeTab, root);

        root.querySelector("#mem-backfill").addEventListener("click", async event => {

            const button = event.currentTarget;

            button.disabled = true;
            button.innerHTML = `<span class="spinner"></span> Mengisi…`;

            try {

                const result = await api.backfillEmbeddings();

                toast(
                    result.stopped
                        ? `Berhenti: ${result.reason ?? "Ollama tidak tersedia"}`
                        : `Terisi: ${result.memories} memori, ${result.chunks} chunk`,
                    result.stopped ? "warn" : "ok",
                    5000
                );

                await drawStats(root);

            }
            catch (error) {
                toast(error.message, "danger");
            }
            finally {
                button.disabled = false;
                button.innerHTML = `${icon("cpu")} Isi embedding`;
            }

        });

        root.querySelector("#mem-consolidate").addEventListener("click", async () => {

            try {

                const preview = await api.consolidate(true);

                const confirmed = window.confirm(
                    `Konsolidasi akan menghapus ${preview.stale} memori episodik yang tidak ` +
                    `pernah dipanggil dan menurunkan ${preview.expired} memori kedaluwarsa.\n\n` +
                    `Lanjutkan?`
                );

                if (!confirmed) {
                    return;
                }

                const result = await api.consolidate(false);

                toast(
                    `${result.removed} dihapus, ${result.expired} diturunkan`,
                    "ok"
                );

                await drawStats(root);

                await open(panel, activeTab, root);

            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

    }

};

function tab(id, label, iconName) {

    return `<button class="tab" data-tab="${id}">${icon(iconName)} ${esc(label)}</button>`;

}

function syncTabs(root) {

    root.querySelectorAll("[data-tab]").forEach(button => {
        button.classList.toggle("active", button.dataset.tab === activeTab);
    });

}

// ---- Statistik ------------------------------------------------------

async function drawStats(root) {

    const host = root.querySelector("#mem-stats");

    try {

        const stats = await api.memoryStats();

        const embed = stats.embeddings;

        const embedTone =
            embed.available === true ? "ok" :
            embed.available === false ? "danger" : "idle";

        const embedText =
            embed.available === true ? "Aktif" :
            embed.available === false ? "Mati" : "Belum dicek";

        host.innerHTML = `
            <div class="stat">
                <div class="label">${icon("memory")} Memori</div>
                <div class="value">${stats.memories.total}</div>
                <div class="meta">${
                    stats.memories.byType
                        .map(row => `${row.total} ${row.type}`)
                        .join(" · ") || "belum ada"
                }</div>
                <div class="meta dim">${stats.memories.pinned} disematkan</div>
            </div>

            <div class="stat">
                <div class="label">${icon("link")} Entitas</div>
                <div class="value">${stats.entities.total}</div>
                <div class="meta">${
                    stats.entities.byKind
                        .slice(0, 3)
                        .map(row => `${row.total} ${row.kind}`)
                        .join(" · ") || "belum ada"
                }</div>
                <div class="meta dim">orang, kendaraan, ruangan…</div>
            </div>

            <div class="stat">
                <div class="label">${icon("terminal")} Dokumen</div>
                <div class="value">${stats.documents.total}</div>
                <div class="meta">${stats.documents.chunks} potongan</div>
                <div class="meta dim">${Math.round((stats.documents.characters ?? 0) / 1000)}rb karakter</div>
            </div>

            <div class="stat">
                <div class="label">${icon("cpu")} Embedding</div>
                <div class="value" style="font-size:17px">${pill(embedText, embedTone)}</div>
                <div class="meta mono">${esc(embed.model)}</div>
                <div class="meta dim">${embed.vectors} vektor${
                    embed.lastError ? ` · ${esc(embed.lastError)}` : ""
                }</div>
            </div>`;

    }

    catch (error) {

        host.innerHTML = `<div class="panel" style="grid-column:1/-1">
            <div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div>
        </div>`;

    }

}

// ---- Tab ------------------------------------------------------------

async function open(panel, tabId, root) {

    panel.innerHTML = `<div class="panel"><div class="row">
        <span class="spinner"></span><span class="small muted">Memuat…</span>
    </div></div>`;

    try {

        if (tabId === "graph")    return await drawGraph(panel, root);
        if (tabId === "codegraph") return await drawCodeGraph(panel);
        if (tabId === "browse")    return await drawBrowse(panel, root);
        if (tabId === "search")    return await drawSearch(panel, root);
        if (tabId === "entities")  return await drawEntities(panel, root);
        if (tabId === "documents") return await drawDocuments(panel, root);

    }

    catch (error) {

        panel.innerHTML = `<div class="panel">
            <div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div>
        </div>`;

    }

}

// ---- Graf jaringan (visualisasi kanonik) ----------------------------

let graphViz = null;

async function drawGraph(panel, root) {

    const query = new URLSearchParams({ limit: "90" });
    const [memRes, entRes] = await Promise.all([
        api.memories({ limit: 90 }).catch(() => ({ items: [] })),
        api.entities({ limit: 40 }).catch(() => ({ items: [] }))
    ]);

    panel.innerHTML = `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("memory")} Jaringan memori</h2>
                <span class="hint push">violet = episodik · cyan = semantik · biru = prosedural</span>
            </div>
            <p class="small dim" style="margin:-6px 0 12px">
                Aether adalah pusat; memori &amp; entitas mengorbit. Node terang = kepentingan tinggi.
                Arahkan kursor untuk isi eksak; klik untuk memilih.
            </p>
            <div class="viz-host tall" id="mem-graph"></div>
        </div>`;

    const host = panel.querySelector("#mem-graph");
    graphViz?.destroy();
    graphViz = createMemoryGraph(host);
    graphViz.setData({
        memories: memRes.items ?? [],
        entities: entRes.items ?? []
    });

    host.addEventListener("node-select", (e) => {
        const d = e.detail;
        if (!d) return;
        if (d.id.startsWith("m:")) {
            const id = d.id.slice(2);
            api.memory(id).then(m => toast(truncateText(m.content ?? d.label, 80), "info"))
                .catch(() => toast(d.label.slice(0, 80), "info"));
        }
    });
}

// ---- Graf Koding (graphify AST) -------------------------------------

async function drawCodeGraph(panel) {

    panel.innerHTML = `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("terminal")} Graf koding</h2>
                <span class="hint push">struktur repo via graphify — node = simbol, garis = relasi AST</span>
            </div>
            <p class="small dim" style="margin:-6px 0 12px">
                Node paling terhubung. Klik node untuk detail; geser untuk menggeser, gulir untuk zoom.
            </p>
            <canvas id="code-graph-cv" style="width:100%;height:min(72vh,760px);border:1px solid var(--glass-line);border-radius:10px;background:rgba(5,9,16,0.5);cursor:grab"></canvas>
            <div class="small dim" id="code-graph-info" style="margin-top:8px">memuat…</div>
        </div>`;

    let data;
    try {
        data = await api.graphCoding(150);
    }
    catch (e) {
        panel.innerHTML = `<div class="panel"><div class="empty">${icon("alert")}<div class="danger-text">${esc(e.message)}</div></div></div>`;
        return;
    }

    const info = panel.querySelector("#code-graph-info");
    info.textContent = `${data.totalNodes} simbol · ${data.totalLinks} relasi total — menampilkan ${data.nodes.length} node utama (commit ${String(data.builtAt ?? "").slice(0, 8) || "?"})`;

    // Simulasi force sederhana.
    const cv = panel.querySelector("#code-graph-cv");
    const ctx = cv.getContext("2d");
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);

    const N = data.nodes.map((n, i) => ({
        ...n,
        x: W / 2 + Math.cos(i * 2.4) * (60 + (i % 17) * 14),
        y: H / 2 + Math.sin(i * 2.4) * (50 + (i % 13) * 12),
        vx: 0, vy: 0
    }));
    const byId = new Map(N.map(n => [n.id, n]));
    const L = data.links
        .map(l => ({ a: byId.get(l.source), b: byId.get(l.target) }))
        .filter(({ a, b }) => a && b);

    const maxDeg = Math.max(...N.map(n => n.degree), 1);
    const colorFor = n => {
        if (/test/i.test(n.file ?? "")) return "#FFC857";
        if (/console|renderer/.test(n.file ?? "")) return "#00DFFF";
        if (/services/.test(n.file ?? "")) return "#FFB84D";
        if (/memory/.test(n.file ?? "")) return "#7C5CFF";
        if (/autonomy|agent/.test(n.file ?? "")) return "#48E6A5";
        return "#73EDFF";
    };

    let pan = { x: 0, y: 0 }, zoom = 1, drag = null, hover = null, run = true;

    const toScreen = (n) => ({ x: (n.x + pan.x) * zoom + W / 2, y: (n.y + pan.y) * zoom + H / 2 });

    cv.addEventListener("pointerdown", e => { drag = { x: e.offsetX, y: e.offsetY, px: pan.x, py: pan.y }; cv.style.cursor = "grabbing"; });
    cv.addEventListener("pointerup", () => { drag = null; cv.style.cursor = "grab"; });
    cv.addEventListener("pointerleave", () => { drag = null; hover = null; });
    cv.addEventListener("pointermove", e => {
        if (drag) { pan.x = drag.px + (e.offsetX - drag.x) / zoom; pan.y = drag.py + (e.offsetY - drag.y) / zoom; }
        const mx = e.offsetX, my = e.offsetY;
        hover = N.find(n => { const s = toScreen(n); return Math.hypot(s.x - mx, s.y - my) < rOf(n) + 3; }) ?? null;
    });
    cv.addEventListener("wheel", e => { e.preventDefault(); zoom = Math.min(3, Math.max(0.35, zoom * (e.deltaY < 0 ? 1.12 : 0.89))); }, { passive: false });
    cv.addEventListener("click", () => {
        if (hover) info.innerHTML = `<b class="mono">${esc(hover.label)}</b> <span class="dim">— ${esc(hover.file ?? "?")}${hover.line ?? ""} · ${hover.degree} relasi</span>`;
    });

    const rOf = n => 3 + (n.degree / maxDeg) * 8;

    function step() {
        // gaya: tolakan ringan + tarik link + sentral
        for (let i = 0; i < N.length; i++) {
            const a = N[i];
            for (let j = i + 1; j < N.length; j++) {
                const b = N[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const d2 = dx * dx + dy * dy + 0.01;
                if (d2 < 8000) {
                    const f = 26 / d2;
                    a.vx -= dx * f; a.vy -= dy * f;
                    b.vx += dx * f; b.vy += dy * f;
                }
            }
            a.vx += -a.x * 0.0016; a.vy += -a.y * 0.0016;
        }
        for (const { a, b } of L) {
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy) || 1;
            const f = (d - 90) * 0.012;
            a.vx += dx / d * f; a.vy += dy / d * f;
            b.vx -= dx / d * f; b.vy -= dy / d * f;
        }
        for (const n of N) { n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy; }
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);

        // garis relasi
        ctx.strokeStyle = "rgba(115, 237, 255, 0.13)";
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (const { a, b } of L) {
            const s1 = toScreen(a), s2 = toScreen(b);
            ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
        }
        ctx.stroke();

        // node
        for (const n of N) {
            const s = toScreen(n);
            const r = rOf(n) * zoom;
            const c = colorFor(n);
            const isHover = n === hover;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
            ctx.fillStyle = c;
            ctx.globalAlpha = isHover ? 1 : 0.8;
            ctx.shadowColor = c; ctx.shadowBlur = isHover ? 18 : 7;
            ctx.fill();
            ctx.shadowBlur = 0; ctx.globalAlpha = 1;
            if (zoom > 1.4 || isHover) {
                ctx.fillStyle = "rgba(216, 231, 242, 0.9)";
                ctx.font = `${Math.max(9, 10 * Math.min(zoom, 1.6))}px ui-monospace, monospace`;
                ctx.fillText(n.label.slice(0, 24), s.x + r + 4, s.y + 3);
            }
        }
    }

    // animasi: panas turun bertahap, lalu statis hemat CPU.
    let heat = 240;
    (function loop() {
        if (!cv.isConnected) { run = false; return; }
        if (heat > 0) { step(); heat--; }
        draw();
        requestAnimationFrame(loop);
    })();
}

async function drawBrowse(panel, root) {

    const result = await api.memories({ limit: 100 });

    panel.innerHTML = `
        <div class="panel flush">
            <div class="panel-head" style="padding:16px 18px 0">
                <h2>Memori terbaru</h2>
                <span class="hint push">${result.total} total</span>
            </div>
            <div style="padding:10px 0 0">
                ${result.items.length === 0
                    ? `<div class="empty">${icon("memory")}<div>Belum ada memori.</div>
                        <div class="dim">Memori terisi saat kamu mengobrol atau menyimpannya manual.</div></div>`
                    : result.items.map(memoryRow).join("")}
            </div>
        </div>

        <div class="panel" style="margin-top:14px">
            <div class="panel-head"><h2>Tambah memori manual</h2></div>
            <div class="stack">
                <div class="field">
                    <label>Isi</label>
                    <textarea id="new-content" rows="3"
                        placeholder="mis. NAS di rumah merek Synology DS923+, IP 192.168.1.20"></textarea>
                </div>
                <div class="grid cols-3" style="gap:10px">
                    <div class="field">
                        <label>Tipe</label>
                        <select id="new-type">
                            <option value="semantic">semantic — fakta umum</option>
                            <option value="episodic">episodic — peristiwa</option>
                            <option value="preference">preference — kebiasaan</option>
                            <option value="procedural">procedural — cara</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>Kepentingan</label>
                        <input type="range" id="new-importance" min="0" max="1" step="0.05" value="0.7">
                    </div>
                    <div class="field">
                        <label>Entitas (pisahkan koma)</label>
                        <input type="text" id="new-entities" placeholder="NAS, Ruang Kerja">
                    </div>
                </div>
                <div class="row">
                    <button class="btn primary sm" id="new-save">${icon("plus")} Simpan</button>
                </div>
            </div>
        </div>`;

    wireMemoryRows(panel, root);

    panel.querySelector("#new-save").addEventListener("click", async () => {

        const content = panel.querySelector("#new-content").value.trim();

        if (!content) {
            toast("Isi memori tidak boleh kosong.", "warn");
            return;
        }

        try {

            await api.remember({
                content,
                type: panel.querySelector("#new-type").value,
                importance: Number(panel.querySelector("#new-importance").value),
                entities: panel.querySelector("#new-entities").value
                    .split(",")
                    .map(name => name.trim())
                    .filter(Boolean)
            });

            toast("Memori disimpan", "ok");

            await drawStats(root);

            await drawBrowse(panel, root);

        }
        catch (error) {
            toast(error.message, "danger");
        }

    });

}

async function drawSearch(panel, root) {

    panel.innerHTML = `
        <div class="panel">
            <div class="row">
                <input type="text" id="recall-query" style="flex:1"
                    placeholder="Tanyakan apa saja — mis. apa yang terjadi di garasi">
                <button class="btn primary" id="recall-go">${icon("activity")} Cari</button>
            </div>
            <div class="small dim" style="margin-top:8px">
                Pencarian menggabungkan kata kunci, entitas yang disebut, dan kemiripan makna
                (bila embedding tersedia).
            </div>
        </div>
        <div id="recall-out" style="margin-top:14px"></div>`;

    const input = panel.querySelector("#recall-query");
    const out = panel.querySelector("#recall-out");

    const run = async () => {

        const query = input.value.trim();

        if (!query) {
            return;
        }

        out.innerHTML = `<div class="panel"><div class="row">
            <span class="spinner"></span><span class="small muted">Mencari…</span></div></div>`;

        try {

            const result = await api.recall({ query, limit: 12 });

            out.innerHTML = `
                <div class="panel flush">
                    <div class="panel-head" style="padding:16px 18px 0">
                        <h2>Hasil</h2>
                        <span class="hint push">
                            strategi: ${result.strategies.map(s => `<span class="tag">${esc(s)}</span>`).join(" ") || "—"}
                            ${result.entities.length
                                ? ` · entitas: ${result.entities.map(e => esc(e.name)).join(", ")}`
                                : ""}
                        </span>
                    </div>
                    <div style="padding:10px 0 0">
                        ${result.items.length === 0
                            ? `<div class="empty">${icon("activity")}<div>Tidak ada memori cocok.</div></div>`
                            : result.items.map(item => memoryRow(item, true)).join("")}
                    </div>
                </div>

                ${result.documents.length ? `
                <div class="panel" style="margin-top:14px">
                    <div class="panel-head"><h2>Kutipan dokumen</h2></div>
                    <div class="stack">
                        ${result.documents.map(doc => `
                            <div class="quote">
                                <div class="row">
                                    <span class="small mono">${esc(doc.title ?? "dokumen")}</span>
                                    ${doc.heading ? `<span class="tag">${esc(doc.heading)}</span>` : ""}
                                    <span class="small dim push mono">${doc.score}</span>
                                </div>
                                <div class="small muted selectable" style="margin-top:5px">${esc(doc.excerpt)}</div>
                            </div>`).join("")}
                    </div>
                </div>` : ""}`;

            wireMemoryRows(out, root);

        }

        catch (error) {
            out.innerHTML = `<div class="panel"><div class="empty">${icon("alert")}
                <div class="danger-text">${esc(error.message)}</div></div></div>`;
        }

    };

    panel.querySelector("#recall-go").addEventListener("click", run);

    input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            run();
        }
    });

    input.focus();

}

async function drawEntities(panel, root) {

    const result = await api.entities({ limit: 200 });

    panel.innerHTML = `
        <div class="panel flush">
            <div class="panel-head" style="padding:16px 18px 0">
                <h2>Entitas dikenal</h2>
                <span class="hint push">${result.total}</span>
            </div>
            <div class="scroll-x" style="padding:10px 0 0">
                ${result.entities.length === 0
                    ? `<div class="empty">${icon("link")}<div>Belum ada entitas.</div></div>`
                    : `<table class="table">
                        <thead><tr>
                            <th>Nama</th><th>Jenis</th><th>Alias</th>
                            <th>Atribut</th><th>Terakhir</th><th style="width:1%"></th>
                        </tr></thead>
                        <tbody>
                            ${result.entities.map(entity => `
                                <tr data-entity="${entity.id}">
                                    <td><strong>${esc(entity.name)}</strong></td>
                                    <td><span class="tag">${esc(entity.kind)}</span></td>
                                    <td class="small muted">${esc(entity.aliases.join(", ")) || "—"}</td>
                                    <td class="small mono dim">${
                                        esc(truncateText(JSON.stringify(entity.attributes ?? {}), 46))
                                    }</td>
                                    <td class="small dim">${relativeTime(entity.lastSeenAt)}</td>
                                    <td><button class="btn sm danger" data-drop-entity>${icon("trash")}</button></td>
                                </tr>`).join("")}
                        </tbody>
                    </table>`}
            </div>
        </div>

        <div class="panel" style="margin-top:14px">
            <div class="panel-head"><h2>Tambah entitas</h2></div>
            <div class="grid cols-4" style="gap:10px;align-items:end">
                <div class="field"><label>Nama</label><input type="text" id="ent-name" placeholder="Ruang Tamu"></div>
                <div class="field">
                    <label>Jenis</label>
                    <select id="ent-kind">
                        ${["person","vehicle","room","device","project","place","organization","file","pet","other"]
                            .map(kind => `<option value="${kind}">${kind}</option>`).join("")}
                    </select>
                </div>
                <div class="field"><label>Alias (koma)</label><input type="text" id="ent-alias" placeholder="istri, bunda"></div>
                <div><button class="btn primary" id="ent-add" style="width:100%">${icon("plus")} Tambah</button></div>
            </div>
        </div>`;

    panel.querySelectorAll("[data-drop-entity]").forEach(button => {

        button.addEventListener("click", async () => {

            const id = button.closest("[data-entity]").dataset.entity;

            if (!window.confirm("Hapus entitas ini? Kaitannya dengan memori ikut hilang.")) {
                return;
            }

            try {
                await api.removeEntity(id);
                toast("Entitas dihapus", "ok");
                await drawStats(root);
                await drawEntities(panel, root);
            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

    });

    panel.querySelector("#ent-add").addEventListener("click", async () => {

        const name = panel.querySelector("#ent-name").value.trim();

        if (!name) {
            toast("Nama wajib diisi.", "warn");
            return;
        }

        try {

            await api.createEntity({
                name,
                kind: panel.querySelector("#ent-kind").value,
                aliases: panel.querySelector("#ent-alias").value
                    .split(",").map(a => a.trim()).filter(Boolean)
            });

            toast("Entitas ditambahkan", "ok");

            await drawStats(root);

            await drawEntities(panel, root);

        }
        catch (error) {
            toast(error.message, "danger");
        }

    });

}

async function drawDocuments(panel, root) {

    const result = await api.documents();

    // Pemilih native tersedia hanya di dalam Console (Electron).
    const hasPicker = Boolean(window.aether?.dialog?.openFile);

    panel.innerHTML = `
        <div class="panel">
            <div class="panel-head"><h2>Baca dokumen baru</h2></div>
            <div class="stack">
                ${hasPicker
                    ? `<div class="row">
                        <button class="btn" id="doc-file">${icon("terminal")} Pilih berkas…</button>
                        <button class="btn" id="doc-dir">${icon("folder")} Pilih folder…</button>
                        <span class="small dim" id="doc-picked"></span>
                    </div>
                    <div class="small dim">
                        Klik untuk memilih langsung dari komputer ini — tak perlu mengetik path.
                        Didukung: PDF, DOCX, Markdown, TXT, CSV, JSON, HTML, dan berkas kode.
                    </div>`
                    : `<div class="row">
                        <input type="text" id="doc-path" style="flex:1"
                            placeholder="Path berkas atau folder di mesin tempat daemon berjalan">
                        <button class="btn" id="doc-file">${icon("terminal")} Berkas</button>
                        <button class="btn" id="doc-dir">${icon("folder")} Folder</button>
                    </div>
                    <div class="small dim">
                        Didukung: PDF, DOCX, Markdown, TXT, CSV, JSON, HTML, dan berkas kode.
                        Path dibaca oleh daemon.
                    </div>`}
                <div class="divider" style="margin:6px 0"></div>
                <div class="field">
                    <label>Atau tempel teks langsung</label>
                    <textarea id="doc-text" rows="3" placeholder="Tempel catatan, artikel, atau transkrip…"></textarea>
                </div>
                <div class="row">
                    <input type="text" id="doc-title" placeholder="Judul (opsional)" style="max-width:280px">
                    <button class="btn primary sm" id="doc-paste">${icon("plus")} Simpan teks</button>
                </div>
            </div>
        </div>

        <div class="panel flush" style="margin-top:14px">
            <div class="panel-head" style="padding:16px 18px 0">
                <h2>Dokumen tersimpan</h2>
                <span class="hint push">${result.total}</span>
            </div>
            <div style="padding:10px 0 0">
                ${result.items.length === 0
                    ? `<div class="empty">${icon("terminal")}<div>Belum ada dokumen.</div></div>`
                    : result.items.map(document => `
                        <div class="list-item" data-doc="${document.id}">
                            <div style="min-width:0;flex:1">
                                <div class="title">${esc(document.title ?? document.uri)}</div>
                                <div class="sub mono truncate" title="${esc(document.uri)}">${esc(document.uri)}</div>
                            </div>
                            <span class="tag">${esc(document.mediaType ?? "?")}</span>
                            <span class="tag">${document.chunkCount} chunk</span>
                            ${document.status === "ready"
                                ? pill("siap", "ok")
                                : pill(document.status, "warn")}
                            <span class="small dim">${relativeTime(document.ingestedAt)}</span>
                            <button class="btn sm danger" data-drop-doc>${icon("trash")}</button>
                        </div>`).join("")}
            </div>
        </div>`;

    const pathInput = panel.querySelector("#doc-path");
    const picked = panel.querySelector("#doc-picked");

    const ingest = async (body, button) => {

        const original = button.innerHTML;

        button.disabled = true;
        button.innerHTML = `<span class="spinner"></span> Membaca…`;

        try {

            const outcome = await api.ingest(body);

            if (outcome.ingested) {
                toast(
                    `Folder: ${outcome.ingested.length} dibaca, ` +
                    `${outcome.skipped.length} dilewati, ${outcome.failed.length} gagal`,
                    outcome.failed.length ? "warn" : "ok",
                    6000
                );
            }
            else {
                toast(
                    outcome.skipped
                        ? "Dokumen sudah pernah dibaca"
                        : `Dibaca: ${outcome.chunks} potongan, ${outcome.embedded ?? 0} ter-embed`,
                    "ok",
                    5000
                );
            }

            await drawStats(root);

            await drawDocuments(panel, root);

        }

        catch (error) {
            toast(error.message, "danger", 6000);
        }

        finally {
            button.disabled = false;
            button.innerHTML = original;
        }

    };

    panel.querySelector("#doc-file").addEventListener("click", async event => {

        const button = event.currentTarget;

        if (hasPicker) {
            const path = await window.aether.dialog.openFile();
            if (!path) return;                          // dibatalkan
            if (picked) picked.textContent = path;
            return ingest({ path }, button);
        }

        if (!pathInput.value.trim()) {
            toast("Isi path berkas dulu.", "warn");
            return;
        }

        ingest({ path: pathInput.value.trim() }, button);

    });

    panel.querySelector("#doc-dir").addEventListener("click", async event => {

        const button = event.currentTarget;

        if (hasPicker) {
            const dir = await window.aether.dialog.openDirectory();
            if (!dir) return;                           // dibatalkan
            if (picked) picked.textContent = dir;
            return ingest({ directory: dir }, button);
        }

        if (!pathInput.value.trim()) {
            toast("Isi path folder dulu.", "warn");
            return;
        }

        ingest({ directory: pathInput.value.trim() }, button);

    });

    panel.querySelector("#doc-paste").addEventListener("click", event => {

        const text = panel.querySelector("#doc-text").value.trim();

        if (!text) {
            toast("Teks kosong.", "warn");
            return;
        }

        ingest({
            text,
            title: panel.querySelector("#doc-title").value.trim() || undefined
        }, event.currentTarget);

    });

    panel.querySelectorAll("[data-drop-doc]").forEach(button => {

        button.addEventListener("click", async () => {

            const id = button.closest("[data-doc]").dataset.doc;

            if (!window.confirm("Hapus dokumen ini beserta seluruh potongannya?")) {
                return;
            }

            try {
                await api.removeDocument(id);
                toast("Dokumen dihapus", "ok");
                await drawStats(root);
                await drawDocuments(panel, root);
            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

    });

}

// ---- Bagian bersama --------------------------------------------------

function memoryRow(item, showScore = false) {

    const tone = TYPE_TONE[item.type] ?? "idle";

    return `
        <div class="list-item" data-memory="${item.id}">
            <div style="min-width:0;flex:1">
                <div class="title selectable">${esc(item.content)}</div>
                <div class="sub row wrap" style="gap:6px;margin-top:4px">
                    ${pill(item.type, tone)}
                    <span class="tag">${esc(item.source)}</span>
                    ${(item.entities ?? []).map(entity =>
                        `<span class="tag">${esc(entity.name)}</span>`).join("")}
                    <span class="dim">${relativeTime(item.occurredAt)}</span>
                    ${item.pinned ? `<span class="tag ok-text">disematkan</span>` : ""}
                    ${showScore && item.scoring
                        ? `<span class="dim mono">kw ${item.scoring.keyword} · vec ${item.scoring.vector} · Σ ${item.scoring.total}</span>`
                        : `<span class="dim mono">bobot ${item.importance}</span>`}
                </div>
            </div>
            <button class="btn sm ghost" data-pin title="Sematkan / lepas">${
                item.pinned ? icon("x") : icon("check")
            }</button>
            <button class="btn sm danger" data-drop>${icon("trash")}</button>
        </div>`;

}

function wireMemoryRows(scope, root) {

    scope.querySelectorAll("[data-drop]").forEach(button => {

        button.addEventListener("click", async () => {

            const row = button.closest("[data-memory]");

            try {
                await api.forget(row.dataset.memory);
                row.remove();
                toast("Memori dihapus", "ok");
                await drawStats(root);
            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

    });

    scope.querySelectorAll("[data-pin]").forEach(button => {

        button.addEventListener("click", async () => {

            const row = button.closest("[data-memory]");

            const pinned = row.querySelector(".ok-text") !== null;

            try {
                await api.updateMemory(row.dataset.memory, { pinned: !pinned });
                toast(pinned ? "Sematan dilepas" : "Memori disematkan", "ok");
                await drawStats(root);
            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

    });

}
