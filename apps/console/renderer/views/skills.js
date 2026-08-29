import { icon } from "../lib/icons.js";
import { plugins } from "./plugins.js";
import { studio } from "./studio.js";

/**
 * Skills & Studio — satu layar untuk seluruh "skill" (kemampuan)
 * Damar: yang terpasang & bisa dipanggil, draft buatan Damar yang
 * menunggu persetujuan, dan editor untuk membuat/mengubah sendiri.
 *
 * Menggabungkan dua view lama (Plugins & Tools + Studio) lewat tab,
 * dengan memakai ulang render/mount masing-masing.
 */

const SUB = {
    installed: plugins,
    studio
};

let activeTab = "installed";

let mountedSub = null;

export const skills = {

    id: "skills",
    label: "Skills & Studio",
    icon: "tool",
    title: "Skills & Studio",
    subtitle: "Kemampuan Damar — terpasang, draft, dan editor.",

    render(root) {

        root.innerHTML = `
            <style>
                /* Sembunyikan judul ganda dari sub-view, sisakan tombol aksinya. */
                #skills-host .view-head h1,
                #skills-host .view-head p { display: none; }
                #skills-host .view-head { margin-top: 0; }
            </style>

            <div class="view-head">
                <div>
                    <h1>Skills &amp; Studio</h1>
                    <p>Kemampuan (skill) Damar — yang terpasang, draft menunggu
                       persetujuan, dan editor untuk membuatnya sendiri.</p>
                </div>
            </div>

            <div class="tabs" id="skills-tabs">
                <button class="tab ${activeTab === "installed" ? "active" : ""}" data-stab="installed">
                    ${icon("box")} Terpasang</button>
                <button class="tab ${activeTab === "studio" ? "active" : ""}" data-stab="studio">
                    ${icon("tool")} Studio &amp; Draft</button>
            </div>

            <div id="skills-host"></div>`;

    },

    async mount(root) {

        const host = root.querySelector("#skills-host");

        const openTab = async (id) => {

            activeTab = id;

            root.querySelectorAll("[data-stab]").forEach(button =>
                button.classList.toggle("active", button.dataset.stab === id));

            // Lepas sub-view sebelumnya (stream/listener) sebelum ganti.
            mountedSub?.unmount?.();

            host.innerHTML = "";

            const sub = SUB[id];

            sub.render(host);
            await sub.mount?.(host);

            mountedSub = sub;

        };

        root.querySelectorAll("[data-stab]").forEach(button =>
            button.addEventListener("click", () => openTab(button.dataset.stab)));

        await openTab(activeTab);

    },

    unmount() {

        mountedSub?.unmount?.();
        mountedSub = null;

    }

};
