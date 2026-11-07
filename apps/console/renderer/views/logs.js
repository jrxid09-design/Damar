import { store } from "../lib/store.js";
import { icon } from "../lib/icons.js";
import { esc, clockTime, toast } from "../lib/ui.js";

let host = null;
let autoScroll = true;
let filterLevel = "";
let filterText = "";
let unsubscribe = null;

export const logs = {

    id: "logs",
    label: "Logs",
    icon: "terminal",
    title: "Logs",
    subtitle: "Aliran kejadian daemon secara realtime.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Logs</h1>
                    <p>Aliran kejadian daemon secara realtime.</p>
                </div>
                <div class="actions">
                    <input type="text" id="log-search" placeholder="Filter teks…" style="width:180px">
                    <select id="log-level" style="width:130px">
                        <option value="">Semua level</option>
                        <option value="info">Info</option>
                        <option value="warn">Warn</option>
                        <option value="error">Error</option>
                        <option value="event">Event</option>
                    </select>
                    <label class="switch">
                        <input type="checkbox" id="log-follow" checked>
                        <span class="track"></span>
                        <span class="small">Ikuti</span>
                    </label>
                    <button class="btn ghost sm" id="log-clear">${icon("trash")} Bersihkan</button>
                </div>
            </div>

            <div class="panel flush">
                <div class="log-view" id="log-view"></div>
            </div>`;

        host = root.querySelector("#log-view");

        draw();

    },

    mount(root) {

        const search = root.querySelector("#log-search");
        const level = root.querySelector("#log-level");
        const follow = root.querySelector("#log-follow");

        search.value = filterText;
        level.value = filterLevel;
        follow.checked = autoScroll;

        search.addEventListener("input", () => {
            filterText = search.value.trim().toLowerCase();
            draw();
        });

        level.addEventListener("change", () => {
            filterLevel = level.value;
            draw();
        });

        follow.addEventListener("change", () => {
            autoScroll = follow.checked;
        });

        root.querySelector("#log-clear").addEventListener("click", () => {
            store.get().logs.length = 0;
            draw();
            toast("Log dibersihkan", "ok");
        });

        // Entri baru ditambahkan satu per satu; menggambar ulang
        // seluruh daftar tiap baris akan berat di sesi panjang.
        unsubscribe = store.on("log", event => append(event.detail));

    },

    unmount() {

        unsubscribe?.();
        unsubscribe = null;
        host = null;

    }

};

function matches(entry) {

    if (filterLevel && entry.level !== filterLevel) {
        return false;
    }

    if (filterText && !String(entry.message ?? "").toLowerCase().includes(filterText)) {
        return false;
    }

    return true;

}

function lineHtml(entry) {

    return `<div class="log-line ${esc(entry.level ?? "info")}">
        <span class="t">${clockTime(entry.time)}</span>
        <span class="lvl">${esc(entry.level ?? "info")}</span>
        <span class="m">${esc(entry.message)}</span>
    </div>`;

}

function draw() {

    if (!host) {
        return;
    }

    const entries = store.get().logs.filter(matches);

    host.innerHTML = entries.length
        ? entries.map(lineHtml).join("")
        : `<div class="empty">${icon("terminal")}<div>Belum ada log yang cocok.</div></div>`;

    scrollToEnd();

}

function append(entry) {

    if (!host || !matches(entry)) {
        return;
    }

    // Buang placeholder "belum ada log" sebelum menambah baris.
    if (host.querySelector(".empty")) {
        host.innerHTML = "";
    }

    host.insertAdjacentHTML("beforeend", lineHtml(entry));

    while (host.childElementCount > 1200) {
        host.firstElementChild.remove();
    }

    scrollToEnd();

}

function scrollToEnd() {

    if (host && autoScroll) {
        host.scrollTop = host.scrollHeight;
    }

}
