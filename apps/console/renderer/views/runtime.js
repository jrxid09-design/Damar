import { store } from "../lib/store.js";
import { icon } from "../lib/icons.js";
import { esc, clockTime } from "../lib/ui.js";
import { terminalPanel } from "./panels/terminalPanel.js";
import { runtimeStatusPanel } from "./panels/runtimeStatusPanel.js";

/**
 * Runtime Console — VS Code × service manager.
 * Panel: Terminal · Runtime (status) · Logs · Events.
 * Terminal I/O lewat WS; sisanya (status/log/event) lewat REST/SSE (store).
 * Panel modular → panel masa depan (Metrics/Inspector) tinggal ditambah.
 */

let mounted = null;

/** Panel Logs/Events dari store (SSE): kolom rapi, warna per level, saring. */
function logPanel(eventsOnly) {
    let list = null, filterEl = null, countEl = null, timer = null;

    const draw = () => {
        if (!list) return;
        const q = (filterEl?.value || "").toLowerCase();
        const rows = (store.get().logs || [])
            .filter(l => eventsOnly ? l.level === "event" : l.level !== "event")
            .filter(l => !q || String(l.message).toLowerCase().includes(q))
            .slice(-500).reverse();

        if (countEl) countEl.textContent = `${rows.length} ${eventsOnly ? "event" : "baris"}`;

        list.innerHTML = rows.length
            ? rows.map(l => {
                const lvl = l.level || "info";
                return `<div class="rc-log ${esc(lvl)}"><span class="time">${esc(clockTime(l.time))}</span>` +
                    `<span class="lvl">${esc(lvl)}</span><span class="msg">${esc(l.message)}</span></div>`;
            }).join("")
            : `<div class="empty">${icon(eventsOnly ? "activity" : "box")}<div>Belum ada ${eventsOnly ? "event" : "log"}.</div></div>`;
    };

    return {
        render(host) {
            host.innerHTML = `
                <div class="panel flush">
                    <div class="rc-logs-head">
                        <span class="small dim" id="rc-count"></span>
                        <input type="text" id="rc-filter" class="rc-filter" placeholder="saring ${eventsOnly ? "event" : "log"}…">
                    </div>
                    <div class="rc-logs" id="rc-ls"></div>
                </div>`;
            list = host.querySelector("#rc-ls");
            filterEl = host.querySelector("#rc-filter");
            countEl = host.querySelector("#rc-count");
            filterEl.addEventListener("input", draw);
        },
        mount() { draw(); timer = setInterval(draw, 1500); },
        unmount() { if (timer) clearInterval(timer); timer = null; }
    };
}

export const runtime = {

    id: "runtime",
    label: "Runtime",
    icon: "terminal",
    title: "Runtime Console",
    subtitle: "Terminal, runtime, log, dan event — satu konsol.",

    render(root) {
        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Runtime Console</h1>
                    <p>Terminal, status runtime, log &amp; event dalam satu konsol.</p>
                </div>
            </div>
            <div class="seg" id="rc-tabs">
                <button type="button" data-p="terminal" class="active">${icon("terminal")} Terminal</button>
                <button type="button" data-p="runtime">${icon("activity")} Runtime</button>
                <button type="button" data-p="logs">${icon("box")} Logs</button>
                <button type="button" data-p="events">${icon("activity")} Events</button>
            </div>
            <div id="rc-host"></div>`;
    },

    async mount(root) {
        const host = root.querySelector("#rc-host");
        const tp = terminalPanel();

        const panels = {
            terminal: tp,
            runtime: runtimeStatusPanel({
                onOpenTerminal: purpose => { open("terminal"); requestAnimationFrame(() => tp.openByPurpose(purpose)); }
            }),
            logs: logPanel(false),
            events: logPanel(true)
        };

        const open = async (p) => {
            root.querySelectorAll("#rc-tabs [data-p]").forEach(b => b.classList.toggle("active", b.dataset.p === p));
            if (mounted) mounted.unmount?.();
            host.innerHTML = "";
            const panel = panels[p];
            panel.render(host);
            await panel.mount?.(host);
            mounted = panel;
        };

        root.querySelectorAll("#rc-tabs [data-p]").forEach(b => b.addEventListener("click", () => open(b.dataset.p)));
        await open("terminal");
    },

    unmount() {
        mounted?.unmount?.();
        mounted = null;
    }

};
