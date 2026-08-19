import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, markdown, toast } from "../lib/ui.js";

/**
 * Agents — orkestrasi multi-agent.
 *
 * Menampilkan kesiapan tiap agent (Aether/OpenClaw/Hermes) dan
 * sebuah konsol untuk memberi tugas kompleks yang dipecah lalu
 * dieksekusi lintas agent, dengan prosesnya terlihat langsung.
 */

export const agents = {

    id: "agents",
    label: "Agents",
    icon: "activity",
    title: "Agents",
    subtitle: "Beri tugas kompleks — Aether memecah & mengoordinasikan agent.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Agents</h1>
                    <p>Beri tugas kompleks — Aether memecah &amp; mengoordinasikan agent.</p>
                </div>
                <div class="actions">
                    <button class="btn ghost sm" id="ag-refresh">${icon("refresh")} Cek agent</button>
                </div>
            </div>

            <div class="stack">
                <div id="ag-health" class="grid cols-3"></div>

                <div class="panel">
                    <div class="panel-head"><h2>${icon("activity")} Orkestrasi</h2></div>
                    <div class="row">
                        <input type="text" id="ag-input" style="flex:1"
                            placeholder="mis. cek suhu server lalu ringkas dan kirim ke WhatsApp">
                        <button class="btn primary" id="ag-run">${icon("play")} Jalankan</button>
                    </div>
                    <div id="ag-run-out" class="stack" style="margin-top:14px"></div>
                </div>
            </div>`;

    },

    async mount(root) {

        await drawHealth(root);

        root.querySelector("#ag-refresh").addEventListener("click", () => drawHealth(root));

        const input = root.querySelector("#ag-input");
        const runBtn = root.querySelector("#ag-run");

        const run = async () => {

            const request = input.value.trim();
            if (!request) return;

            const out = root.querySelector("#ag-run-out");
            out.innerHTML = "";
            runBtn.disabled = true;

            const stepEls = {};

            const line = (html, cls = "") => {
                const el = document.createElement("div");
                el.className = `orch-line ${cls}`;
                el.innerHTML = html;
                out.appendChild(el);
                out.scrollTop = out.scrollHeight;
                return el;
            };

            try {

                await api.orchestrate(request, ({ event, data }) => {

                    if (event === "planning") {
                        line(`<span class="spinner"></span> <span class="muted">Menyusun rencana…</span>`);
                    }

                    else if (event === "plan") {
                        out.innerHTML = "";
                        line(`<div class="small dim">Rencana${data.plan.fallback ? " (sederhana)" : ""}: ${data.plan.steps.length} langkah</div>`);
                        for (const s of data.plan.steps) {
                            stepEls[s.id] = line(
                                `<span class="dim">•</span> <span class="mono">${esc(s.id)}</span> ` +
                                `${pill(s.agent, "idle")} <span class="muted">${esc(s.task)}</span> ` +
                                `<span class="st" data-st>…</span>`
                            );
                        }
                    }

                    else if (event === "step:start") {
                        const el = stepEls[data.step.id];
                        if (el) el.querySelector("[data-st]").innerHTML = `<span class="spinner"></span>`;
                    }

                    else if (event === "step:done") {
                        const el = stepEls[data.step.id];
                        if (el) {
                            el.querySelector("[data-st]").innerHTML = data.ok
                                ? pill("selesai", "ok")
                                : pill("gagal", "danger");
                            if (!data.ok) {
                                el.insertAdjacentHTML("beforeend",
                                    `<div class="small danger-text" style="margin-left:20px">${esc(data.error ?? "")}</div>`);
                            }
                        }
                    }

                    else if (event === "final") {
                        line(`<div class="divider"></div>
                            <div class="small dim" style="margin-bottom:4px">Hasil akhir</div>
                            <div class="bubble" style="max-width:none">${markdown(data.final ?? "")}</div>`);
                    }

                    else if (event === "error") {
                        line(`${icon("alert")} <span class="danger-text">${esc(data.message)}</span>`);
                    }

                });

            }

            catch (error) {
                line(`${icon("alert")} <span class="danger-text">${esc(error.message)}</span>`);
            }

            finally {
                runBtn.disabled = false;
            }

        };

        runBtn.addEventListener("click", run);
        input.addEventListener("keydown", e => { if (e.key === "Enter") run(); });

    }

};

async function drawHealth(root) {

    const host = root.querySelector("#ag-health");

    try {

        const { agents: list } = await api.agents();

        const kindIcon = k => k === "reasoner" ? "orb" : k === "actuator" ? "tool" : "activity";

        host.innerHTML = list.map(a => `
            <div class="panel agent-card">
                <div class="top">
                    <span class="tile">${icon(kindIcon(a.kind))}</span>
                    <div style="flex:1;min-width:0">
                        <div class="row" style="gap:8px">
                            <span class="nm">${esc(a.label)}</span>
                            ${pill(a.online ? "online" : "offline", a.online ? "ok" : "idle")}
                        </div>
                        <div class="rl">${esc(a.kind ?? "agent")}</div>
                    </div>
                </div>
                ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ""}
                ${(a.skills ?? []).length ? `
                    <div class="skills">${a.skills.map(s => `<span class="tag">${esc(s)}</span>`).join("")}</div>` : ""}
                ${a.detail ? `<div class="small dim">${esc(a.detail)}</div>` : ""}
            </div>`).join("")
            + `<div class="panel" style="grid-column:1/-1">
                <div class="small muted">${icon("activity")}
                    Aether mengoordinasikan <strong>ketiga agent</strong>: ia menyusun rencana,
                    lalu memberi tiap langkah ke agent yang paling cocok (menalar ke Aether,
                    aksi antarmuka ke OpenClaw, tugas berlapis ke Hermes) dan menyatukan hasilnya.
                </div>
            </div>`;

    }

    catch (error) {
        host.innerHTML = `<div class="panel" style="grid-column:1/-1"><div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div></div>`;
    }

}
