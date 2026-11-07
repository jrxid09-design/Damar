import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, duration } from "../lib/ui.js";

/**
 * Kesadaran Ekosistem — bukan sekadar rumah.
 *
 * Seluruh domain yang Damar sadari (sistem, AI, memori, rumah, sensor,
 * kamera, orang, integrasi, agen, kanal, crypto) ditata MELINGKAR di
 * sekeliling reaktor inti Damar — ala kesadaran JARVIS, bukan grid
 * panel admin. Tiap node bercahaya sesuai status; inti berdenyut dan
 * bila diketuk, Damar merangkum keadaan.
 */

export const awareness = {

    id: "awareness",
    label: "Kesadaran",
    icon: "activity",
    title: "Kesadaran Ekosistem",
    subtitle: "Semua domain jadi satu kesadaran — dan Damar memahaminya.",

    render(root) {
        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Kesadaran Ekosistem</h1>
                    <p>Semua domain jadi satu kesadaran — dan Damar memahaminya.</p>
                </div>
                <div class="actions">
                    <button class="btn ghost sm" id="aw-refresh">${icon("refresh")} Segarkan</button>
                </div>
            </div>

            <div class="eco-wrap">
                <div class="eco" id="aw-eco">
                    <div class="eco-rings"><span></span><span></span><span></span></div>
                    <button class="eco-core" id="aw-core">
                        <span class="eco-core-glow"></span>
                        <span class="eco-core-label">DAMAR</span>
                        <span class="eco-core-sub" id="aw-core-sub">ekosistem</span>
                    </button>
                </div>
                <div class="panel eco-brief" id="aw-brief" style="display:none"></div>
            </div>`;
    },

    async mount(root) {
        await draw(root);
        root.querySelector("#aw-refresh").addEventListener("click", () => draw(root));
        root.querySelector("#aw-core").addEventListener("click", () => brief(root));
    }
};

/** Kumpulkan domain dari context (+ crypto best-effort). */
async function collect() {
    const c = await api.context();
    const nodes = [];

    const sys = c.system ?? {};
    nodes.push({ ic: "cpu", lab: "Sistem", val: `${sys.cpu ?? "?"}%`,
        sub: `RAM ${sys.memory ?? "?"}% · ${duration(sys.uptime ?? 0)}`,
        tone: (sys.cpu ?? 0) > 85 ? "warn" : "ok" });

    nodes.push({ ic: "orb", lab: "AI", val: c.ai?.platform ?? "?",
        sub: `model ${(c.ai?.model ?? "default")}`.slice(0, 22),
        tone: (c.ai?.providers ?? []).some(p => p.online) ? "ok" : "idle" });

    nodes.push({ ic: "brain", lab: "Memori", val: `${c.memory?.memories ?? 0}`,
        sub: `${c.memory?.entities ?? 0} entitas · ${c.memory?.documents ?? 0} dok`,
        tone: c.memory?.embeddings ? "ok" : "idle" });

    const home = c.home ?? {};
    nodes.push({ ic: "home", lab: "Rumah", val: home.online ? `${home.on ?? 0}/${home.total ?? 0}` : "—",
        sub: home.online ? "perangkat menyala" : (home.configured ? "HA offline" : "belum diatur"),
        tone: home.online ? "ok" : (home.configured ? "danger" : "idle") });

    const sensors = c.sensors ?? {};
    nodes.push({ ic: "activity", lab: "Sensor", val: `${sensors.total ?? 0}`,
        sub: (sensors.readings ?? []).filter(r => r.ok).slice(0, 1).map(r => `${r.label}: ${r.value}${r.unit ?? ""}`).join("") || "—",
        tone: (sensors.total ?? 0) > 0 ? "ok" : "idle" });

    nodes.push({ ic: "camera", lab: "Kamera", val: `${c.cameras?.total ?? 0}`,
        sub: (c.cameras?.cameras ?? []).map(x => x.label).slice(0, 2).join(", ") || "belum ada",
        tone: (c.cameras?.total ?? 0) > 0 ? "ok" : "idle" });

    const people = c.people ?? {};
    nodes.push({ ic: "search", lab: "Orang", val: people.configured ? `${people.people ?? 0}` : "—",
        sub: people.configured ? "wajah dikenal" : "belum diatur",
        tone: people.configured ? "ok" : "idle" });

    const ig = c.integrations ?? {};
    nodes.push({ ic: "plug", lab: "Integrasi", val: `${ig.online ?? 0}/${ig.enabled ?? 0}`,
        sub: "konektor online", tone: (ig.online ?? 0) > 0 ? "ok" : "idle" });

    const agents = c.agents?.agents ?? [];
    nodes.push({ ic: "grid", lab: "Agen", val: `${agents.filter(a => a.online).length}/${agents.length}`,
        sub: agents.slice(0, 3).map(a => a.id).join(" ") || "—",
        tone: agents.some(a => a.online) ? "ok" : "idle" });

    const wa = c.whatsapp ?? {};
    nodes.push({ ic: "send", lab: "WhatsApp", val: wa.running ? "aktif" : (wa.configured ? "mati" : "—"),
        sub: wa.running ? (wa.number ?? "tersambung") : (wa.configured ? "belum tertaut" : "belum diatur"),
        tone: wa.running ? "ok" : (wa.configured ? "danger" : "idle") });

    // Crypto — best-effort (data publik selalu jalan).
    try {
        const cs = await api.cryptoStatus();
        nodes.push({ ic: "activity", lab: "Crypto", val: cs.public ? `$${Math.round(cs.btcUsdt ?? 0)}` : "—",
            sub: cs.configured ? (cs.account ? "akun aktif" : "harga saja") : "harga (BTC)",
            tone: cs.public ? "ok" : "idle" });
    } catch { /* lewati */ }

    const online = nodes.filter(n => n.tone === "ok").length;
    return { nodes, online, total: nodes.length };
}

async function draw(root) {
    const eco = root.querySelector("#aw-eco");
    const sub = root.querySelector("#aw-core-sub");

    // Bersihkan node lama (sisakan rings + core).
    eco.querySelectorAll(".eco-node").forEach(n => n.remove());
    sub.textContent = "memindai…";

    let data;
    try { data = await collect(); }
    catch { sub.textContent = "gagal memindai"; return; }

    sub.textContent = `${data.online}/${data.total} domain aktif`;

    const N = data.nodes.length;
    const R = 40;   // radius ring dalam persen
    data.nodes.forEach((n, i) => {
        const ang = (-90 + i * (360 / N)) * Math.PI / 180;
        const x = 50 + R * Math.cos(ang);
        const y = 50 + R * Math.sin(ang);
        const el = document.createElement("div");
        el.className = `eco-node tone-${n.tone}`;
        el.style.left = `${x}%`;
        el.style.top = `${y}%`;
        el.innerHTML = `
            <span class="eco-node-ic">${icon(n.ic)}</span>
            <span class="eco-node-val">${esc(String(n.val))}</span>
            <span class="eco-node-lab">${esc(n.lab)}</span>
            <span class="eco-node-sub">${esc(n.sub)}</span>`;
        eco.appendChild(el);
    });
}

async function brief(root) {
    const panel = root.querySelector("#aw-brief");
    panel.style.display = "";
    panel.innerHTML = `<div class="row"><span class="spinner"></span>
        <span class="small muted">Damar merangkum kesadaran ekosistem…</span></div>`;
    try {
        const r = await api.contextBrief();
        panel.innerHTML = `
            <div class="panel-head"><h2>${icon("orb")} Kata Damar</h2></div>
            <div class="bubble" style="max-width:none">${esc(r.brief)}</div>
            ${r.note ? `<div class="small dim" style="margin-top:6px">${esc(r.note)}</div>` : ""}`;
    }
    catch (error) {
        panel.innerHTML = `<div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div>`;
    }
}
