import { icon } from "./icons.js";
import { esc } from "./ui.js";

/**
 * Command Palette (⌘K / Ctrl+K) — satu titik untuk memanggil fungsi
 * apa pun: pindah view atau jalankan aksi. Ringan, tanpa dependensi.
 *
 * items: [{ icon, name, group, run() }]
 */
let open = false;

export function openCommandPalette(items = []) {

    if (open) return;
    open = true;

    let active = 0;
    let filtered = items;

    const scrim = document.createElement("div");
    scrim.className = "cmdk-scrim";
    scrim.innerHTML = `
        <div class="cmdk" role="dialog" aria-label="Command palette">
            <div class="search">${icon("search")}
                <input type="text" id="cmdk-input" placeholder="Ketik perintah atau halaman…" autocomplete="off">
            </div>
            <div class="results" id="cmdk-results"></div>
        </div>`;
    document.body.appendChild(scrim);

    const input = scrim.querySelector("#cmdk-input");
    const results = scrim.querySelector("#cmdk-results");

    function renderList() {
        if (!filtered.length) {
            results.innerHTML = `<div class="none">Tak ada hasil.</div>`;
            return;
        }
        results.innerHTML = filtered.map((it, i) => `
            <div class="opt ${i === active ? "active" : ""}" data-i="${i}">
                ${icon(it.icon ?? "activity")}
                <span class="nm">${esc(it.name)}</span>
                <span class="grp">${esc(it.group ?? "")}</span>
            </div>`).join("");
        results.querySelectorAll(".opt").forEach(node => {
            node.addEventListener("mouseenter", () => { active = Number(node.dataset.i); paint(); });
            node.addEventListener("click", () => choose(Number(node.dataset.i)));
        });
    }

    function paint() {
        results.querySelectorAll(".opt").forEach((n, i) => n.classList.toggle("active", i === active));
        results.querySelector(".opt.active")?.scrollIntoView({ block: "nearest" });
    }

    function choose(i) {
        const it = filtered[i];
        close();
        it?.run?.();
    }

    function filter(q) {
        const s = q.trim().toLowerCase();
        filtered = s ? items.filter(it =>
            it.name.toLowerCase().includes(s) || (it.group ?? "").toLowerCase().includes(s)) : items;
        active = 0;
        renderList();
    }

    function onKey(e) {
        if (e.key === "Escape") { close(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); paint(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
        else if (e.key === "Enter") { e.preventDefault(); choose(active); }
    }

    function close() {
        open = false;
        document.removeEventListener("keydown", onKey, true);
        scrim.remove();
    }

    scrim.addEventListener("mousedown", e => { if (e.target === scrim) close(); });
    input.addEventListener("input", () => filter(input.value));
    document.addEventListener("keydown", onKey, true);

    renderList();
    input.focus();
}
