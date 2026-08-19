import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, relativeTime, toast } from "../lib/ui.js";

export const integrations = {

    id: "integrations",
    label: "Integrations",
    icon: "link",
    title: "Integrations",
    subtitle: "OpenClaw, hermes-agent, dan runtime AI lokal.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Integrations</h1>
                    <p>OpenClaw, hermes-agent, dan runtime AI lokal.</p>
                </div>
                <div class="actions">
                    <button class="btn ghost sm" id="int-refresh">${icon("refresh")} Periksa semua</button>
                </div>
            </div>
            <div id="int-body" class="stack">
                <div class="row"><span class="spinner"></span><span class="small muted">Memuat…</span></div>
            </div>`;

    },

    async mount(root) {

        const body = root.querySelector("#int-body");

        const load = async (recheck = false) => {

            try {

                const data = recheck
                    ? await api.checkIntegrations()
                    : await api.integrations();

                body.innerHTML = `
                    <div class="grid auto">
                        ${data.integrations.map(card).join("")}
                    </div>
                    <div class="panel">
                        <div class="panel-head"><h2>Catatan penyambungan</h2></div>
                        ${notes()}
                    </div>`;

                wire(body, load);

            }

            catch (error) {

                body.innerHTML = `<div class="panel"><div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div></div>`;

            }

        };

        root.querySelector("#int-refresh").addEventListener("click", async () => {
            await load(true);
            toast("Semua integrasi diperiksa", "ok");
        });

        await load();

    }

};

function card(item) {

    const status = item.status ?? {};

    const online = status.online === true;

    const tone = !item.enabled ? "idle" : (online ? "ok" : "danger");

    const label = !item.enabled ? "Nonaktif" : (online ? "Online" : "Offline");

    return `
        <div class="panel" data-integration="${esc(item.id)}">

            <div class="panel-head">
                <h2>${esc(item.label)}</h2>
                <span class="push">${pill(label, tone)}</span>
            </div>

            <div class="stack" style="gap:9px">

                <div class="field">
                    <label>Base URL</label>
                    <input type="url" data-field="baseUrl" value="${esc(item.baseUrl ?? "")}"
                        placeholder="http://192.168.1.10:11434">
                </div>

                <div class="row" style="gap:14px">
                    <label class="switch">
                        <input type="checkbox" data-field="enabled" ${item.enabled ? "checked" : ""}>
                        <span class="track"></span>
                        <span>Aktif</span>
                    </label>
                    <span class="tag">${esc(item.kind)}</span>
                </div>

                <div class="divider" style="margin:4px 0"></div>

                <div class="row"><span class="small dim">Latensi</span>
                    <span class="small mono push">${status.latency != null ? `${status.latency} ms` : "—"}</span></div>

                <div class="row"><span class="small dim">Diperiksa</span>
                    <span class="small mono push">${relativeTime(status.checkedAt)}</span></div>

                ${status.detail?.healthPath
                    ? `<div class="row"><span class="small dim">Health path</span>
                        <span class="small mono push">${esc(status.detail.healthPath)}</span></div>`
                    : ""}

                ${status.detail?.modelCount != null
                    ? `<div class="row"><span class="small dim">Model</span>
                        <span class="small mono push">${status.detail.modelCount} (${status.detail.loadedCount ?? 0} dimuat)</span></div>`
                    : ""}

                ${status.error
                    ? `<div class="small danger-text selectable" style="margin-top:4px">${esc(status.error)}</div>`
                    : ""}

                ${status.detail?.triedPaths
                    ? `<div class="small dim selectable">dicoba: ${esc(status.detail.triedPaths.join(", "))}</div>`
                    : ""}

                <div class="row" style="margin-top:6px">
                    <button class="btn sm" data-action="save">${icon("check")} Terapkan</button>
                    <button class="btn sm ghost" data-action="check">${icon("refresh")} Periksa</button>
                </div>

            </div>
        </div>`;

}

function wire(scope, reload) {

    scope.querySelectorAll("[data-integration]").forEach(panel => {

        const id = panel.dataset.integration;

        panel.querySelector('[data-action="check"]').addEventListener("click", async () => {

            try {
                await api.checkIntegration(id);
                await reload();
            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

        panel.querySelector('[data-action="save"]').addEventListener("click", async () => {

            try {

                await api.updateIntegration(id, {
                    baseUrl: panel.querySelector('[data-field="baseUrl"]').value.trim(),
                    enabled: panel.querySelector('[data-field="enabled"]').checked
                });

                toast(`${id} diperbarui (sementara)`, "ok");

                await reload();

            }

            catch (error) {
                toast(error.message, "danger");
            }

        });

    });

}

function notes() {

    return `
        <div class="stack small muted" style="gap:8px">

            <p style="margin:0">
                Perubahan di halaman ini hanya berlaku selama daemon berjalan.
                Untuk permanen, sunting
                <span class="mono selectable">configs/integrations.json</span>
                di mesin tempat daemon dijalankan, atau set environment variable
                <span class="mono selectable">AETHER_&lt;ID&gt;_URL</span>.
            </p>

            <p style="margin:0">
                Base URL untuk <strong>OpenClaw</strong> dan <strong>Hermes Agent</strong>
                masih berupa default yang wajar, bukan hasil verifikasi ke instance
                sungguhan. Aether mencoba beberapa kandidat health path lalu
                menampilkan yang berhasil pada kartu di atas — salin nilai itu ke
                <span class="mono selectable">paths.health</span> agar tidak menebak lagi.
            </p>

            <p style="margin:0">
                Saat daemon berpindah ke PC rumah, ganti
                <span class="mono selectable">localhost</span>
                pada Ollama dengan IP LAN PC tersebut agar bisa dipantau dari laptop.
            </p>

        </div>`;

}
