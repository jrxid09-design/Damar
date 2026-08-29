/**
 * Damar Timeline — jejak temporal bercahaya (canvas 2D).
 *
 * Spec: line = "thin luminous temporal path". Event = node emisif.
 * Hover = nilai eksak waktu. Tanpa animasi dekoratif.
 */

export function createTimeline(host) {

    const canvas = document.createElement("canvas");
    canvas.className = "ae-timeline";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Garis waktu kejadian");
    const ctx = canvas.getContext("2d");
    host.appendChild(canvas);

    let points = [];        // { t: Date|number, v: number, label? }
    let hovering = -1;
    let unit = "";

    function setData(items, { unit: u = "" } = {}) {
        unit = u;
        points = items.map(p => ({
            t: p.t instanceof Date ? p.t : new Date(p.t),
            v: Number(p.v) || 0,
            label: p.label ?? null
        })).sort((a, b) => a.t - b.t);
        draw();
    }

    function draw() {
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h || !points.length) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== w * dpr) {
            canvas.width = w * dpr; canvas.height = h * dpr;
            canvas.style.width = w + "px"; canvas.style.height = h + "px";
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const padX = 10, padT = 8, padB = 18;
        const t0 = points[0].t.getTime(), t1 = points[points.length - 1].t.getTime() || t0 + 1;
        const vs = points.map(p => p.v);
        const vMin = Math.min(...vs), vMax = Math.max(...vs);
        const vRange = (vMax - vMin) || 1;

        const X = (t) => padX + (t - t0) / (t1 - t0) * (w - padX * 2);
        const Y = (v) => padT + (1 - (v - vMin) / vRange) * (h - padT - padB);

        // Jalur cahaya tipis.
        ctx.strokeStyle = "rgba(0, 223, 255, 0.85)";
        ctx.lineWidth = 1.4;
        ctx.shadowColor = "rgba(0, 223, 255, 0.5)";
        ctx.shadowBlur = 6;
        ctx.beginPath();
        points.forEach((p, i) => {
            const x = X(p.t.getTime()), y = Y(p.v);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Isian lembut di bawah garis (permukaan holografik berlapis).
        const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
        grad.addColorStop(0, "rgba(0, 223, 255, 0.12)");
        grad.addColorStop(1, "rgba(0, 223, 255, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        points.forEach((p, i) => {
            const x = X(p.t.getTime()), y = Y(p.v);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.lineTo(X(t1), h - padB); ctx.lineTo(X(t0), h - padB);
        ctx.closePath(); ctx.fill();

        // Node event.
        points.forEach((p, i) => {
            const x = X(p.t.getTime()), y = Y(p.v);
            const active = i === hovering;
            ctx.fillStyle = active ? "#F5FBFF" : "rgba(0, 223, 255, 0.9)";
            ctx.beginPath(); ctx.arc(x, y, active ? 3.4 : 2, 0, Math.PI * 2); ctx.fill();
        });

        // Label waktu (min & max saja — tanpa kebisingan).
        ctx.fillStyle = "rgba(120, 144, 163, 0.85)";
        ctx.font = "9px 'Cascadia Code', Consolas, monospace";
        ctx.textAlign = "left";
        ctx.fillText(fmt(points[0].t), padX, h - 5);
        ctx.textAlign = "right";
        ctx.fillText(fmt(points[points.length - 1].t), w - padX, h - 5);

        // Tooltip hover.
        if (hovering >= 0) {
            const p = points[hovering];
            const x = X(p.t.getTime()), y = Y(p.v);
            const txt = p.label ?? `${Math.round(p.v * 100) / 100}${unit}`;
            ctx.font = "10px 'Cascadia Code', Consolas, monospace";
            const tw = ctx.measureText(txt).width;
            const bx = Math.min(Math.max(x - tw / 2 - 7, 4), w - tw - 18);
            ctx.strokeStyle = "rgba(0, 223, 255, 0.4)";
            ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y - 16); ctx.stroke();
            ctx.fillStyle = "rgba(18, 30, 45, 0.94)";
            ctx.beginPath(); ctx.roundRect(bx, y - 36, tw + 14, 20, 3); ctx.fill();
            ctx.fillStyle = "#D8E7F2"; ctx.textAlign = "left";
            ctx.fillText(txt, bx + 7, y - 22);
        }
    }

    const fmt = (d) => {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
    };

    const onMove = (e) => {
        if (!points.length) return;
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left;
        let best = -1, bd = 1e9;
        const w = host.clientWidth;
        const t0 = points[0].t.getTime(), t1 = points[points.length - 1].t.getTime() || 1;
        points.forEach((p, i) => {
            const x = 10 + (p.t.getTime() - t0) / (t1 - t0) * (w - 20);
            const d = Math.abs(x - mx);
            if (d < bd) { bd = d; best = i; }
        });
        hovering = bd < 14 ? best : -1;
        draw();
    };

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", () => { hovering = -1; draw(); });

    const observer = new ResizeObserver(() => draw());
    observer.observe(host);

    return {
        el: canvas,
        setData,
        destroy() { observer.disconnect(); canvas.remove(); }
    };
}
