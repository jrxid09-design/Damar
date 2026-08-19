import { icon } from "../lib/icons.js";
import { aether as voiceView } from "./aether.js";
import { chat as chatView } from "./chat.js";

/**
 * Aether — satu layar untuk berinteraksi langsung dengan Aether,
 * lewat suara (avatar minibot 3D + mic/TTS) maupun teks (chat).
 *
 * Menggabungkan dua view lama (Aether + Chat) jadi satu navigasi
 * dengan tab, memakai ulang render/mount masing-masing. Keduanya
 * berbagi otak & model yang sama; selektor "AI Lokal / AI Provider"
 * ada di tab Chat.
 */

const SUB = {
    voice: voiceView,
    chat: chatView
};

let activeTab = "voice";

let mountedSub = null;

export const companion = {

    id: "aether",
    label: "Aether",
    icon: "orb",
    title: "Aether",
    subtitle: "Bicara dengan Aether — lewat suara atau teks.",

    render(root) {

        root.innerHTML = `
            <style>
                /* Sub-view punya judulnya sendiri; sembunyikan agar tak dobel,
                   tapi sisakan tombol aksi di kanan (selektor AI, dsb). */
                #companion-host .view-head h1,
                #companion-host .view-head p { display: none; }
                #companion-host .view-head { margin-top: 0; }
                #companion-host > .view { display: block; }
            </style>

            <div class="view-head">
                <div>
                    <h1>Aether</h1>
                    <p>Bicara dengan Aether — lewat suara (avatar) atau teks.</p>
                </div>
                <div class="actions">
                    <div class="seg" id="companion-tabs" style="margin:0">
                        <button type="button" data-ctab="voice" class="${activeTab === "voice" ? "active" : ""}">
                            ${icon("orb")} Suara &amp; Avatar</button>
                        <button type="button" data-ctab="chat" class="${activeTab === "chat" ? "active" : ""}">
                            ${icon("chat")} Chat teks</button>
                    </div>
                </div>
            </div>

            <div id="companion-host"></div>`;

    },

    async mount(root) {

        const host = root.querySelector("#companion-host");

        const openTab = async (id) => {

            activeTab = id;

            root.querySelectorAll("[data-ctab]").forEach(button =>
                button.classList.toggle("active", button.dataset.ctab === id));

            mountedSub?.unmount?.();

            host.innerHTML = "";

            const sub = SUB[id];

            sub.render(host);
            await sub.mount?.(host);

            mountedSub = sub;

        };

        root.querySelectorAll("[data-ctab]").forEach(button =>
            button.addEventListener("click", () => openTab(button.dataset.ctab)));

        await openTab(activeTab);

    },

    unmount() {

        mountedSub?.unmount?.();
        mountedSub = null;

    }

};
