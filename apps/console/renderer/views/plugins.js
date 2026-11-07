import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, toast } from "../lib/ui.js";

export const plugins = {

    id: "plugins",
    label: "Plugins & Tools",
    icon: "tool",
    title: "Plugins & Tools",
    subtitle: "Kemampuan yang bisa dipanggil model maupun dijalankan manual.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Plugins &amp; Tools</h1>
                    <p>Kemampuan yang bisa dipanggil model maupun dijalankan manual.</p>
                </div>
                <div class="actions">
                    <input type="text" id="tool-search" placeholder="Cari tool…" style="width:200px">
                    <button class="btn ghost sm" id="tool-refresh">${icon("refresh")} Muat ulang</button>
                </div>
            </div>

            <div class="stack">
                <div id="plugin-cards" class="grid auto"></div>
                <div class="panel flush">
                    <div class="panel-head" style="padding:16px 18px 0"><h2>Tool terdaftar</h2></div>
                    <div id="tool-list" style="padding:12px 0 0"></div>
                </div>
                <div class="panel" id="runner"></div>
            </div>`;

    },

    async mount(root) {

        const search = root.querySelector("#tool-search");

        let tools = [];

        const load = async () => {

            try {

                const [pluginData, toolData] = await Promise.all([
                    api.plugins(),
                    api.tools()
                ]);

                tools = toolData.tools;

                root.querySelector("#plugin-cards").innerHTML =
                    pluginData.plugins.map(pluginCard).join("");

                drawTools();

            }

            catch (error) {

                root.querySelector("#plugin-cards").innerHTML =
                    `<div class="panel"><div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div></div>`;

            }

        };

        const drawTools = () => {

            const query = search.value.trim().toLowerCase();

            const filtered = query
                ? tools.filter(tool =>
                    tool.id.toLowerCase().includes(query) ||
                    tool.description.toLowerCase().includes(query))
                : tools;

            const host = root.querySelector("#tool-list");

            if (filtered.length === 0) {

                host.innerHTML = `<div class="empty">${icon("tool")}<div>Tidak ada tool cocok.</div></div>`;

                return;

            }

            host.innerHTML = filtered.map(tool => `
                <div class="list-item">
                    <div style="min-width:0;flex:1">
                        <div class="title mono">${esc(tool.id)}</div>
                        <div class="sub">${esc(tool.description || "tanpa deskripsi")}</div>
                    </div>
                    <span class="tag">${Object.keys(tool.parameters ?? {}).length} param</span>
                    <button class="btn sm" data-run="${esc(tool.id)}">${icon("play")} Jalankan</button>
                </div>`).join("");

            host.querySelectorAll("[data-run]").forEach(button => {

                button.addEventListener("click", () => {

                    openRunner(
                        root,
                        tools.find(tool => tool.id === button.dataset.run)
                    );

                });

            });

        };

        search.addEventListener("input", drawTools);

        root.querySelector("#tool-refresh").addEventListener("click", load);

        closeRunner(root);

        await load();

    }

};

function pluginCard(plugin) {

    const empty = plugin.toolCount === 0;

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${esc(plugin.name)}</h2>
                <span class="push">${pill(
                    empty ? "scaffold" : `${plugin.toolCount} tool`,
                    empty ? "idle" : "ok"
                )}</span>
            </div>
            <div class="small muted" style="min-height:34px">${esc(plugin.description || "—")}</div>
            <div class="divider" style="margin:10px 0"></div>
            <div class="row wrap" style="gap:6px">
                <span class="tag mono">${esc(plugin.id)}</span>
                <span class="tag">v${esc(plugin.version)}</span>
                <span class="tag">${esc(plugin.category)}</span>
                ${(plugin.permissions ?? []).map(p => `<span class="tag warn-text">${esc(p)}</span>`).join("")}
            </div>
        </div>`;

}

/**
 * Panel eksekusi manual. Argumen ditulis sebagai JSON karena
 * skema tiap tool berbeda-beda; contoh diisikan otomatis dari
 * daftar parameter agar tidak perlu menebak bentuknya.
 */
function openRunner(root, tool) {

    if (!tool) {
        return;
    }

    const sample = Object.fromEntries(
        Object.entries(tool.parameters ?? {}).map(([key, spec]) => [
            key,
            spec?.enum?.[0] ?? (spec?.type === "number" ? 0 : "")
        ])
    );

    const runner = root.querySelector("#runner");

    runner.style.display = "";

    runner.innerHTML = `
        <div class="panel-head">
            <h2>Jalankan <span class="mono">${esc(tool.id)}</span></h2>
            <button class="btn ghost sm push" id="runner-close">${icon("x")} Tutup</button>
        </div>

        <div class="small muted" style="margin-bottom:10px">${esc(tool.description || "—")}</div>

        <div class="grid cols-2">
            <div class="field">
                <label>Argumen (JSON)</label>
                <textarea id="runner-args" rows="7">${esc(JSON.stringify(sample, null, 2))}</textarea>
            </div>
            <div class="field">
                <label>Hasil</label>
                <textarea id="runner-out" rows="7" readonly placeholder="hasil eksekusi tampil di sini"></textarea>
            </div>
        </div>

        <div class="row" style="margin-top:10px">
            <button class="btn primary sm" id="runner-run">${icon("play")} Eksekusi</button>
            <span class="small dim" id="runner-note"></span>
        </div>`;

    runner.querySelector("#runner-close")
        .addEventListener("click", () => closeRunner(root));

    runner.querySelector("#runner-run").addEventListener("click", async () => {

        const output = runner.querySelector("#runner-out");
        const note = runner.querySelector("#runner-note");

        let args;

        try {
            args = JSON.parse(runner.querySelector("#runner-args").value || "{}");
        }
        catch (error) {
            toast(`JSON tidak valid: ${error.message}`, "warn");
            return;
        }

        note.textContent = "menjalankan…";
        output.value = "";

        try {

            const result = await api.runTool(tool.id, args);

            output.value = JSON.stringify(result.result, null, 2);

            note.textContent = `selesai dalam ${result.duration} ms`;

        }

        catch (error) {

            output.value = error.message;

            note.textContent = "gagal";

            toast(error.message, "danger");

        }

    });

    runner.scrollIntoView({ behavior: "smooth", block: "nearest" });

}

function closeRunner(root) {

    const runner = root.querySelector("#runner");

    runner.innerHTML = "";

    runner.style.display = "none";

}
