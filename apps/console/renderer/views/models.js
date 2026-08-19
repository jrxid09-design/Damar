import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, bytes, relativeTime, pill, toast } from "../lib/ui.js";
import { aiChoices } from "../lib/aiselect.js";

export const models = {

    id: "models",
    label: "Models",
    icon: "cpu",
    title: "Models",
    subtitle: "Model yang tersedia pada AI yang dipakai Aether.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Models</h1>
                    <p>Model yang tersedia pada AI yang sedang dipakai Aether.</p>
                </div>
                <div class="actions">
                    <div class="seg" id="model-mode" style="margin:0"></div>
                    <button class="btn ghost sm" id="model-refresh">${icon("refresh")} Muat ulang</button>
                </div>
            </div>

            <div class="panel">
                <div class="panel-head"><h2>${icon("activity")} Pemakaian AI Harian</h2>
                    <span class="hint push" id="usage-sum">—</span></div>
                <div id="usage-body"><div class="row"><span class="spinner"></span><span class="small muted">Memuat pemakaian…</span></div></div>
            </div>

            <div class="panel flush" style="margin-top:14px">
                <div id="model-body" style="padding:16px">
                    <div class="row"><span class="spinner"></span><span class="small muted">Memuat model…</span></div>
                </div>
            </div>`;

    },

    async mount(root) {

        const seg = root.querySelector("#model-mode");
        const body = root.querySelector("#model-body");

        // Selektor "AI Lokal / AI Provider" — ganti otak Aether langsung.
        await aiChoices.render(seg, () => load());

        const load = async () => {

            body.innerHTML = `<div class="row"><span class="spinner"></span><span class="small muted">Memuat model…</span></div>`;

            try {

                const data = await api.models();

                body.innerHTML = table(data);

                body.querySelectorAll("[data-set-model]").forEach(button => {

                    button.addEventListener("click", async () => {

                        try {
                            await api.selectModel(button.dataset.setModel);
                            toast(`Model default: ${button.dataset.setModel}`, "ok");
                            load();
                        }
                        catch (error) {
                            toast(error.message, "danger");
                        }

                    });

                });

            }

            catch (error) {

                body.innerHTML = `<div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div>`;

            }

        };

        root.querySelector("#model-refresh").addEventListener("click", () => { load(); loadUsage(root); });

        await load();
        loadUsage(root);

    }

};

async function loadUsage(root) {
    const body = root.querySelector("#usage-body");
    const sum = root.querySelector("#usage-sum");
    if (!body) return;
    try {
        const u = await api.aiUsage(14);
        const hist = u.history ?? [];
        const today = u.today ?? {};
        const provs = Object.entries(today);
        const reqToday = provs.reduce((a, [, p]) => a + (p.requests || 0), 0);
        if (sum) sum.textContent = `${reqToday} request hari ini`;

        body.innerHTML = `
            ${usageBars(hist)}
            <div class="divider"></div>
            ${provs.length
                ? `<div class="scroll-x"><table class="table">
                    <thead><tr><th>Provider</th><th>Request</th><th>Token</th><th>Status</th></tr></thead>
                    <tbody>${provs.map(([name, p]) => `<tr>
                        <td>${esc(name)}</td>
                        <td class="mono small">${p.requests || 0}</td>
                        <td class="mono small">${(p.promptTokens || 0) + (p.completionTokens || 0)}</td>
                        <td>${p.limited ? pill("limit habis", "danger") : (p.warned ? pill("mendekati", "warn") : pill("ok", "ok"))}</td>
                    </tr>`).join("")}</tbody></table></div>`
                : `<div class="small dim">Belum ada pemakaian hari ini.</div>`}`;
    }
    catch (error) {
        body.innerHTML = `<div class="small dim">Pemakaian tak tersedia: ${esc(error.message)}</div>`;
    }
}

/**
 * Graf area bertumpuk gaya Grafana: sumbu Y grid, dua seri
 * (request garis + token area), tooltip hover, sumbu X tanggal.
 */
function usageBars(hist) {
    if (!hist.length) return `<div class="small dim">Belum ada data.</div>`;

    const id = "usage-chart-" + Math.random().toString(36).slice(2, 7);

    requestAnimationFrame(() => drawUsageChart(id, hist));

    // Dua seri dengan skala berbeda tidak terbaca tanpa keterangan —
    // legenda di sini bukan hiasan, ia yang membuat grafiknya jujur.
    return `<canvas id="${id}" class="usage-chart"></canvas>
        <div class="usage-legend">
            <span><i style="background:#00DFFF"></i>Request (sumbu kiri)</span>
            <span><i style="background:#7C5CFF"></i>Token (area)</span>
            <span class="push">${hist.length} hari terakhir</span>
        </div>`;
}

function drawUsageChart(id, hist) {

    const cv = document.getElementById(id);
    if (!cv) return;

    const W = cv.parentElement.clientWidth || 640;
    const H = 190;
    cv.width = W * devicePixelRatio;
    cv.height = H * devicePixelRatio;
    cv.style.width = "100%";
    cv.style.height = H + "px";

    const ctx = cv.getContext("2d");
    ctx.scale(devicePixelRatio, devicePixelRatio);

    const pad = { l: 42, r: 14, t: 14, b: 26 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    const maxReq = Math.max(4, ...hist.map(d => d.totalRequests ?? 0));
    const maxTok = Math.max(1000, ...hist.map(d => d.totalTokens ?? 0));
    const niceMax = y => Math.ceil(y / 5) * 5 || 5;

    const x = i => pad.l + (hist.length === 1 ? iw / 2 : (i / (hist.length - 1)) * iw);
    const yReq = v => pad.t + ih - (v / niceMax(maxReq)) * ih;
    const yTok = v => pad.t + ih - (v / maxTok) * ih;

    let hoverI = -1;

    function draw() {

        ctx.clearRect(0, 0, W, H);

        // --- grid + sumbu Y (kiri request, kanan token) ---
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "right";
        for (let g = 0; g <= 4; g++) {
            const gy = pad.t + (ih / 4) * g;
            ctx.strokeStyle = "rgba(115, 237, 255, 0.08)";
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
            const val = Math.round(niceMax(maxReq) * (1 - g / 4));
            ctx.fillStyle = "rgba(120, 144, 163, 0.85)";
            ctx.fillText(String(val), pad.l - 8, gy + 3);
        }

        // --- sumbu X ---
        ctx.textAlign = "center";
        hist.forEach((d, i) => {
            if (hist.length > 10 && i % 2) return;
            ctx.fillStyle = "rgba(120, 144, 163, 0.7)";
            ctx.fillText(String(d.date ?? "").slice(5), x(i), H - 8);
        });

        // --- area token (violet, di belakang) ---
        const tokGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
        tokGrad.addColorStop(0, "rgba(124, 92, 255, 0.28)");
        tokGrad.addColorStop(1, "rgba(124, 92, 255, 0.02)");
        ctx.beginPath();
        hist.forEach((d, i) => i === 0 ? ctx.moveTo(x(i), yTok(d.totalTokens ?? 0)) : ctx.lineTo(x(i), yTok(d.totalTokens ?? 0)));
        ctx.lineTo(x(hist.length - 1), pad.t + ih);
        ctx.lineTo(x(0), pad.t + ih);
        ctx.closePath();
        ctx.fillStyle = tokGrad;
        ctx.fill();
        ctx.strokeStyle = "rgba(163, 139, 255, 0.5)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        hist.forEach((d, i) => i === 0 ? ctx.moveTo(x(i), yTok(d.totalTokens ?? 0)) : ctx.lineTo(x(i), yTok(d.totalTokens ?? 0)));
        ctx.stroke();

        // --- garis request (cyan, depan) dengan glow ---
        ctx.beginPath();
        hist.forEach((d, i) => i === 0 ? ctx.moveTo(x(i), yReq(d.totalRequests ?? 0)) : ctx.lineTo(x(i), yReq(d.totalRequests ?? 0)));
        ctx.strokeStyle = "#00DFFF";
        ctx.lineWidth = 2;
        ctx.shadowColor = "rgba(0, 223, 255, 0.55)";
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // titik data
        hist.forEach((d, i) => {
            ctx.beginPath();
            ctx.arc(x(i), yReq(d.totalRequests ?? 0), i === hoverI ? 4.5 : 2.4, 0, Math.PI * 2);
            ctx.fillStyle = i === hoverI ? "#FFFFFF" : "#73EDFF";
            ctx.fill();
        });

        // --- hover crosshair + tooltip ---
        if (hoverI >= 0) {
            const d = hist[hoverI];
            const hx = x(hoverI);
            ctx.strokeStyle = "rgba(0, 223, 255, 0.35)";
            ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, pad.t + ih); ctx.stroke();
            ctx.setLineDash([]);

            const label = `${d.date} · ${d.totalRequests} req · ${d.totalTokens} tok`;
            ctx.font = "11px ui-monospace, monospace";
            const tw = ctx.measureText(label).width + 16;
            const tx = Math.min(Math.max(hx - tw / 2, 4), W - tw - 4);
            ctx.fillStyle = "rgba(8, 13, 22, 0.92)";
            ctx.strokeStyle = "rgba(0, 223, 255, 0.4)";
            ctx.beginPath();
            ctx.roundRect(tx, 4, tw, 22, 5);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = "#D8E7F2";
            ctx.textAlign = "center";
            ctx.fillText(label, tx + tw / 2, 19);
        }
    }

    cv.addEventListener("pointermove", e => {
        const rect = cv.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let best = -1, bd = 1e9;
        hist.forEach((_, i) => { const d = Math.abs(x(i) - mx); if (d < bd) { bd = d; best = i; } });
        if (best !== hoverI) { hoverI = best; draw(); }
    });
    cv.addEventListener("pointerleave", () => { hoverI = -1; draw(); });

    draw();
}

function table(data) {

    const list = data.models ?? [];

    if (list.length === 0) {

        return `<div class="empty">
            ${icon("cpu")}
            <div style="font-size:14px;color:var(--text)">Tidak ada model</div>
            <div>Untuk Ollama, unduh dulu lewat <span class="mono">ollama pull &lt;model&gt;</span> di mesin tempat Ollama berjalan.</div>
        </div>`;

    }

    // Kolom yang ditampilkan menyesuaikan provider: Ollama punya
    // ukuran & kuantisasi, OpenRouter punya panjang konteks.
    const isLocal = list.some(model => model.size != null);

    return `<div class="scroll-x"><table class="table">
        <thead>
            <tr>
                <th>Model</th>
                ${isLocal
                    ? `<th>Keluarga</th><th>Parameter</th><th>Kuantisasi</th><th>Ukuran</th><th>Diperbarui</th>`
                    : `<th>Konteks</th><th>Harga prompt</th><th>Harga output</th>`}
                <th style="width:1%"></th>
            </tr>
        </thead>
        <tbody>
            ${list.map(model => {

                const isDefault = model.id === data.defaultModel;

                return `<tr>
                    <td>
                        <div class="row" style="gap:8px">
                            <span class="mono">${esc(model.name ?? model.id)}</span>
                            ${model.status === "verified" ? pill("✓ verified", "ok") : ""}
                            ${model.tier && model.tier !== "stable" ? pill(model.tier, "warn") : ""}
                            ${model.free ? pill("free", "ok") : ""}
                            ${isDefault ? pill("default", "ok") : ""}
                        </div>
                    </td>
                    ${isLocal
                        ? `<td class="small muted">${esc(model.family ?? "—")}</td>
                           <td class="small mono">${esc(model.parameterSize ?? "—")}</td>
                           <td class="small mono">${esc(model.quantization ?? "—")}</td>
                           <td class="small mono">${bytes(model.size)}</td>
                           <td class="small dim">${relativeTime(model.modifiedAt)}</td>`
                        : `<td class="small mono">${model.contextLength ? Number(model.contextLength).toLocaleString("id-ID") : "—"}</td>
                           <td class="small mono">${esc(model.pricing?.prompt ?? "—")}</td>
                           <td class="small mono">${esc(model.pricing?.completion ?? "—")}</td>`}
                    <td>
                        <button class="btn sm ghost" data-set-model="${esc(model.id)}" ${isDefault ? "disabled" : ""}>
                            ${isDefault ? "Aktif" : "Jadikan default"}
                        </button>
                    </td>
                </tr>`;

            }).join("")}
        </tbody>
    </table></div>`;

}
