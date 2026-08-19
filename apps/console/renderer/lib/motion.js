/**
 * Aether Motion — registri gerak semantik terpusat.
 *
 * Prinsip (spesifikasi): gerak mengomunikasikan kecerdasan, kausalitas,
 * dan keadaan — TIDAK ADA animasi acak, tanpa bouncing berlebihan,
 * tanpa scaling tanpa makna.
 *
 * Token timing diambil dari CSS (aether.tokens.css) supaya satu sumber:
 *   ambient 4000ms · interaction 160ms · cognitive 800ms ·
 *   system 240ms · critical 320ms
 */

const cssVar = (name) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || "";
};

const reducedMotion = () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export const motion = {

    reducedMotion,

    /**
     * Semanti gerak panel: memancar dari entitas asal saat dibuka,
     * menyusut kembali ke asal saat ditutup.
     * Mengembalikan Promise yang selesai saat animasi selesai.
     */
    project(el) {
        if (!el || reducedMotion()) return Promise.resolve();
        el.classList.remove("is-retracting");
        el.style.animation = "none";
        void el.offsetWidth; // reflow agar animasi bisa diputar ulang
        el.style.animation = "";
        el.dataset.origin = el.dataset.origin || "entity";
        return new Promise(res => {
            el.addEventListener("animationend", () => res(), { once: true });
        });
    },

    retract(el) {
        if (!el || reducedMotion()) return Promise.resolve();
        el.classList.add("is-retracting");
        return new Promise(res => {
            el.addEventListener("animationend", () => {
                el.classList.remove("is-retracting");
                res();
            }, { once: true });
        });
    },

    /** Denyut kognitif sekali (mis. saat tugas dimulai/selesai). */
    pulse(el, kind = "cognitive") {
        if (!el || reducedMotion()) return;
        const dur = cssVar(`--ae-motion-${kind}`) || "800ms";
        el.style.transition = "box-shadow " + dur;
        el.style.boxShadow = "var(--ae-glow-cyan-3)";
        setTimeout(() => { el.style.boxShadow = ""; }, 600);
    },

    /** Redupkan elemen yang tak relevan saat fokus tugas. */
    dim(el, on = true) {
        if (!el) return;
        el.style.transition = "opacity var(--ae-motion-interaction), filter var(--ae-motion-interaction)";
        el.style.opacity = on ? ".35" : "1";
        el.style.filter = on ? "saturate(.6)" : "";
    }
};
