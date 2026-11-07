import { icon } from "./icons.js";
import { esc } from "./ui.js";
import { agentBus } from "./agentBus.js";

/**
 * HOME BUBBLES — respon transient Damar di dashboard Beranda.
 *
 * Perilaku (revisi pemilik):
 *   - Maksimal 3 bubble — ke-4 menggeser tertua.
 *   - TANPA tombol close — bubble hidup sendiri.
 *   - Umur: 1 MENIT sejak aktivitas terakhir (respon baru/typing
 *     memperpanjang; senyap penuh 1 menit → semua memudar).
 *   - Hanya hidup di layar BERANDA — pindah menu = bersih.
 *   - Riwayat penuh tetap di panel chat ikhtisar (onArchive).
 */

const MAX_BUBBLES = 3;
const IDLE_TTL_MS = 60000;        // 1 menit tanpa aktivitas → hilang

const stack = () => document.querySelector("#mc-bubbles .hcb-stack");

/** Timer global idle — satu untuk seluruh stack. */
let idleTimer = null;
let nodes = [];

/** Reset umur: aktivitas apa pun (bubble baru, append typing). */
function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(clearAll, IDLE_TTL_MS);
}

function dismiss(el) {
    if (!el?.isConnected) return;
    el.classList.add("out");
    setTimeout(() => {
        el.remove();
        nodes = nodes.filter(n => n !== el);
    }, 260);
}

function clearAll() {
    for (const el of [...nodes]) dismiss(el);
    clearTimeout(idleTimer);
    idleTimer = null;
}

function prune() {
    while (nodes.length > MAX_BUBBLES) {
        dismiss(nodes[0]);
    }
}

function mount() {
    let host = document.querySelector("#mc-bubbles");
    if (!host) {
        host = document.createElement("div");
        host.id = "mc-bubbles";
        host.className = "mc-bubbles";
        host.setAttribute("aria-live", "polite");
        // Tempel ke zona orb Beranda bila belum ada (bertahan hidup
        // hanya selama elemen itu ada — pindah menu = hilang otomatis).
        const zone = document.querySelector("#screen-core .holo-home") ?? document.querySelector("#screen-core") ?? document.body;
        zone.appendChild(host);
    }
    if (!host.querySelector(".hcb-stack")) {
        const s = document.createElement("div");
        s.className = "hcb-stack";
        host.appendChild(s);
    }
    return host.querySelector(".hcb-stack");
}

/**
 * Tampilkan satu bubble.
 * @param opts { kind: chat|media|task, role, text, html, media, sticky }
 */
export function showBubble(opts = {}) {

    const stackEl = mount();
    if (!stackEl) return null;

    const el = document.createElement("div");
    el.className = `hcb ${opts.kind ?? "chat"} ${opts.role ?? "assistant"}`;

    if (opts.kind === "media") {
        const m = opts.media ?? {};
        const thumb = m.kind === "image"
            ? `<img src="${esc(m.url)}" alt="" loading="lazy"
                   onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'hcb-media-err',textContent:'media gagal dimuat'}))">`
            : m.kind === "video"
                ? `<video src="${esc(m.url)}" muted playsinline></video>`
                : `<div class="hcb-doc">${icon("file")}<span>${esc(m.name ?? "dokumen")}</span></div>`;
        el.innerHTML = `
            <div class="hcb-media ${m.kind === "image" ? "" : "fit"}">${thumb}</div>
            ${m.caption ? `<div class="hcb-text">${esc(m.caption)}</div>` : ""}`;
        el.querySelector(".hcb-media").addEventListener("click", () => {
            opts.onOpen?.(m);
        });
    }
    else if (opts.kind === "task") {
        el.innerHTML = `<div class="hcb-task-steps"></div>`;
    }
    else {
        el.innerHTML = `
            <div class="hcb-who">${opts.role === "user" ? "Kamu" : "Damar"}</div>
            <div class="hcb-text"></div>`;
        const body = el.querySelector(".hcb-text");
        if (opts.html) body.innerHTML = opts.html;
        else body.textContent = opts.text ?? "";
    }

    stackEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));
    nodes.push(el);
    prune();
    touchIdle();

    return {
        el,
        appendText(delta) {
            const body = el.querySelector(".hcb-text");
            if (body) body.textContent += delta;
            touchIdle();
        },
        setText(text) {
            const body = el.querySelector(".hcb-text");
            if (body) body.textContent = text;
            touchIdle();
        },
        setSteps(steps) {
            const wrap = el.querySelector(".hcb-task-steps");
            if (!wrap) return;
            wrap.innerHTML = (steps ?? []).map(s => `
                <span class="hts ${s.tone ?? ""}" title="${esc(s.lbl)}">
                    ${icon(s.icon ?? "activity")}<em>${esc(s.lbl)}</em>
                </span>`).join("");
            touchIdle();
        },
        finish(ok = true) {
            el.classList.add(ok ? "ok" : "fail");
            touchIdle();
        },
        dismiss: () => dismiss(el)
    };
}

/**
 * Sambungkan agentBus → task bubble (timeline ikon saat Damar bekerja).
 */
export function wireTaskBubbles({ onArchive } = {}) {

    const live = new Map();

    const unsub = agentBus.subscribe(evt => {

        if (evt.t === "mood" && evt.m === "thinking") {
            step("thinking", { icon: "brain", lbl: "berpikir", tone: "run" });
        }
        else if (evt.t === "engage") {
            step("agent", { icon: "orb", lbl: `agent ${evt.id}`, tone: "run" });
        }
        else if (evt.t === "release") {
            step("done", { icon: evt.ok ? "check" : "x", lbl: evt.ok ? "berhasil" : "gagal", tone: evt.ok ? "ok" : "fail" });
        }
        else if (evt.t === "mood" && (evt.m === "success" || evt.m === "error")) {
            finishAll(evt.m === "success");
        }

    });

    function ensureBubble() {
        if (!live.has("b") || !live.get("b").el.isConnected) {
            live.set("b", showBubble({ kind: "task", role: "assistant", sticky: true }));
        }
        return live.get("b");
    }

    function step(key, s) {
        if (document.hidden) return;
        const b = ensureBubble();
        if (!b) return;
        if (!live.has("steps")) live.set("steps", []);
        const steps = live.get("steps");
        const i = steps.findIndex(x => x.key === key);
        if (i >= 0) steps[i] = { ...s, key };
        else steps.push({ ...s, key });
        b.setSteps(steps.map(({ key: _k, ...rest }) => rest));
    }

    function finishAll(ok) {
        const b = live.get("b");
        if (b) {
            const steps = (live.get("steps") ?? []).map(s =>
                s.tone === "run" ? { ...s, tone: ok ? "ok" : "fail" } : s);
            b.setSteps(steps);
            b.finish(ok);
            onArchive?.({ kind: "task", ok });
        }
        live.clear();
    }

    return () => { finishAll(true); unsub(); clearAll(); };
}

/** Bersihkan seluruh stack (dipanggil saat meninggalkan Beranda). */
export function clearBubbles() {
    clearAll();
}
