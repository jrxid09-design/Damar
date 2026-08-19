import { HandTracker } from "./handTracker.js";

/**
 * Perekat gestur → avatar. Membuat preview kamera kecil (video + overlay
 * garis pinch), menyalakan HandTracker saat diminta, dan meneruskan
 * onRotate/onZoom ke avatar (entity/hologram yang punya rotate()/zoom()).
 *
 * Opt-in: kamera TIDAK menyala sampai toggle/enable dipanggil. Aman bila
 * avatar tak mendukung gestur (rotate/zoom absen) — tombol tetap ada
 * tapi tak melakukan apa-apa berbahaya.
 *
 * @param {{rotate?:Function,zoom?:Function,resetView?:Function}} avatar
 * @param {{onStatus?:Function, assets?:object}} [opts]
 */
export function createGestureControl(avatar, opts = {}) {

    const el = document.createElement("div");
    el.className = "gesture-preview";
    el.style.cssText = "position:relative;width:160px;height:120px;display:none;border-radius:8px;overflow:hidden;background:#0008";

    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    video.style.cssText = "width:100%;height:100%;object-fit:cover;transform:scaleX(-1)";

    const overlay = document.createElement("canvas");
    overlay.width = 160; overlay.height = 120;
    overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";

    el.appendChild(video);
    el.appendChild(overlay);

    let tracker = null;
    let enabled = false;

    async function enable() {
        if (enabled) return;
        tracker = new HandTracker(video, overlay, {
            onRotate: (dTheta, dPhi) => avatar?.rotate?.(dTheta, dPhi),
            onZoom: (factor) => avatar?.zoom?.(factor),
            onStatus: (s) => opts.onStatus?.(s)
        }, opts.assets);
        try {
            await tracker.start();
            enabled = true;
            el.style.display = "block";
        } catch (e) {
            tracker = null;
            opts.onStatus?.({ hands: 0, mode: "idle", error: e?.message || "kamera gagal" });
            throw e;
        }
    }

    function disable() {
        if (!enabled && !tracker) return;
        tracker?.stop();
        tracker = null;
        enabled = false;
        el.style.display = "none";
        avatar?.resetView?.();
    }

    async function toggle() { return enabled ? disable() : enable(); }

    // Tombol "G" — sama seperti Ultron asli.
    function onKey(e) {
        if (e.key === "g" || e.key === "G") {
            if (/input|textarea/i.test(e.target?.tagName || "")) return;   // jangan ganggu ketik
            toggle().catch(() => {});
        }
    }
    window.addEventListener("keydown", onKey);

    function destroy() {
        window.removeEventListener("keydown", onKey);
        disable();
        el.remove();
    }

    return { el, toggle, enable, disable, get enabled() { return enabled; }, destroy };
}
