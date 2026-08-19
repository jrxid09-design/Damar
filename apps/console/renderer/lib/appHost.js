import { icon } from "./icons.js";
import { esc } from "./ui.js";

/**
 * appHost — menyatukan beberapa view lama jadi SATU aplikasi bertab.
 *
 * Tidak menduplikasi logika: tiap tab memanggil render()/mount()/unmount()
 * view aslinya ke panel-nya sendiri. Hanya tab AKTIF yang di-mount (hemat
 * sumber daya: stream kamera/SSE view non-aktif dilepas). Menghasilkan objek
 * ber-interface view standar (render/mount/unmount) + meta app (id/label/icon).
 */
export function createApp({ id, label, icon: appIcon, subtitle = "", tabs, onBack }) {

    let root = null;
    let active = null;
    let mounted = null;

    function select(tabId, body, tabsEl) {
        if (active === tabId) return;
        mounted?.unmount?.();
        active = tabId;

        tabsEl.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === tabId));

        const tab = tabs.find(t => t.id === tabId);
        body.innerHTML = "";
        const panel = document.createElement("div");
        panel.className = "apphost-panel";
        panel.style.height = "100%";
        body.appendChild(panel);

        tab.view.render(panel);
        tab.view.mount?.(panel);
        mounted = tab.view;
    }

    function render(el) {
        root = el;
        el.innerHTML = `
            <div class="app-head">
                <button class="back" data-back title="Kembali ke Beranda">${icon("chevron-left") || "‹"}</button>
                <div class="title">${esc(label)}${subtitle ? `<small>${esc(subtitle)}</small>` : ""}</div>
            </div>
            <div class="apphost">
                <div class="apphost-tabs">
                    ${tabs.map(t => `<button class="apphost-tab" data-tab="${esc(t.id)}">${icon(t.icon)}<span>${esc(t.label)}</span></button>`).join("")}
                </div>
                <div class="apphost-body"></div>
            </div>`;

        const body = el.querySelector(".apphost-body");
        const tabsEl = el.querySelector(".apphost-tabs");
        tabsEl.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => select(b.dataset.tab, body, tabsEl)));
        el.querySelector("[data-back]")?.addEventListener("click", () => onBack?.());

        active = null;
        select(tabs[0].id, body, tabsEl);
    }

    function unmount() {
        mounted?.unmount?.();
        mounted = null;
        active = null;
    }

    return { id, label, icon: appIcon, render, unmount };
}
