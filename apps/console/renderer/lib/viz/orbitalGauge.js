/**
 * Aether Orbital Gauge — indikator orbital minimal (canvas 2D).
 *
 * Spec data_visualization.gauge: "minimal orbital indicator" —
 * cincin busur tipis bercahaya, BUKAN speedometer generik.
 * Keadaan warna mengikuti semantik kanon (cyan sehat, kuning
 * perhatian, merah kritis).
 */

export function createOrbitalGauge(host, { label = "", unit = "%" } = {}) {

    const canvas = document.createElement("canvas");
    canvas.className = "ae-orbital-gauge";
    canvas.setAttribute("role", "meter");
    canvas.setAttribute("aria-label", label);
    const ctx = canvas.getContext("2d");
    host.appendChild(canvas);

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let value = 0;          // 0..1
    let shown = 0;          // animasi
    let tone = "cyan";      // cyan | yellow | red
    let raf = 0;

    const TONE = {
        cyan:   { v: "#00DFFF", soft: "rgba(0, 223, 255, 0.18)" },
        yellow: { v: "#FFC857", soft: "rgba(255, 200, 87, 0.18)" },
        red:    { v: "#FF304F", soft: "rgba(255, 48, 79, 0.20)" }
    };

    function set(v, t) {
        value = Math.max(0, Math.min(1, Number(v) || 0));
        if (t) tone = t;
        canvas.setAttribute("aria-valuenow", String(Math.round(value * 100)));
        canvas.setAttribute("aria-valuetext", `${Math.round(value * 100)}${unit}`);
    }

    function draw() {
        const w = host.clientWidth || 84, h = host.clientHeight || 84;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== w * dpr) {
            canvas.width = w * dpr; canvas.height = h * dpr;
            canvas.style.width = w + "px"; canvas.style.height = h + "px";
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        shown += (value - shown) * (reduced ? 1 : 0.12);

        const cx = w / 2, cy = h / 2;
        const R = Math.min(w, h) / 2 - 7;
        const c = TONE[tone];

        // Cincin dasar redup.
        ctx.strokeStyle = "rgba(120, 144, 163, 0.16)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, R, -Math.PI * 0.75, Math.PI * 0.75);   // busur 270°
        ctx.stroke();

        // Busur nilai — luminous path.
        const span = Math.PI * 1.5;
        ctx.strokeStyle = c.v;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.shadowColor = c.v;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, R, -Math.PI * 0.75, -Math.PI * 0.75 + span * shown);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Node ujung busur (indikator posisi).
        const ang = -Math.PI * 0.75 + span * shown;
        ctx.fillStyle = "#F5FBFF";
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, 2.4, 0, Math.PI * 2);
        ctx.fill();

        // Nilai di pusat — angka tabular.
        ctx.fillStyle = "#F5FBFF";
        ctx.font = "600 15px 'Cascadia Code', Consolas, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(Math.round(shown * 100)), cx, cy - 5);
        if (unit) {
            ctx.fillStyle = "rgba(120, 144, 163, 0.9)";
            ctx.font = "9px 'Cascadia Code', Consolas, monospace";
            ctx.fillText(unit, cx, cy + 10);
        }

        raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return {
        el: canvas,
        set,
        destroy() { cancelAnimationFrame(raf); canvas.remove(); }
    };
}
