/**
 * Aether Memory Graph — jaringan pengetahuan kanonik (canvas 2D).
 *
 * Spec: memori harus tampak seperti jaringan pengetahuan cerdas,
 * BUKAN database:
 *   - episodic   → node event VIOLET
 *   - semantic   → node pengetahuan CYAN
 *   - procedural → node proses CYAN-BIRU
 *   - important  → luminositas lebih tinggi
 *   - entitas    → node orbit (orang/rumah/kendaraan…) + link
 *   - retrieval  → aliran partikel menuju pusat (Aether)
 *
 * Interaksi: hover = nilai eksak; tanpa WebGL (aksesibel & murah).
 */

import { aetherState } from "../aetherState.js";

const COLOR = {
    episodic:   "#7C5CFF",
    semantic:   "#00DFFF",
    preference: "#FFC857",
    procedural: "#28AFFF",
    entity:     "#73EDFF",
    link:       "rgba(115, 237, 255, 0.16)",
    linkActive: "rgba(115, 237, 255, 0.45)"
};

export function createMemoryGraph(host) {

    const canvas = document.createElement("canvas");
    canvas.className = "ae-memgraph";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Graf jaringan memori Aether");
    const ctx = canvas.getContext("2d");
    host.appendChild(canvas);

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let nodes = [];        // { id, label, type, x, y, vx, vy, r, pinned }
    let links = [];        // { a, b }
    let hovering = null;
    let selected = null;
    let raf = 0;
    let running = true;
    let dpr = 1;

    // ---- data -------------------------------------------------------

    /** Terima data API: memories[] + entities[] → graph. */
    function setData({ memories = [], entities = [] } = {}) {

        nodes = [];
        links = [];

        // Pusat: Aether (cognitive core).
        nodes.push({ id: "__aether", label: "Aether", type: "core", x: 0, y: 0, vx: 0, vy: 0, r: 13, fixed: true });

        const entMap = new Map();

        for (const e of entities.slice(0, 40)) {
            const n = {
                id: "e:" + e.id, label: e.name ?? e.kind ?? "entitas",
                type: "entity", kind: e.kind,
                x: (Math.random() - 0.5) * 200, y: (Math.random() - 0.5) * 140,
                vx: 0, vy: 0, r: 4 + Math.min(4, (e.mentions ?? 1) * 0.4)
            };
            entMap.set(n.id, n);
            nodes.push(n);
            links.push({ a: nodes[0], b: n });
        }

        for (const m of memories.slice(0, 90)) {
            const type = m.type ?? m.memoryType ?? "semantic";
            const importance = m.importance ?? m.score ?? 0.5;
            const n = {
                id: "m:" + (m.id ?? nodes.length), label: m.content ?? m.summary ?? type,
                type, x: (Math.random() - 0.5) * 320, y: (Math.random() - 0.5) * 220,
                vx: 0, vy: 0,
                r: 2.5 + importance * 3.5,
                important: importance >= 0.75
            };
            nodes.push(n);
            // Hubungkan ke pusat dengan kekuatan sesuai kepentingan.
            links.push({ a: nodes[0], b: n, weak: importance < 0.4 });
            // Hubungkan ke entitas terkait bila ada.
            for (const ent of (m.entities ?? []).slice(0, 2)) {
                const target = entMap.get("e:" + (ent.id ?? ent));
                if (target) links.push({ a: n, b: target, weak: true });
            }
        }

        draw();
    }

    // ---- simulasi ringan (force-directed terkendali) ----------------

    function step() {
        if (!nodes.length) return;
        const REP = 2600, SPRING = 0.012, CENTER = 0.015;

        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = a.x - b.x, dy = a.y - b.y;
                let d2 = dx * dx + dy * dy || 1;
                if (d2 > 62500) continue;             // potong jarak jauh
                const f = REP / d2;
                const d = Math.sqrt(d2);
                dx /= d; dy /= d;
                a.vx += dx * f; a.vy += dy * f;
                b.vx -= dx * f; b.vy -= dy * f;
            }
        }
        for (const l of links) {
            const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const rest = l.a.type === "core" ? 90 : 60;
            const f = (d - rest) * SPRING * (l.weak ? 0.4 : 1);
            const ux = dx / d, uy = dy / d;
            if (!l.a.fixed) { l.a.vx += ux * f; l.a.vy += uy * f; }
            if (!l.b.fixed) { l.b.vx -= ux * f; l.b.vy -= uy * f; }
        }
        for (const n of nodes) {
            if (n.fixed) continue;
            n.vx -= n.x * CENTER; n.vy -= n.y * CENTER;
            n.vx *= 0.82; n.vy *= 0.82;
            n.x += Math.max(-4, Math.min(4, n.vx));
            n.y += Math.max(-4, Math.min(4, n.vy));
        }
    }

    // ---- render ------------------------------------------------------

    function draw() {
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) return;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== w * dpr) {
            canvas.width = w * dpr; canvas.height = h * dpr;
            canvas.style.width = w + "px"; canvas.style.height = h + "px";
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const cx = w / 2, cy = h / 2;

        // Link.
        for (const l of links) {
            const active = hovering && (l.a === hovering || l.b === hovering);
            ctx.strokeStyle = active ? COLOR.linkActive : COLOR.link;
            ctx.lineWidth = active ? 1.2 : 0.7;
            ctx.beginPath();
            ctx.moveTo(cx + l.a.x, cy + l.a.y);
            ctx.lineTo(cx + l.b.x, cy + l.b.y);
            ctx.stroke();
        }

        // Node.
        const t = performance.now() * 0.001;
        for (const n of nodes) {
            const x = cx + n.x, y = cy + n.y;
            const col = n.type === "core" ? "#00DFFF" : COLOR[n.type] ?? COLOR.semantic;
            const isHover = n === hovering || n === selected;

            // Halo untuk node penting / hover.
            if (n.important || isHover) {
                const glowR = n.r + 4 + (reduced ? 0 : Math.sin(t * 1.4 + n.x) * 1.5);
                const g = ctx.createRadialGradient(x, y, 0, x, y, glowR * 2.2);
                g.addColorStop(0, col + "55");
                g.addColorStop(1, "transparent");
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(x, y, glowR * 2.2, 0, Math.PI * 2); ctx.fill();
            }

            ctx.fillStyle = col;
            ctx.globalAlpha = n.type === "core" ? 1 : isHover ? 1 : 0.82;
            ctx.beginPath();
            if (n.type === "core") {
                // Diamond — identitas Aether.
                ctx.moveTo(x, y - n.r * 1.4); ctx.lineTo(x + n.r, y);
                ctx.lineTo(x, y + n.r * 1.4); ctx.lineTo(x - n.r, y);
            } else {
                ctx.arc(x, y, n.r, 0, Math.PI * 2);
            }
            ctx.closePath(); ctx.fill();
            ctx.globalAlpha = 1;

            if (isHover) {
                ctx.strokeStyle = "#F5FBFF";
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(x, y, n.r + 4, 0, Math.PI * 2); ctx.stroke();
            }
        }

        // Label hover (nilai eksak).
        if (hovering && hovering.type !== "core") {
            const label = hovering.label.length > 64 ? hovering.label.slice(0, 64) + "…" : hovering.label;
            ctx.font = "11px 'Cascadia Code', Consolas, monospace";
            const tw = ctx.measureText(label).width;
            const bx = Math.min(Math.max(cx + hovering.x - tw / 2 - 8, 6), w - tw - 22);
            const by = cy + hovering.y - hovering.r - 30;
            ctx.fillStyle = "rgba(18, 30, 45, 0.92)";
            ctx.strokeStyle = "rgba(115, 237, 255, 0.25)";
            ctx.beginPath();
            ctx.roundRect(bx, by, tw + 16, 22, 3);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = "#D8E7F2";
            ctx.fillText(label, bx + 8, by + 15);
            ctx.fillStyle = COLOR[hovering.type] ?? COLOR.semantic;
            ctx.fillText(hovering.type, bx + 8, by - 6);
        }
    }

    function tick() {
        if (!running) return;
        if (!reduced) step();
        draw();
        raf = requestAnimationFrame(tick);
    }

    // ---- interaksi ----------------------------------------------------

    function pick(mx, my) {
        const w = host.clientWidth, h = host.clientHeight;
        const cx = w / 2, cy = h / 2;
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            const dx = cx + n.x - mx, dy = cy + n.y - my;
            if (dx * dx + dy * dy < (n.r + 6) * (n.r + 6)) return n;
        }
        return null;
    }

    const onMove = (e) => {
        const r = canvas.getBoundingClientRect();
        hovering = pick(e.clientX - r.left, e.clientY - r.top);
        canvas.style.cursor = hovering ? "pointer" : "default";
    };
    const onLeave = () => { hovering = null; };
    const onClick = () => {
        selected = hovering;
        canvas.dispatchEvent(new CustomEvent("node-select", {
            bubbles: true,
            detail: selected ? { id: selected.id, label: selected.label, type: selected.type } : null
        }));
    };

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick);

    const observer = new ResizeObserver(() => draw());
    observer.observe(host);

    raf = requestAnimationFrame(tick);

    return {
        el: canvas,
        setData,
        pause() { running = false; cancelAnimationFrame(raf); },
        resume() { if (!running) { running = true; raf = requestAnimationFrame(tick); } },
        destroy() {
            this.pause();
            observer.disconnect();
            canvas.remove();
        }
    };
}
