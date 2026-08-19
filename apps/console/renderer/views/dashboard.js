import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, relativeTime, truncateText, toast } from "../lib/ui.js";
import { createOrbitalGauge } from "../lib/viz/orbitalGauge.js";
import { createTimeline } from "../lib/viz/timeline.js";
import { aetherState } from "../lib/aetherState.js";
import { agentBus } from "../lib/agentBus.js";
import { showBubble, wireTaskBubbles, clearBubbles } from "../lib/homeBubbles.js";
import { chat } from "./chat.js";
import { createHologram } from "../lib/hologram.js";

/**
 * Dashboard — "Mission Control" Aether.
 *
 * Satu layar yang menjawab dalam 3 detik: apakah sistem sehat, apa yang
 * sedang dikerjakan AI, apa yang menunggu keputusanku, dan bagaimana
 * kondisi rumah. Bagian inti digambar dari overview (sinkron); panel
 * yang butuh data lain (agents/usulan/rumah/CCTV) diisi saat mount
 * dengan degradasi anggun bila sumbernya belum ada.
 */

let clockTimer = null;

/** Minibot di kartu AI; disimpan agar bisa dihentikan saat unmount. */
let orb = null;

/** Bubble wiring di Beranda. */
let unwireTasks = null;

/** Segarkan panel memori setelah task selesai (arsip bubble). */
function refreshMemories(root) {
    enrichProposals(root).catch(() => { /* abaikan */ });
}

export const dashboard = {

    id: "dashboard",
    label: "Dashboard",
    icon: "dashboard",
    title: "Mission Control",
    subtitle: "Kendali seluruh sistem Aether dalam satu layar.",

    render(root) {

        const state = store.get();

        if (!state.connected || !state.overview) {
            root.innerHTML = disconnected(state);
            return;
        }

        const o = state.overview;

        root.innerHTML = `
        <div class="mc-env">

            <!-- Zona inti: entitas (tanpa ring/cincin dekoratif) -->
            <div class="mc-core-zone">
                <div class="mc-core-holo" id="mc-orb"></div>
                <div class="mc-core-title">
                    <span class="hello">${greeting()} —</span>
                    <h1>Aether <span class="dot">.</span></h1>
                    <span class="mc-core-sub" id="mc-time">--:--</span>
                </div>
            </div>

            <!-- Busur kiri: sistem → aliran → sumber daya → anak buah
                 (satu kolom stack, tanpa orbit bawah = tanpa scroll) -->
            <div class="mc-col left">
                <div class="mc-float">
                    <div class="mc-float-head">${icon("server")} <span>Sistem</span>
                        <b class="push">${o.integrations.summary.online}/${o.integrations.summary.enabled}</b></div>
                    <div id="mc-system">${systemStatusSync(o)}</div>
                </div>
                <div class="mc-float">
                    <div class="mc-float-head">${icon("activity")} <span>Aliran</span>
                        <b class="push">${state.logs.length}</b></div>
                    <div class="mc-flow">${flow(state.logs)}</div>
                </div>
                <div class="mc-float">
                    <div class="mc-float-head">${icon("orb")} <span>Anak Buah</span>
                        <b class="push" id="mc-agents-count">—</b></div>
                    <div id="mc-agents"><div class="mc-skeleton">Memuat…</div></div>
                </div>
                <!-- Dua gauge bulat yang dulu mengambang di tengah layar
                     tanpa keterangan apa pun kini pulang ke sini: CPU dan
                     RAM memang bagian dari Sumber Daya, dan berdampingan
                     dengan riwayatnya barulah angkanya punya arti. -->
                <div class="mc-float">
                    <div class="mc-float-head">${icon("cpu")} <span>Sumber Daya</span>
                        <b class="push">${esc(o.stats.host.cpuCount)} core</b></div>
                    <div class="mc-res">
                        <div class="mc-gauges" id="mv-gauges"></div>
                        <div class="viz-host slim" id="mv-timeline" aria-label="Riwayat CPU"></div>
                    </div>
                </div>
            </div>

            <!-- Busur kanan: kognisi -->
            <div class="mc-col right">
                <div class="mc-float">
                    <div class="mc-float-head">${icon("chat")} <span>Aether</span>
                        <b class="push">siap</b></div>
                    <div id="mc-chat"></div>
                </div>
                <div class="mc-float">
                    <div class="mc-float-head">${icon("memory")} <span>Memori</span>
                        <b class="push" id="mc-prop-count">—</b></div>
                    <div id="mc-proposals"><div class="mc-skeleton">Memuat…</div></div>
                </div>
            </div>

        </div>`;
    },

    mount(root) {

        tickClock(root);
        clearInterval(clockTimer);
        clockTimer = setInterval(() => tickClock(root), 1000);

        // Entitas Aether — pusat lingkungan (via bus).
        const orbEl = root.querySelector("#mc-orb");
        if (orbEl) {
            orb?.destroy();
            orb = createHologram({ maxFps: 60 });
            orbEl.appendChild(orb.el);
            aetherState.set(store.get().connected ? "idle" : "offline");
        }

        // Visualisasi kanonik: gauge orbital + timeline.
        const state = store.get();
        if (state.overview) mountViz(state.overview, state.history);

        if (!store.get().connected) return;

        // Bubble transient + timeline task (host dikelola homeBubbles).
        unwireTasks = wireTaskBubbles({
            onArchive: () => refreshMemories(root)
        });

        // Chat tertanam: pakai ulang modul chat (streaming + alur) di panel.
        const chatEl = root.querySelector("#mc-chat");
        if (chatEl) {
            chat.render(chatEl);
            chat.mount(chatEl, { bubbles: true });
        }

        enrichAgents(root);

        // Panel sistem diisi async agar baris OpenCode ikut (cek live).
        systemStatus(store.get().overview).then(html => {
            const el = document.getElementById("mc-system");
            if (el) el.innerHTML = html;
        }).catch(() => { /* biarkan versi sinkron */ });
        enrichProposals(root);
    },

    unmount() {
        clearInterval(clockTimer);
        clockTimer = null;
        orb?.destroy();
        orb = null;
        unwireTasks?.();
        unwireTasks = null;
        clearBubbles();
        try { chat.unmount?.(); } catch { /* abaikan */ }
    }

};

// ---- Bagian sinkron (dari overview) ---------------------------------

function greeting() {
    const h = new Date().getHours();
    if (h < 11) return "Selamat pagi";
    if (h < 15) return "Selamat siang";
    if (h < 18) return "Selamat sore";
    return "Selamat malam";
}

function tickClock(root) {
    const now = new Date();
    const t = root.querySelector("#mc-time");
    const d = root.querySelector("#mc-date");
    if (t) t.textContent = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (d) d.textContent = now.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}




/** Gauge orbital kanonik (CPU/RAM) + timeline riwayat — dipasang setelah render. */
function mountViz(o, history) {

    const gaugesHost = document.getElementById("mv-gauges");
    if (gaugesHost && !gaugesHost.childElementCount) {
        gaugesHost.innerHTML = `
            <div class="viz-host slim" style="height:76px" id="mv-gauge-cpu" title="Pemakaian CPU"></div>
            <div class="viz-host slim" style="height:76px" id="mv-gauge-ram" title="Pemakaian RAM"></div>`;
        const cpuTone = o.stats.cpu.usage > 90 ? "red" : o.stats.cpu.usage > 70 ? "yellow" : "cyan";
        const ramTone = o.stats.memory.usedPercent > 90 ? "red" : o.stats.memory.usedPercent > 75 ? "yellow" : "cyan";
        createOrbitalGauge(gaugesHost.children[0], { label: "CPU" }).set(o.stats.cpu.usage / 100, cpuTone);
        createOrbitalGauge(gaugesHost.children[1], { label: "RAM" }).set(o.stats.memory.usedPercent / 100, ramTone);
    }

    const tlHost = document.getElementById("mv-timeline");
    if (tlHost && !tlHost.childElementCount && history?.cpu?.length > 1) {
        const tl = createTimeline(tlHost);
        tl.setData(history.cpu.map((v, i) => ({
            t: Date.now() - (history.cpu.length - i) * 5000,
            v, label: `CPU ${Math.round(v)}%`
        })));
    }
}

function shortModel(name) {
    if (!name) return "—";
    const s = String(name).split("/").pop();
    return s.length > 14 ? s.slice(0, 13) + "…" : s;
}

function systemStatusSync(o) {
    return statusList(statusRows(o));
}

async function systemStatus(o) {
    return statusList([...statusRows(o), await opencodeRow()]);
}

function statusRows(o) {
    const rows = [
        { name: "Aether Core", on: true },
        { name: "Memory Engine", on: true }
    ];
    for (const it of o.integrations.items) {
        if (it.enabled === false) continue;
        rows.push({ name: it.label ?? it.id, on: it.status?.online === true });
    }
    return rows;
}

function statusList(rows) {
    return `<div class="status-list">
        ${rows.map(r => `<div class="s ${r.on ? "on" : "off"}">
            <span class="d"></span><span>${esc(r.name)}</span>
            <span class="st">${r.on ? "Online" : "Offline"}</span>
        </div>`).join("")}
    </div>`;
}

/** Status OpenCode: cek biner bisa dipanggil (cepat, tanpa spawn). */
async function opencodeRow() {
    try {
        const r = await api.request("/lab/instruments", { timeout: 8000 });
        const oc = (r?.instruments ?? []).find(i => i.id === "opencode");
        if (oc?.online) return { name: "OpenCode (coding agent)", on: true };
        return { name: "OpenCode (coding agent)", on: false };
    }
    catch {
        return { name: "OpenCode (coding agent)", on: false };
    }
}

const FLOW_ICON = { error: "x", warn: "activity", event: "link", info: "check" };
const FLOW_TONE = { error: "warn", warn: "warn", event: "acc", info: "ok" };

function flow(logs) {
    const recent = logs.slice(-8).reverse();
    if (!recent.length) return `<div class="empty">${icon("activity")}<div>Belum ada aktivitas.</div></div>`;
    return `<div class="flow">${recent.map(e => {
        const lvl = e.level ?? "info";
        return `<div class="step" data-tone="${FLOW_TONE[lvl] ?? "ok"}">
            <span class="node">${icon(FLOW_ICON[lvl] ?? "check")}</span>
            <div><div class="lbl">${esc(e.message)}</div></div>
            <span class="tm">${relativeTime(e.time)}</span>
        </div>`;
    }).join("")}</div>`;
}




const AI_STAGES = ["Berpikir", "Menalar", "Merencana", "Memanggil tool", "Menyusun", "Selesai"];


// ---- Memory Graph (entitas nyata) -----------------------------------

const GRAPH_COLORS = ["var(--accent-1)", "var(--accent-2)", "var(--accent-3)", "var(--ok)", "var(--warn)", "#f472b6", "#38bdf8", "#a3e635"];


function shortLabel(s) {
    const t = String(s);
    return t.length > 12 ? t.slice(0, 11) + "…" : t;
}


function disconnected(state) {
    return `
        <div class="panel">
            <div class="empty">
                ${icon("plug")}
                <div style="font-size:14px;color:var(--text)">
                    ${state.connecting ? "Menghubungkan ke daemon…" : "Belum terhubung ke daemon Aether"}
                </div>
                <div>${state.lastError ? esc(state.lastError) : "Jalankan daemon lalu tekan Hubungkan di titlebar."}</div>
            </div>
        </div>`;
}

// ---- Bagian async (diisi saat mount) --------------------------------

async function enrichAgents(root) {
    const host = root.querySelector("#mc-agents");
    try {
        const r = await api.agents();
        const list = r.agents ?? r.items ?? (Array.isArray(r) ? r : []);
        root.querySelector("#mc-agents-count").textContent =
            list.length ? `${list.length} anak buah` : "belum ada";

        // Anak buah Aether: mereka mengorbit entitas. Agent yang belum
        // dikonfigurasi/integrasi jujur ditandai "siaga" — bukan pura-pura
        // online. Status dari data nyata saja.
        host.innerHTML = list.length === 0
            ? `<div class="mc-skeleton">Belum ada agent terdaftar — tambahkan dari Studio.</div>`
            : list.map(a => {
                const name = a.name ?? a.label ?? a.id ?? "Agent";
                const role = a.role ?? a.kind ?? "anak buah";
                const configured = !!(a.model || a.tools?.length || a.capabilities?.length);
                const online = configured && (a.online ?? (a.status && a.status !== "offline"));
                const status = online ? "aktif" : "siaga";
                const note = online
                    ? (a.latency != null ? `${esc(a.latency)} ms` : "terhubung")
                    : "menunggu konfigurasi & integrasi";
                return `<div class="agentrow">
                    <span class="tile">${icon("orb")}</span>
                    <div><div class="nm">${esc(name)}</div><div class="rl">${esc(role)}</div></div>
                    <div class="rt">
                        <span class="pill ${online ? "ok" : "idle"}"><span class="dot"></span>${status}</span>
                        <div class="lat">${note}</div>
                    </div>
                </div>`;
            }).join("");
    }
    catch {
        host.innerHTML = `<div class="mc-skeleton">Daftar anak buah tak tersedia.</div>`;
        root.querySelector("#mc-agents-count").textContent = "—";
    }
}

async function enrichProposals(root) {
    // Kebijakan baru: Aether mengatur memorinya sendiri — tidak ada
    // gerbang persetujuan. Panel ini kini menampilkan aktivitas memori
    // terbaru (APA yang sudah diingat), bukan apa yang menunggu.
    const host = root.querySelector("#mc-proposals");
    try {
        const r = await api.memories({ limit: 12 });
        const items = r.items ?? [];
        root.querySelector("#mc-prop-count").textContent = r.total != null ? `${r.total} ingatan` : "—";
        if (!items.length) {
            host.innerHTML = `<div class="empty">${icon("memory")}<div>Belum ada memori.</div></div>`;
            return;
        }

        // Sebaran per jenis dulu, baru isinya. Daftar potongan teks
        // tanpa ringkasan tidak menjawab pertanyaan yang sebenarnya
        // ditanyakan panel ini: "Aether ini sudah tahu apa saja?"
        const perJenis = {};
        for (const m of items) {
            const jenis = m.metadata?.memoryType ?? m.type ?? "lain";
            perJenis[jenis] = (perJenis[jenis] ?? 0) + 1;
        }

        const LABEL = {
            semantic: "fakta", episodic: "peristiwa",
            preference: "kebiasaan", procedural: "cara", lain: "lain"
        };

        host.innerHTML = `
            <div class="mc-mem-tags">
                ${Object.entries(perJenis)
                    .sort((a, b) => b[1] - a[1])
                    .map(([j, n]) => `<span class="mc-mem-tag" data-j="${esc(j)}">${esc(LABEL[j] ?? j)}<b>${n}</b></span>`)
                    .join("")}
            </div>
            <div class="mc-mem-list">
                ${items.slice(0, 8).map(p => {
                    const jenis = p.metadata?.memoryType ?? p.type ?? "lain";
                    const kapan = p.createdAt ? relativeTime(p.createdAt) : "";
                    return `<div class="mc-mem" title="${esc(p.content ?? "")}">
                        <span class="j" data-j="${esc(jenis)}">${esc(LABEL[jenis] ?? jenis)}</span>
                        <span class="c">${esc(truncateText(p.content ?? "—", 96))}</span>
                        ${kapan ? `<span class="t">${esc(kapan)}</span>` : ""}
                    </div>`;
                }).join("")}
            </div>`;
    }
    catch {
        host.innerHTML = `<div class="empty">${icon("memory")}<div>Memori tak tersedia.</div></div>`;
        root.querySelector("#mc-prop-count").textContent = "—";
    }
}




