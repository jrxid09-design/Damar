import { store } from "../../lib/store.js";
import { icon } from "../../lib/icons.js";
import { esc, toast } from "../../lib/ui.js";
import { terminalApi } from "../../lib/terminalClient.js";

/**
 * Panel Terminal (modular) — dipakai di dalam Runtime Console.
 * xterm.js tetap terpisah dari shell konsol. Factory → state per-instance.
 * Kontrak panel: { render(host), mount(host), unmount(), openByPurpose(p) }
 */

const THEME = {
    background: "#0a0e1a", foreground: "#e8ecff", cursor: "#22d3ee",
    selectionBackground: "#264f78",
    black: "#0a0e1a", red: "#fb7185", green: "#34d399", yellow: "#fbbf24",
    blue: "#7c8cff", magenta: "#c084fc", cyan: "#22d3ee", white: "#e8ecff", brightBlack: "#5e6788"
};

export function terminalPanel() {

    const tabs = new Map();   // id → { meta, term, fit, search, conn, pane }
    let activeId = null;
    let rootEl = null;
    let onResize = null;

    const $ = sel => rootEl.querySelector(sel);

    function render(host) {
        rootEl = host;
        host.innerHTML = `
            <div class="row wrap" style="gap:8px;margin-bottom:8px">
                <select id="tp-shell" style="width:130px"></select>
                <label class="switch" title="Buka sebagai Administrator (butuh gsudo/sudo atau daemon admin)">
                    <input type="checkbox" id="tp-admin"><span class="track"></span><span>Admin</span></label>
                <button class="btn primary sm" id="tp-new">${icon("plus")} Baru</button>
                <input type="text" id="tp-search" placeholder="cari output…" style="width:150px">
                <button class="btn ghost sm" id="tp-clear">Bersihkan</button>
                <button class="btn ghost sm" id="tp-copy">Salin</button>
                <button class="btn ghost sm" id="tp-paste">Tempel</button>
            </div>
            <div class="term-tabs" id="tp-tabs"></div>
            <div class="term-host" id="tp-host">
                <div class="empty" id="tp-empty">${icon("terminal")}
                    <div>Belum ada terminal. Tekan <strong>Baru</strong>.</div></div>
            </div>`;
    }

    async function mount(host) {
        rootEl = host;
        if (!store.get().connected) { $("#tp-host").innerHTML = `<div class="empty">${icon("plug")}<div>Sambungkan ke daemon.</div></div>`; return; }
        if (typeof window.Terminal !== "function") { $("#tp-host").innerHTML = `<div class="empty danger-text">xterm.js gagal dimuat.</div>`; return; }

        let data;
        try { data = await terminalApi.list(); }
        catch (e) { toast(`Terminal: ${e.message}`, "danger"); return; }

        if (!data.available) {
            $("#tp-host").innerHTML = `<div class="empty warn-text">Runtime terminal nonaktif — <span class="mono">npm install node-pty</span> lalu mulai ulang daemon.</div>`;
            return;
        }

        $("#tp-shell").innerHTML = (data.shells || []).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
        for (const meta of data.terminals || []) open(meta);
        if (!tabs.size) showEmpty(true);

        $("#tp-new").addEventListener("click", async () => {
            try {
                const meta = await terminalApi.create({
                    shell: $("#tp-shell").value, terminalType: "USER", elevated: $("#tp-admin")?.checked
                });
                open(meta);
                if ($("#tp-admin")?.checked && !meta.elevated) {
                    toast("Terminal admin tak tersedia (butuh gsudo / daemon sebagai Administrator). Dibuka terminal biasa.", "warn", 6000);
                }
            }
            catch (e) { toast(e.message, "danger"); }
        });
        $("#tp-clear").addEventListener("click", () => tabs.get(activeId)?.term.clear());
        $("#tp-copy").addEventListener("click", async () => {
            const s = tabs.get(activeId)?.term.getSelection();
            if (s) { try { await navigator.clipboard.writeText(s); toast("Disalin", "ok", 1200); } catch { /* */ } }
        });
        $("#tp-paste").addEventListener("click", async () => {
            try { tabs.get(activeId)?.conn.input(await navigator.clipboard.readText()); } catch { /* */ }
        });
        const si = $("#tp-search");
        si.addEventListener("keydown", e => { if (e.key === "Enter") tabs.get(activeId)?.search.findNext(si.value); });

        onResize = () => { const t = tabs.get(activeId); if (t) { try { t.fit.fit(); t.conn.resize(t.term.cols, t.term.rows); } catch { /* */ } } };
        window.addEventListener("resize", onResize);
    }

    function unmount() {
        if (onResize) window.removeEventListener("resize", onResize);
        for (const t of tabs.values()) { try { t.conn.close(); } catch {} try { t.term.dispose(); } catch {} }
        tabs.clear();
        activeId = null;
    }

    function showEmpty(show) { const e = $("#tp-empty"); if (e) e.style.display = show ? "" : "none"; }

    function open(meta) {
        if (tabs.has(meta.id)) { switchTo(meta.id); return; }
        showEmpty(false);
        const pane = document.createElement("div");
        pane.className = "term-pane"; pane.style.display = "none";
        $("#tp-host").appendChild(pane);

        const term = new window.Terminal({ fontFamily: "Consolas,'Cascadia Mono',monospace", fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true, theme: THEME });
        const fit = new window.FitAddon.FitAddon();
        const search = new window.SearchAddon.SearchAddon();
        term.loadAddon(fit); term.loadAddon(search); term.open(pane);

        const conn = terminalApi.stream(meta.id, {
            onSnapshot: f => { if (f.data) term.write(f.data); },
            onData: d => term.write(d),
            onExit: code => term.write(`\r\n\x1b[90m[proses berakhir: ${code}]\x1b[0m\r\n`)
        });
        term.onData(d => conn.input(d));

        tabs.set(meta.id, { meta, term, fit, search, conn, pane });
        renderTabs();
        switchTo(meta.id);
    }

    function switchTo(id) {
        activeId = id;
        for (const [tid, t] of tabs) t.pane.style.display = tid === id ? "" : "none";
        renderTabs();
        const t = tabs.get(id);
        if (t) requestAnimationFrame(() => { try { t.fit.fit(); t.conn.resize(t.term.cols, t.term.rows); t.term.focus(); } catch { /* */ } });
    }

    function renderTabs() {
        const bar = $("#tp-tabs");
        if (!bar) return;
        bar.innerHTML = [...tabs.values()].map(t => {
            const sys = t.meta.terminalType === "SYSTEM";
            return `<div class="term-tab ${t.meta.id === activeId ? "active" : ""}" data-tab="${esc(t.meta.id)}" title="${esc(t.meta.shell)} · ${esc(t.meta.terminalType)}">
                ${sys ? "🔒 " : ""}<span class="lbl">${esc(t.meta.name)}</span><span class="x" data-close="${esc(t.meta.id)}">✕</span></div>`;
        }).join("");
        bar.querySelectorAll("[data-tab]").forEach(el => {
            el.addEventListener("click", ev => { if (!ev.target.dataset.close) switchTo(el.dataset.tab); });
            el.addEventListener("dblclick", () => rename(el.dataset.tab));
        });
        bar.querySelectorAll("[data-close]").forEach(x => x.addEventListener("click", () => close(x.dataset.close)));
    }

    async function rename(id) {
        const t = tabs.get(id); if (!t) return;
        const name = window.prompt("Nama terminal:", t.meta.name);
        if (!name || name === t.meta.name) return;
        try { t.meta = await terminalApi.rename(id, name); renderTabs(); }
        catch (e) { toast(e.message, "danger"); }
    }

    async function close(id) {
        const t = tabs.get(id); if (!t) return;
        let force = false;
        if (t.meta.terminalType === "SYSTEM") { if (!window.confirm(`"${t.meta.name}" terminal SYSTEM. Tetap tutup?`)) return; force = true; }
        try { await terminalApi.close(id, force); } catch (e) { toast(e.message, "danger"); return; }
        try { t.conn.close(); } catch {} try { t.term.dispose(); } catch {}
        t.pane.remove(); tabs.delete(id);
        if (activeId === id) { const n = tabs.keys().next().value; if (n) switchTo(n); else { activeId = null; showEmpty(true); } }
        renderTabs();
    }

    /** Buka/fokuskan terminal berdasarkan purpose (dipakai Runtime Status). */
    async function openByPurpose(purpose) {
        const live = [...tabs.values()].find(t => t.meta.purpose === purpose);
        if (live) { switchTo(live.meta.id); return; }
        try {
            const list = (await terminalApi.list()).data.terminals || [];
            const meta = list.find(m => m.purpose === purpose);
            if (meta) open(meta);
            else toast(`Belum ada terminal untuk "${purpose}".`, "warn");
        }
        catch (e) { toast(e.message, "danger"); }
    }

    return { render, mount, unmount, openByPurpose };
}
