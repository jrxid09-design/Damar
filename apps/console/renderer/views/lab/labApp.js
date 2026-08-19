import { api } from "../../lib/api.js";
import { icon } from "../../lib/icons.js";
import { esc, toast } from "../../lib/ui.js";
import { agentBus } from "../../lib/agentBus.js";

/**
 * AETHER LAB — laboratorium kolaboratif (Mission Control).
 *
 * Layout fullscreen (§27): CONTEXT RAIL kiri + area kerja kanan.
 * Satu-satunya sumber kebenaran = BACKEND (lab_events / lab_* via
 * API + SSE `lab:*`); UI hanya menyajikan (§34/§42).
 *
 * Panel: Projects · Mission Control · Agents · Instruments ·
 * Memory/Knowledge · Experiments · Artifacts · Decisions · Timeline.
 */

const PHASES = ["IDEA", "RESEARCH", "DESIGN", "PROTOTYPE", "IMPLEMENTATION", "TESTING", "VALIDATION", "RELEASE", "MAINTENANCE"];

const SECTIONS = [
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "missions", label: "Missions", icon: "orb" },
    { id: "agents", label: "Agents", icon: "cpu" },
    { id: "instruments", label: "Instruments", icon: "tool" },
    { id: "memory", label: "Memory", icon: "memory" },
    { id: "knowledge", label: "Knowledge", icon: "brain" },
    { id: "experiments", label: "Experiments", icon: "flask" },
    { id: "artifacts", label: "Artifacts", icon: "box" },
    { id: "decisions", label: "Decisions", icon: "shield" }
];

const MISSION_TONE = {
    PLANNING: "idle", QUEUED: "idle", RUNNING: "acc", BLOCKED: "warn",
    WAITING_USER: "warn", VERIFYING: "acc", COMPLETED: "ok",
    FAILED: "danger", CANCELLED: "idle"
};

const AGENT_DOT = {
    IDLE: "idle", THINKING: "acc", PLANNING: "acc", WORKING: "acc",
    WAITING_TOOL: "warn", WAITING_AGENT: "warn", WAITING_USER: "warn",
    VERIFYING: "acc", BLOCKED: "warn", COMPLETED: "ok", ERROR: "danger"
};

/** Event yang mengubah isi panel misi — pemicu gambar ulang. */
const SEGARKAN = new Set([
    "mission.progress", "mission.started", "mission.completed",
    "mission.failed", "mission.verifying", "agent.started",
    "agent.completed", "agent.failed", "artifact.created"
]);

let state = {
    project: null,
    projects: [],
    missions: [],
    /** Misi yang sedang dibuka — versi DETAIL (punya tasks + hasil). */
    mission: null,
    missionId: null,
    agents: [],
    activity: [],
    section: "missions",
    unsub: null,
    esHooked: false,
    refreshTimer: null
};

export const labApp = {

    render(root) {
        root.innerHTML = `
            <div class="lab-shell">
                <aside class="lab-rail">
                    <div class="lab-brand">${icon("flask")} <span>AETHER LAB</span></div>
                    <nav class="lab-nav" id="lab-nav">
                        ${SECTIONS.map(s => `
                            <button data-sec="${s.id}" class="${s.id === state.section ? "on" : ""}" title="${s.label}">
                                ${icon(s.icon)}<span>${s.label}</span>
                            </button>`).join("")}
                    </nav>
                    <div class="lab-rail-foot" id="lab-project-chip"></div>
                </aside>
                <main class="lab-main">
                    <header class="lab-top">
                        <div class="lab-proj" id="lab-proj">—</div>
                        <div class="lab-phase" id="lab-phase"></div>
                        <div class="lab-live" id="lab-live">
                            <span class="lab-live-dot"></span> LIVE
                        </div>
                    </header>
                    <section class="lab-body" id="lab-body"></section>
                    <footer class="lab-cmd">
                        <input type="text" id="lab-goal" placeholder="Nyatakan tujuan — Aether menyusun misinya…"
                            autocomplete="off">
                        <button class="btn primary" id="lab-goal-go">${icon("play")} Jalankan</button>
                    </footer>
                </main>
            </div>`;
    },

    mount(root) {

        // Navigasi seksi.
        root.querySelector("#lab-nav").addEventListener("click", e => {
            const btn = e.target.closest("[data-sec]");
            if (!btn) return;
            state.section = btn.dataset.sec;
            root.querySelectorAll("[data-sec]").forEach(b => b.classList.toggle("on", b === btn));
            drawBody();
        });

        // Command bar: tujuan bebas → misi baru + jalankan.
        root.querySelector("#lab-goal-go").addEventListener("click", () => goalToMission(root));
        root.querySelector("#lab-goal").addEventListener("keydown", e => {
            if (e.key === "Enter") goalToMission(root);
        });

        // Hook SSE lab:* → live activity + agent bus (orb).
        if (!state.esHooked) {
            state.esHooked = true;
            document.addEventListener("aether:lab-event", e => {
                const evt = e.detail;
                if (!evt) return;
                state.activity = [evt, ...state.activity].slice(0, 120);
                renderActivity();
                // sinkron orb agent di Beranda
                if (evt.type === "agent.started") agentBus.ingest("orchestrator:step:start", { step: { agent: evt.agentId } });
                if (evt.type === "agent.completed" || evt.type === "agent.failed")
                    agentBus.ingest("orchestrator:step:done", { step: { agent: evt.agentId }, ok: evt.type === "agent.completed" });

                // Panel misi ikut hidup selama misi berjalan.
                //
                // Satu misi bisa memakan menit-menit; dulu panelnya
                // membeku sampai permintaan run() kembali, jadi satu-
                // satunya tanda kehidupan cuma feed aktivitas. Task yang
                // berubah status di basis data tidak terlihat sama sekali.
                if (SEGARKAN.has(evt.type) && state.section === "missions") {
                    clearTimeout(state.refreshTimer);
                    state.refreshTimer = setTimeout(() => {
                        refreshMissions().then(drawBody).catch(() => { /* biarkan */ });
                    }, 400);
                }
            });
        }

        refreshAll().catch(e => toast(`Lab: ${e.message}`, "danger"));
    },

    unmount() { /* state dipertahankan; SSE window-level tetap */ }

};

// ---------------------------------------------------------------- data

async function refreshAll() {
    const [{ projects }] = await Promise.all([api.labProjectsV2().catch(() => ({ projects: [] }))]);
    state.projects = projects ?? [];
    state.project = state.projects.find(p => p.id === state.project?.id)
        ?? state.projects.find(p => p.status === "active")
        ?? state.projects[0]
        ?? null;

    await Promise.all([refreshMissions(), refreshAgents(), refreshActivity()]);
    drawTop();
    drawBody();
}

async function refreshMissions() {

    if (!state.project) { state.missions = []; state.mission = null; return; }

    const { missions } = await api.labMissions({ project: state.project.id }).catch(() => ({ missions: [] }));
    state.missions = missions ?? [];

    // Daftar misi tidak memuat tasks maupun hasil — hanya endpoint
    // detail yang memuatnya. Tanpa panggilan kedua ini panel selalu
    // menulis "belum ada task" walau misinya sudah tuntas, dan hasil
    // akhirnya tidak pernah muncul di mana pun.
    const pilih = state.missions.find(m => m.id === state.missionId)
        ?? state.missions.find(m => !["COMPLETED", "CANCELLED"].includes(m.status))
        ?? state.missions[0]
        ?? null;

    state.missionId = pilih?.id ?? null;

    state.mission = pilih
        ? await api.labMissionDetail(pilih.id).then(r => r.mission ?? r).catch(() => pilih)
        : null;

}

async function refreshAgents() {
    const { agents } = await api.labAgentsBoard().catch(() => ({ agents: [] }));
    state.agents = agents ?? [];
}

async function refreshActivity() {
    const { events } = await api.labActivity({ project: state.project?.id, limit: 60 }).catch(() => ({ events: [] }));
    state.activity = events ?? [];
    renderActivity();
}

// ---------------------------------------------------------------- draw

function drawTop() {
    const el = document.getElementById("lab-proj");
    const chip = document.getElementById("lab-project-chip");
    const phase = document.getElementById("lab-phase");
    if (!el) return;
    if (state.project) {
        el.innerHTML = `<b>${esc(state.project.title)}</b> <span class="mono dim">${esc(state.project.dir)}</span>`;
        phase.innerHTML = phasePicker();
        chip.innerHTML = `${icon("folder")} ${esc(state.project.title)}`;
    } else {
        el.textContent = "belum ada project — buat di seksi Projects";
        phase.innerHTML = "";
        chip.innerHTML = "";
    }
    phase.querySelectorAll("[data-phase]").forEach(b =>
        b.addEventListener("click", async () => {
            try {
                await api.labSetPhase(state.project.id, b.dataset.phase);
                await refreshAll();
            }
            catch (e) { toast(e.message, "warn"); }
        })
    );
}

function phasePicker() {
    return `<div class="lab-phase-track">${PHASES.map(p => `
        <button data-phase="${p}" class="${p === state.project.phase ? "on" : ""}">${p.slice(0, 4)}</button>
    `).join("")}</div>`;
}

function drawBody() {
    const body = document.getElementById("lab-body");
    if (!body) return;
    switch (state.section) {
        case "projects": return drawProjects(body);
        case "missions": return drawMissionControl(body);
        case "agents": return drawAgents(body);
        case "instruments": return drawInstruments(body);
        case "memory": return drawMemory(body);
        case "knowledge": return drawKnowledge(body);
        case "experiments": return drawExperiments(body);
        case "artifacts": return drawArtifacts(body);
        case "decisions": return drawDecisions(body);
    }
}

// ---------------------------------------------------------------- seksi

function drawProjects(host) {
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head">
                <h2>Projects</h2>
                <div class="row">
                    <input id="lab-new-dir" placeholder="path folder project…" style="width:260px">
                    <input id="lab-new-title" placeholder="judul (opsional)" style="width:180px">
                    <button class="btn primary sm" id="lab-new-go">${icon("plus")} Daftarkan</button>
                </div>
            </div>
            <div class="lab-project-list">
                ${state.projects.map(p => `
                    <button class="lab-project ${p.id === state.project?.id ? "on" : ""}" data-prj="${esc(p.id)}">
                        <span class="tile lab-open-dir" data-dir="${esc(p.dir)}"
                              title="Buka folder project">${icon("folder")}</span>
                        <span class="tile lab-vscode" data-prj="${esc(p.id)}"
                              title="Buka di VS Code">${icon("terminal")}</span>
                        <div>
                            <b>${esc(p.title)}</b>
                            <div class="mono dim small lab-open-dir" data-dir="${esc(p.dir)}"
                                 title="Buka folder project">${esc(p.dir)}</div>
                        </div>
                        <span class="lab-phase-chip ${p.phase.toLowerCase()}">${p.phase}</span>
                        <span class="dim small">${p.stats?.missions ?? 0} misi · ${p.stats?.artifacts ?? 0} artefak</span>
                    </button>`).join("") || '<div class="lab-empty">Belum ada project.</div>'}
            </div>
        </div>`;

    host.querySelector("#lab-new-go").addEventListener("click", async () => {
        const dir = host.querySelector("#lab-new-dir").value.trim();
        if (!dir) return;
        try {
            await api.labCreateProject(dir, host.querySelector("#lab-new-title").value.trim() || undefined);
            await refreshAll();
        }
        catch (e) { toast(e.message, "danger"); }
    });

    // Ikon folder & baris path membuka repositori di pengelola berkas.
    // Sisa baris tetap memilih project — dua maksud yang berbeda pada
    // satu baris, jadi masing-masing perlu sasaran kliknya sendiri.
    host.querySelectorAll(".lab-open-dir").forEach(el => el.addEventListener("click", async e => {
        e.stopPropagation();
        const dir = el.dataset.dir;
        if (!dir) return;
        try {
            const r = await window.aether?.shell?.reveal?.(dir);
            if (r && r.ok === false) toast(`Tidak bisa membuka: ${r.error}`, "warn");
        }
        catch (error) { toast(error.message, "danger"); }
    }));

    // Buka project di VS Code — mempermudah pengerjaan manual.
    host.querySelectorAll(".lab-vscode").forEach(el => el.addEventListener("click", async e => {
        e.stopPropagation();
        try {
            await api.labOpenVSCode(el.dataset.prj);
            toast("Membuka VS Code…", "ok");
        }
        catch (error) { toast(`VS Code: ${error.message}`, "danger"); }
    }));

    host.querySelectorAll("[data-prj]").forEach(b => b.addEventListener("click", async () => {
        state.project = state.projects.find(p => p.id === b.dataset.prj);
        await refreshMissions();
        await refreshActivity();
        drawTop();
        drawBody();
    }));
}

function drawMissionControl(host) {

    // Yang dipakai adalah misi DETAIL (punya tasks + hasil), bukan
    // baris ringkas dari daftar.
    const current = state.mission
        ?? state.missions.find(m => !["COMPLETED", "CANCELLED"].includes(m.status))
        ?? state.missions[0]
        ?? null;

    host.innerHTML = `
        <div class="lab-mc-grid">
            <div class="lab-panel lab-mc-mission">
                <div class="lab-panel-head">
                    <h2>Mission Control</h2>
                    <button class="btn ghost sm" id="lab-mission-new">${icon("plus")} Misi baru</button>
                </div>
                ${current ? `
                    <div class="lab-mission-current">
                        <div class="lab-mission-title">
                            <b>${esc(current.title)}</b>
                            <span class="pill ${MISSION_TONE[current.status] ?? "idle"}">${current.status}</span>
                        </div>
                        <div class="dim small">${esc(current.objective ?? "")}</div>
                        <div class="lab-progress"><i style="width:${Math.round((current.progress ?? 0) * 100)}%"></i></div>
                        <div class="lab-mission-tasks">
                            ${(current.tasks ?? []).map(t => `
                                <div class="lab-task ${t.status}">
                                    <div class="lab-task-head" ${t.output ? `data-task-toggle="${esc(t.id)}"` : ""}>
                                        <span class="lab-task-dot"></span>
                                        <span class="mono dim small">${esc(t.agent ?? "?")}</span>
                                        <span class="small">${esc(String(t.title).slice(0, 90))}</span>
                                        ${t.output ? `<span class="lab-task-more">lihat hasil</span>` : ""}
                                    </div>
                                    ${t.output ? `<pre class="lab-task-out" id="out-${esc(t.id)}" hidden>${esc(t.output)}</pre>` : ""}
                                </div>`).join("") || '<div class="dim small">belum ada task — jalankan misi.</div>'}
                        </div>

                        <!-- HASIL akhir misi. Inilah yang dicari pemilik
                             setelah menekan Jalankan; sebelumnya tidak
                             ditampilkan di mana pun. -->
                        ${current.result ? `
                            <div class="lab-result">
                                <div class="lab-result-head">
                                    ${icon("check")} Hasil misi
                                    <span class="dim">${esc(String(current.resultAt ?? "").slice(0, 16).replace("T", " "))}</span>
                                </div>
                                <div class="lab-result-body">${esc(current.result)}</div>
                                <!-- Tanpa baris ini Lab jadi ruangan tertutup:
                                     laporannya bagus lalu berhenti di sana. -->
                                <div class="lab-apply">
                                    <span class="lab-apply-label">Terapkan ke Aether:</span>
                                    <button class="btn ghost sm" data-apply="memory" data-mid="${esc(current.id)}"
                                        title="Aether di semua kanal jadi tahu isinya">${icon("memory")} Ingat ini</button>
                                    <button class="btn ghost sm" data-apply="beranda" data-mid="${esc(current.id)}"
                                        title="Munculkan sebagai popup di dashboard">${icon("orb")} Tampilkan di Beranda</button>
                                    <button class="btn ghost sm" data-apply="followup" data-mid="${esc(current.id)}"
                                        title="Buat misi berikutnya dari temuan ini">${icon("plus")} Tindak lanjuti</button>
                                    <button class="btn ghost sm" data-apply="code" data-mid="${esc(current.id)}"
                                        title="Teruskan ke opencode agar patch-nya ditulis">${icon("terminal")} Terapkan ke kode</button>
                                </div>
                            </div>`
                        : current.status === "COMPLETED"
                            ? `<div class="lab-result kosong">Misi selesai, tetapi tidak ada ringkasan hasil yang tersimpan.</div>`
                            : ""}

                        <div class="row" style="gap:6px;margin-top:10px">
                            <button class="btn primary sm" data-run="${esc(current.id)}">${icon("play")} Jalankan</button>
                            ${current.opencodeSession ? `<button class="btn ghost sm" data-resume="${esc(current.id)}">Lanjut sesi OpenCode</button>` : ""}
                        </div>
                    </div>` : '<div class="lab-empty">Belum ada misi — nyatakan tujuan di command bar bawah.</div>'}
                <div class="lab-mission-history">
                    ${state.missions.slice(0, 12).map(m => `
                        <button class="lab-mission-row${m.id === current?.id ? " on" : ""}" data-mission="${esc(m.id)}">
                            <span class="pill ${MISSION_TONE[m.status] ?? "idle"}">${m.status}</span>
                            <span class="small">${esc(m.title.slice(0, 60))}</span>
                            <span class="dim small">${Math.round((m.progress ?? 0) * 100)}%</span>
                        </button>`).join("")}
                </div>
            </div>

            <div class="lab-panel lab-mc-agents">
                <div class="lab-panel-head"><h2>Agents</h2></div>
                ${state.agents.map(a => `
                    <div class="lab-agent-row">
                        <span class="lab-agent-dot ${AGENT_DOT[a.status?.status] ?? "idle"}"></span>
                        <b>${esc(a.id)}</b>
                        <span class="dim small">${esc(a.status?.status ?? "IDLE")}${a.status?.task ? " · " + esc(String(a.status.task).slice(0, 40)) : ""}</span>
                    </div>`).join("")}
            </div>

            <div class="lab-panel lab-mc-activity">
                <div class="lab-panel-head"><h2>Live Activity</h2></div>
                <div class="lab-activity" id="lab-activity"></div>
            </div>

            <div class="lab-panel lab-mc-timeline">
                <div class="lab-panel-head"><h2>Timeline</h2></div>
                <div id="lab-timeline">memuat…</div>
            </div>
        </div>`;

    renderActivity();

    host.querySelector("#lab-mission-new")?.addEventListener("click", () => {
        const input = document.getElementById("lab-goal");
        input.focus();
    });

    // Riwayat misi bisa dipilih — tanpa ini hasil misi lama tak
    // terjangkau sama sekali; hanya yang teratas yang pernah terlihat.
    host.querySelectorAll("[data-mission]").forEach(b => b.addEventListener("click", async () => {
        state.missionId = b.dataset.mission;
        await refreshMissions();
        drawBody();
    }));

    // Terapkan hasil misi ke Aether utama.
    const PESAN = {
        memory: "Aether mengingat hasil ini — berlaku di Console, WhatsApp, Telegram, dan CLI.",
        beranda: "Hasil dikirim ke Beranda.",
        followup: "Misi lanjutan dibuat — ada di riwayat, tinggal dijalankan.",
        code: "Diteruskan ke opencode."
    };

    host.querySelectorAll("[data-apply]").forEach(b => b.addEventListener("click", async () => {

        const target = b.dataset.apply;
        const label = b.innerHTML;

        b.disabled = true;
        b.innerHTML = `<span class="spinner"></span> memproses…`;

        try {
            await api.labMissionApply(b.dataset.mid, target);
            toast(PESAN[target] ?? "Diterapkan.", "ok", 6000);
            // Misi lanjutan menambah baris riwayat; sisanya tidak
            // mengubah panel, jadi hanya itu yang perlu digambar ulang.
            if (target === "followup") { await refreshMissions(); drawBody(); return; }
        }
        catch (e) { toast(e.message, "danger", 7000); }

        b.disabled = false;
        b.innerHTML = label;

    }));

    // Output tiap task dilipat: penting saat menelusuri, mengganggu
    // bila selalu terbuka.
    host.querySelectorAll("[data-task-toggle]").forEach(h => h.addEventListener("click", () => {
        const pre = host.querySelector(`#out-${CSS.escape(h.dataset.taskToggle)}`);
        if (pre) pre.hidden = !pre.hidden;
    }));

    host.querySelectorAll("[data-run]").forEach(b => b.addEventListener("click", async () => {
        b.disabled = true;
        b.innerHTML = `<span class="spinner"></span> berjalan…`;
        try {
            // Fokuskan ke misi yang baru dijalankan supaya hasilnya
            // yang tampil, bukan misi lain yang kebetulan teratas.
            state.missionId = b.dataset.run;
            const hasil = await api.labMissionRun(b.dataset.run);
            await refreshMissions();
            await refreshAgents();
            drawBody();
            toast(hasil?.final
                ? "Misi selesai — hasilnya ada di Mission Control."
                : "Misi selesai.", "ok", 5000);
        }
        catch (e) { toast(e.message, "danger"); b.disabled = false; }
    }));

    loadTimeline();
}

async function loadTimeline() {
    const el = document.getElementById("lab-timeline");
    if (!el || !state.project) return;
    try {
        const { timeline } = await api.labTimeline(state.project.id);
        el.innerHTML = timeline.slice(0, 20).map(t => `
            <div class="lab-tl-row">
                <span class="mono dim small">${String(t.ts ?? "").slice(11, 19)}</span>
                <span class="small">${esc(labelEvent(t))}</span>
            </div>`).join("") || '<div class="dim small">kosong</div>';
    }
    catch { el.innerHTML = '<div class="dim small">tidak tersedia</div>'; }
}

function labelEvent(t) {
    const p = t.payload ?? {};
    switch (t.type) {
        case "mission.created": return `misi dibuat: ${p.title ?? ""}`;
        case "mission.started": return `misi berjalan`;
        case "mission.completed": return `misi selesai (${Math.round((p.progress ?? 1) * 100)}%)`;
        case "mission.failed": return `misi gagal${p.reason ? ": " + String(p.reason).slice(0, 60) : ""}`;
        case "project.phase_changed": return `fase ${p.from} → ${p.to}${p.rejected ? " (ditolak)" : ""}`;
        case "decision.created": return `keputusan: ${String(p.question ?? "").slice(0, 60)}`;
        case "artifact.created": return `artefak: ${p.name ?? ""}`;
        default: return t.type;
    }
}

function renderActivity() {
    const el = document.getElementById("lab-activity");
    if (!el) return;
    el.innerHTML = state.activity.slice(0, 40).map(e => `
        <div class="lab-ev">
            <span class="mono dim">${String(e.ts ?? "").slice(11, 19)}</span>
            <span class="lab-ev-type" data-k="${e.type.split(".")[0]}">${e.type}</span>
            <span class="dim small">${esc(evDetail(e))}</span>
        </div>`).join("") || '<div class="dim small">menunggu kejadian…</div>';
}

function evDetail(e) {
    const p = e.payload ?? {};
    return p.title ?? p.name ?? p.task ?? p.reason ?? p.question ?? (p.agentId ? `agent ${p.agentId}` : "");
}

function drawAgents(host) {
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head"><h2>Agent Workspace</h2></div>
            <div class="lab-agents-grid">
                ${state.agents.map(a => `
                    <div class="lab-agent-card" data-agent="${esc(a.id)}">
                        <div class="lab-agent-head">
                            <span class="lab-agent-dot ${AGENT_DOT[a.status?.status] ?? "idle"}"></span>
                            <b>${esc(a.label ?? a.id)}</b>
                            <span class="dim small">${esc(a.status?.status ?? "IDLE")}</span>
                        </div>
                        <div class="dim small">${esc(a.description ?? "")}</div>
                        <div class="lab-agent-skills">
                            ${(a.skills ?? []).slice(0, 6).map(s => `<span class="tag">${esc(s)}</span>`).join("")}
                        </div>
                    </div>`).join("")}
            </div>
        </div>`;
}

async function drawInstruments(host) {
    host.innerHTML = '<div class="lab-panel"><div class="lab-empty">memuat instrumen…</div></div>';
    const { instruments } = await api.labInstruments().catch(() => ({ instruments: [] }));
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head"><h2>Instruments</h2>
                <span class="dim small">konsep untuk manusia — agent menerima tool konkret</span></div>
            <div class="lab-instruments">
                ${instruments.map(i => `
                    <div class="lab-instrument ${i.online ? "" : "off"}">
                        <div class="lab-inst-head">${icon(i.icon)} <b>${esc(i.label)}</b>
                            <span class="dim small">${i.availableCount}/${i.tools.length}</span></div>
                        <div class="dim small">${esc(i.description)}</div>
                        <div class="lab-inst-tools">
                            ${i.tools.map(t => `<span class="tag ${t.available ? "" : "off"}">${esc(t.name)}</span>`).join("")}
                        </div>
                    </div>`).join("")}
            </div>
        </div>`;
}

async function drawMemory(host) {
    if (!state.project) return host.innerHTML = emptyProject();
    host.innerHTML = '<div class="lab-panel"><div class="lab-empty">memuat memori…</div></div>';
    const s = await api.labMemorySummary(state.project.id).catch(() => null);
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head"><h2>Memory Lab</h2></div>
            <p class="dim small">Apa yang Aether INGAT tentang project ini.</p>
            <div class="lab-mem-list">
                ${(s?.memories ?? []).map(m => `
                    <div class="lab-mem ${m.inProject ? "in" : ""}">
                        <span class="lab-mem-w">${esc(m.metadata?.labType ?? "fact")}</span>
                        <span class="small">${esc(String(m.content).slice(0, 120))}</span>
                    </div>`).join("") || '<div class="dim small">belum ada memori project.</div>'}
            </div>
        </div>`;
}

async function drawKnowledge(host) {
    if (!state.project) return host.innerHTML = emptyProject();
    host.innerHTML = '<div class="lab-panel"><div class="lab-empty">memuat knowledge…</div></div>';
    const s = await api.labMemorySummary(state.project.id).catch(() => null);
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head"><h2>Knowledge Lab</h2></div>
            <p class="dim small">Apa yang Aether KETAHUI untuk project ini (dokumen terindeks).</p>
            <div class="lab-mem-list">
                ${(s?.knowledge ?? []).map(k => `
                    <div class="lab-mem in">
                        <span class="lab-mem-w">doc</span>
                        <span class="small">${esc(k.title ?? k.id)}</span>
                    </div>`).join("") || '<div class="dim small">belum ada knowledge project.</div>'}
            </div>
        </div>`;
}

async function drawExperiments(host) {
    if (!state.project) return host.innerHTML = emptyProject();
    host.innerHTML = '<div class="lab-panel"><div class="lab-empty">memuat…</div></div>';
    const { experiments } = await api.labExperiments({ project: state.project.id }).catch(() => ({ experiments: [] }));
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head"><h2>Experiments</h2></div>
            ${(experiments ?? []).map(e => `
                <div class="lab-exp">
                    <div class="row" style="gap:8px">
                        <span class="pill ${e.status === "completed" ? "ok" : e.status === "running" ? "acc" : "idle"}">${e.status}</span>
                        <b class="small">${esc(String(e.hypothesis ?? "(tanpa hipotesis)").slice(0, 80))}</b>
                    </div>
                    ${e.conclusion ? `<div class="dim small">${esc(e.conclusion.slice(0, 140))}</div>` : ""}
                    <div class="dim small">${(e.runs ?? []).length} run</div>
                </div>`).join("") || '<div class="dim small">belum ada eksperimen.</div>'}
        </div>`;
}

async function drawArtifacts(host) {
    if (!state.project) return host.innerHTML = emptyProject();
    host.innerHTML = '<div class="lab-panel"><div class="lab-empty">memuat…</div></div>';
    const { artifacts } = await api.labArtifacts({ project: state.project.id }).catch(() => ({ artifacts: [] }));
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head"><h2>Artifact Registry</h2></div>
            ${(artifacts ?? []).map(a => `
                <div class="lab-art">
                    <div class="row" style="gap:8px">
                        <span class="tag">${esc(a.kind)}</span>
                        <b class="small">${esc(a.name)}</b>
                        <span class="dim small push">${esc(a.agentId ?? "")}${a.missionId ? " · " + esc(a.missionId) : ""}</span>
                    </div>
                    <!-- Ringkasan adalah isi artefaknya; untuk laporan misi
                         di sinilah hasil kerjanya berada. Tanpa baris ini
                         panel cuma daftar judul tanpa guna. -->
                    ${a.summary ? `<div class="lab-art-sum">${esc(a.summary)}</div>` : ""}
                    ${a.path ? `<button class="lab-art-path lab-open-dir" data-dir="${esc(a.path)}"
                        title="Buka di pengelola berkas">${esc(a.path)}</button>` : ""}
                </div>`).join("") || '<div class="dim small">belum ada artefak.</div>'}
        </div>`;

    host.querySelectorAll(".lab-open-dir").forEach(el => el.addEventListener("click", async () => {
        try { await window.aether?.shell?.reveal?.(el.dataset.dir); }
        catch (e) { toast(e.message, "danger"); }
    }));
}

async function drawDecisions(host) {
    if (!state.project) return host.innerHTML = emptyProject();
    host.innerHTML = '<div class="lab-panel"><div class="lab-empty">memuat…</div></div>';
    const { decisions } = await api.labDecisions({ project: state.project.id }).catch(() => ({ decisions: [] }));
    host.innerHTML = `
        <div class="lab-panel">
            <div class="lab-panel-head"><h2>Decision Records</h2></div>
            ${(decisions ?? []).map(d => `
                <div class="lab-dec">
                    <b class="small">${esc(d.question)}</b>
                    <div class="small">→ <span class="ok-text">${esc(d.chosen ?? "?")}</span>
                        <span class="dim">(${esc(d.decisionMaker ?? "aether")})</span></div>
                    ${d.reason ? `<div class="dim small">${esc(String(d.reason).slice(0, 120))}</div>` : ""}
                </div>`).join("") || '<div class="dim small">belum ada keputusan.</div>'}
        </div>`;
}

function emptyProject() {
    return `<div class="lab-panel"><div class="lab-empty">Pilih project dulu di seksi Projects.</div></div>`;
}

// ---------------------------------------------------------------- aksi

async function goalToMission(root) {

    const input = root.querySelector("#lab-goal");
    const goal = input.value.trim();

    if (!goal) return;

    if (!state.project) {
        toast("Buka project dulu (seksi Projects).", "warn");
        return;
    }

    input.value = "";

    try {

        const { mission } = await api.labMissionCreate({
            projectId: state.project.id,
            title: goal.slice(0, 80),
            objective: goal
        });

        toast(`Misi ${mission.id} dibuat — berjalan…`, "ok");

        // Jalankan di belakang; event SSE mengisi activity secara live.
        api.labMissionRun(mission.id)
            .then(async () => {
                await refreshMissions();
                await refreshAgents();
                if (state.section === "missions") drawBody();
            })
            .catch(e => toast(`Misi: ${e.message}`, "danger"));

        await refreshMissions();
        if (state.section === "missions") drawBody();

    }
    catch (e) {
        toast(e.message, "danger");
    }
}
