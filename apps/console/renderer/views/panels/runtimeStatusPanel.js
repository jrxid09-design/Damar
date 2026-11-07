import { api } from "../../lib/api.js";
import { icon } from "../../lib/icons.js";
import { esc, pill, toast, duration } from "../../lib/ui.js";

/**
 * Panel Runtime Status — kartu tiap runtime inti (Hermes/OpenClaw/Docker/
 * Ollama/Damar) dari Runtime API (REST, poll). Terasa seperti service
 * manager. Tanpa detail implementasi ke pengguna (label ramah + metrik).
 *
 * onOpenTerminal(purpose): dipanggil saat pengguna klik "Terminal" pada
 * kartu → Runtime Console pindah ke panel Terminal & ikat by purpose.
 */
export function runtimeStatusPanel({ onOpenTerminal } = {}) {

    let rootEl = null;
    let timer = null;

    const fmtUptime = s => (s == null ? "—" : duration(s));
    const healthTone = h => (h === "online" ? "ok" : h === "offline" ? "danger" : "idle");
    const statusTone = s => (s === "running" ? "ok" : "idle");

    function render(host) {
        rootEl = host;
        host.innerHTML = `<div id="rs-grid" class="grid cols-3"></div>`;
    }

    async function load() {
        if (!rootEl) return;
        const grid = rootEl.querySelector("#rs-grid");
        try {
            const { runtimes } = await api.request("/runtime/status");
            grid.innerHTML = runtimes.map(card).join("");
            grid.querySelectorAll("[data-restart]").forEach(b =>
                b.addEventListener("click", () => restart(b.dataset.restart)));
            grid.querySelectorAll("[data-term]").forEach(b =>
                b.addEventListener("click", () => onOpenTerminal?.(b.dataset.term)));
        }
        catch (e) {
            grid.innerHTML = `<div class="panel" style="grid-column:1/-1"><div class="empty">${icon("alert")}<div class="danger-text">${esc(e.message)}</div></div></div>`;
        }
    }

    function card(r) {
        const meta = (k, v) => `<div class="meta"><span class="dim">${k}</span> ${v}</div>`;
        return `
            <div class="stat">
                <div class="label">${icon("activity")} ${esc(r.label)}
                    <span class="push">${pill(r.status, statusTone(r.status))}</span></div>
                <div class="value" style="font-size:15px">${pill(r.health, healthTone(r.health))}</div>
                ${meta("PID", r.pid ?? "—")}
                ${meta("Uptime", fmtUptime(r.uptime))}
                ${meta("CPU", r.cpu == null ? "—" : r.cpu + "%")}
                ${meta("Memori", r.memory == null ? "—" : r.memory + " MB")}
                ${meta("Restart", esc(r.restartPolicy))}
                ${meta("Owner", esc(r.owner))}
                ${meta("Purpose", esc(r.purpose))}
                <div class="row" style="gap:6px;margin-top:8px">
                    ${r.canRestart ? `<button class="btn sm" data-restart="${esc(r.key)}">${icon("refresh")} Restart</button>` : ""}
                    <button class="btn ghost sm" data-term="${esc(r.purpose)}">${icon("terminal")} Terminal</button>
                </div>
            </div>`;
    }

    async function restart(key) {
        toast(`Merestart ${key}…`, "ok", 2000);
        try {
            const r = await api.request(`/runtime/${key}/restart`, { method: "POST", body: {} });
            toast(r.ready ? `${key} siap ✅` : `${key} dijalankan (cek terminal)`, r.ready ? "ok" : "warn", 5000);
            await load();
        }
        catch (e) { toast(e.message, "danger", 6000); }
    }

    function mount(host) {
        rootEl = host;
        load();
        timer = setInterval(load, 3000);   // business state via REST poll
    }

    function unmount() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { render, mount, unmount };
}
