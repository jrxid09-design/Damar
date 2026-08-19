import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, toast } from "../lib/ui.js";

/**
 * Vision — Aether melihat kamera/CCTV & webcam.
 *
 * Tiga bagian: model vision (mis. llava di Ollama), analisis
 * langsung dari webcam (tangkap frame → analisis), dan kelola
 * kamera/CCTV lewat URL snapshot.
 */

let stream = null;

/** Pratinjau live kamera: timer refresh + object URL agar bisa dibersihkan. */
const liveCams = new Map();   // id → { timer, url }

function stopLive(id) {
    const live = liveCams.get(id);
    if (!live) return;
    clearInterval(live.timer);
    if (live.url) URL.revokeObjectURL(live.url);
    liveCams.delete(id);
}

function stopAllLive() {
    for (const id of [...liveCams.keys()]) stopLive(id);
}

export const vision = {

    id: "vision",
    label: "Vision",
    icon: "camera",
    title: "Vision",
    subtitle: "Aether melihat — analisis kamera, CCTV, dan webcam.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Vision</h1>
                    <p>Aether melihat — analisis kamera, CCTV, dan webcam.</p>
                </div>
            </div>

            <div class="stack">
                <div class="panel" id="vis-model"></div>

                <div class="grid cols-2">
                    <div class="panel">
                        <div class="panel-head"><h2>${icon("camera")} Webcam</h2></div>
                        <div class="video-frame" id="vis-frame">
                            <div class="placeholder">Tekan "Nyalakan" untuk pratinjau,<br>lalu "Analisis" agar Aether melihat.</div>
                        </div>
                        <div class="row" style="margin-top:10px">
                            <button class="btn sm" id="vis-cam-on">${icon("play")} Nyalakan</button>
                            <button class="btn sm ghost" id="vis-cam-off">${icon("stop")} Matikan</button>
                            <button class="btn primary sm" id="vis-analyze">${icon("orb")} Analisis</button>
                        </div>
                        <input type="text" id="vis-prompt" placeholder="pertanyaan (opsional), mis. ada berapa orang?" style="margin-top:8px">
                        <div id="vis-result" class="quote" style="margin-top:10px;display:none"></div>
                    </div>

                    <div class="panel flush">
                        <div class="panel-head" style="padding:16px 18px 0">
                            <h2>${icon("camera")} Kamera / CCTV</h2>
                        </div>
                        <div id="vis-cameras" style="padding:10px 0 0"></div>
                        <div style="padding:0 16px 16px">
                            <div class="divider"></div>
                            <div class="grid cols-3" style="gap:8px;align-items:end">
                                <div class="field"><label>Id</label><input type="text" id="cam-id" placeholder="dapur"></div>
                                <div class="field"><label>Label</label><input type="text" id="cam-label" placeholder="Dapur"></div>
                                <div class="field"><label>URL snapshot</label><input type="url" id="cam-url" placeholder="http://.../snapshot.jpg"></div>
                            </div>
                            <button class="btn primary sm" id="cam-add" style="margin-top:8px">${icon("plus")} Tambah kamera</button>
                            <div class="small dim" style="margin-top:10px">
                                ${icon("chat")} Terhubung ke Chat: minta Aether
                                <em>"lihat kamera dapur"</em> — ia otomatis memakai kamera ini.
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;

    },

    async mount(root) {

        await drawModel(root);
        await drawCameras(root);

        root.querySelector("#vis-cam-on").addEventListener("click", () => startCam(root));
        root.querySelector("#vis-cam-off").addEventListener("click", () => stopCam(root));
        root.querySelector("#vis-analyze").addEventListener("click", () => analyzeWebcam(root));

        root.querySelector("#cam-add").addEventListener("click", async () => {
            const body = {
                id: root.querySelector("#cam-id").value.trim(),
                label: root.querySelector("#cam-label").value.trim(),
                snapshotUrl: root.querySelector("#cam-url").value.trim()
            };
            if (!body.id || !body.snapshotUrl) {
                toast("Id dan URL snapshot wajib diisi.", "warn");
                return;
            }
            try {
                await api.addCamera(body);
                toast("Kamera ditambahkan", "ok");
                await drawCameras(root);
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });

    },

    unmount() {
        stopCam();
        stopAllLive();
    }

};

async function drawModel(root) {

    const host = root.querySelector("#vis-model");

    let cfg;
    try {
        cfg = await api.visionConfig();
    }
    catch (error) {
        host.innerHTML = `<div class="small danger-text">${esc(error.message)}</div>`;
        return;
    }

    // Integrasi AI aktif (vision memakai otak yang sama).
    let integ = "AI aktif";
    try {
        const ai = await api.request("/ai/config");
        integ = ai?.resolved?.label ?? integ;
    }
    catch { /* opsional */ }

    host.innerHTML = `
        <div class="panel-head">
            <h2>${icon("orb")} Model vision</h2>
            <span class="push">${pill(
                cfg.configured ? (cfg.effective ?? "aktif") : "belum diatur",
                cfg.configured ? "ok" : "idle"
            )}</span>
        </div>
        <div class="small muted" style="margin-bottom:8px">
            Vision memakai integrasi AI yang sedang aktif:
            <strong>${esc(integ)}</strong>. Pilih model yang bisa "melihat"
            (mis. <span class="mono">llava</span>, <span class="mono">qwen2-vl</span>,
            <span class="mono">gpt-4o</span>, <span class="mono">gemini-*-flash</span>).
        </div>
        <div class="row">
            <select id="vis-model-select" style="flex:1">
                <option value="">— pakai default (${esc(cfg.effective ?? "otomatis")}) —</option>
                ${cfg.model ? `<option value="${esc(cfg.model)}" selected>${esc(cfg.model)}</option>` : ""}
                <option value="__manual__">✎ ketik manual…</option>
            </select>
            <button class="btn ghost sm" id="vis-model-load">${icon("refresh")} Muat</button>
            <button class="btn primary sm" id="vis-model-save">${icon("check")} Simpan</button>
        </div>
        <input type="text" id="vis-model-manual" style="display:none;margin-top:6px"
            value="${esc(cfg.model ?? "")}" placeholder="nama model vision">
        <div class="small dim" id="vis-model-help" style="margin-top:8px">
            Tekan <strong>Muat</strong> untuk mengambil daftar model dari integrasi aktif.
        </div>`;

    const select = host.querySelector("#vis-model-select");
    const manual = host.querySelector("#vis-model-manual");
    const help = host.querySelector("#vis-model-help");

    select.addEventListener("change", () => {
        const isManual = select.value === "__manual__";
        manual.style.display = isManual ? "" : "none";
        if (isManual) manual.focus();
    });

    host.querySelector("#vis-model-load").addEventListener("click", async () => {
        help.textContent = "Memuat model…";
        try {
            const data = await api.models();
            const list = data.models ?? [];
            select.innerHTML =
                `<option value="">— pakai default (${esc(cfg.effective ?? "otomatis")}) —</option>` +
                list.map(m => {
                    const glyph = m.status === "verified" ? "✓ " : (m.tier === "preview" || m.tier === "experimental") ? "⚠ " : "";
                    return `<option value="${esc(m.id)}" ${m.id === cfg.model ? "selected" : ""}>${glyph}${esc(m.name ?? m.id)}${m.free ? " · free" : ""}</option>`;
                }).join("") +
                `<option value="__manual__">✎ ketik manual…</option>`;
            help.textContent = `${list.length} model tersedia. Pilih yang mendukung gambar.`;
        }
        catch (error) {
            help.textContent = `Gagal memuat: ${error.message}`;
        }
    });

    host.querySelector("#vis-model-save").addEventListener("click", async () => {
        const model = select.value === "__manual__" ? manual.value.trim() : select.value.trim();
        try {
            await api.saveVisionConfig({ model });
            toast("Model vision disimpan", "ok");
            await drawModel(root);
        }
        catch (error) {
            toast(error.message, "danger");
        }
    });

}

async function drawCameras(root) {

    const host = root.querySelector("#vis-cameras");

    // Bersihkan pratinjau live lama sebelum menggambar ulang daftar.
    stopAllLive();

    try {
        // Gabung kamera MANUAL (/cameras) + kamera HOME ASSISTANT
        // (/home/cameras, entity camera.*). Dulu HA cameras tak muncul di
        // mana pun walau HA terhubung — itu sebab "CCTV tidak tampil".
        const [manual, ha] = await Promise.all([
            api.cameras().then(r => r.cameras || []).catch(() => []),
            api.homeCameras().then(r => (r.cameras || []).map(c => ({
                id: c.id,
                label: c.label || c.name || c.id,
                snapshotUrl: c.snapshot || `/home/camera/${encodeURIComponent(c.id)}/snapshot`,
                snapEndpoint: `/home/camera/${encodeURIComponent(c.id)}/snapshot`,
                ha: true
            }))).catch(() => [])
        ]);
        const cameras = [
            ...manual.map(c => ({ ...c, snapEndpoint: `/cameras/${encodeURIComponent(c.id)}/snapshot` })),
            ...ha
        ];

        if (cameras.length === 0) {
            host.innerHTML = `<div class="empty" style="padding:20px">${icon("camera")}<div>Belum ada kamera (manual maupun Home Assistant).</div></div>`;
            return;
        }

        host.innerHTML = `<div class="cctv-cards">` + cameras.map(c => `
            <div class="cctv-card" data-cam="${esc(c.id)}" data-snap="${esc(c.snapEndpoint)}" data-ha="${c.ha ? "1" : ""}">
                <div class="video-frame cctv-thumb" data-live>
                    <div class="placeholder">${icon("camera")}<div>${esc(c.label)}</div>
                        <div class="small dim">tekan Live untuk pratinjau</div></div>
                </div>
                <div class="cctv-meta">
                    <div>
                        <div class="title truncate">${esc(c.label)} <span class="tag mono">${esc(c.id)}</span></div>
                        <div class="sub mono truncate">${esc(c.snapshotUrl)}</div>
                    </div>
                    <div class="row" style="gap:6px">
                        <button class="btn sm" data-live-btn>${icon("play")} Live</button>
                        <button class="btn sm" data-see>${icon("orb")} Lihat</button>
                        <button class="btn sm danger" data-del>${icon("trash")}</button>
                    </div>
                </div>
                <div class="quote" data-out style="display:none"></div>
            </div>`).join("") + `</div>`;

        host.querySelectorAll("[data-cam]").forEach(row => {
            const id = row.dataset.cam;

            row.querySelector("[data-live-btn]").addEventListener("click", event => {
                toggleLive(id, row, event.currentTarget);
            });

            row.querySelector("[data-see]").addEventListener("click", async () => {
                const out = row.querySelector("[data-out]");
                out.style.display = "block";
                out.innerHTML = `<span class="spinner"></span> <span class="muted">Aether sedang melihat…</span>`;
                try {
                    const r = await api.seeCamera(id);
                    out.innerHTML = `<div class="small">${esc(r.text)}</div><div class="small dim mono" style="margin-top:4px">${esc(r.model)}</div>`;
                }
                catch (error) {
                    out.innerHTML = `<span class="danger-text">${esc(error.message)}</span>`;
                }
            });
            row.querySelector("[data-del]").addEventListener("click", async () => {
                if (!window.confirm(`Hapus kamera '${id}'?`)) return;
                try {
                    await api.removeCamera(id);
                    await drawCameras(root);
                }
                catch (error) {
                    toast(error.message, "danger");
                }
            });
        });

    }
    catch (error) {
        host.innerHTML = `<div class="small danger-text" style="padding:16px">${esc(error.message)}</div>`;
    }

}

/**
 * Nyala/matikan pratinjau live sebuah kamera. Snapshot diambil lewat
 * proxy daemon (fetch → blob) supaya lolos CSP & tanpa masalah CORS,
 * lalu <img> di-refresh berkala hingga terasa seperti video.
 */
async function toggleLive(id, row, button) {

    const box = row.querySelector("[data-live]");

    if (liveCams.has(id)) {
        stopLive(id);
        box.style.display = "none";
        box.innerHTML = "";
        button.innerHTML = `${icon("play")} Live`;
        return;
    }

    box.style.display = "block";
    box.innerHTML = `<div class="placeholder">Menyambung ke kamera…</div>`;
    button.innerHTML = `${icon("stop")} Stop`;

    const img = document.createElement("img");
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";

    const refresh = async () => {

        try {

            // Endpoint snapshot berbeda untuk HA vs manual (disimpan di
            // data-snap kartu). Header-auth dipakai (bukan <img src>),
            // jadi token ikut lewat header, blob dipasang ke <img>.
            const endpoint = row.dataset.snap || `/cameras/${encodeURIComponent(id)}/snapshot`;
            const res = await fetch(
                `${api.root}${endpoint}?t=${Date.now()}`,
                { headers: api.headers() }
            );

            if (!res.ok) {
                throw new Error(`snapshot ${res.status}`);
            }

            const blob = await res.blob();

            const live = liveCams.get(id);
            if (!live) return;                 // dihentikan saat menunggu

            if (img.parentNode !== box) {
                box.innerHTML = "";
                box.appendChild(img);
            }

            const previous = live.url;
            live.url = URL.createObjectURL(blob);
            img.src = live.url;
            if (previous) URL.revokeObjectURL(previous);

        }
        catch (error) {
            box.innerHTML = `<div class="placeholder danger-text">${esc(error.message)}</div>`;
        }

    };

    const timer = setInterval(refresh, 1200);
    liveCams.set(id, { timer, url: null });
    refresh();

}

async function startCam(root) {

    stopCam();

    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
    }
    catch (error) {
        toast(`Kamera: ${error.message}`, "danger");
        return;
    }

    const frame = root.querySelector("#vis-frame");
    frame.innerHTML = "";
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    frame.appendChild(video);

}

function stopCam(root) {
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    if (root) {
        const frame = root.querySelector("#vis-frame");
        if (frame) {
            frame.innerHTML = `<div class="placeholder">Tekan "Nyalakan" untuk pratinjau,<br>lalu "Analisis" agar Aether melihat.</div>`;
        }
    }
}

async function analyzeWebcam(root) {

    const video = root.querySelector("#vis-frame video");

    if (!video) {
        toast("Nyalakan kamera dulu.", "warn");
        return;
    }

    // Tangkap frame ke canvas → JPEG base64.
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

    const out = root.querySelector("#vis-result");
    out.style.display = "block";
    out.innerHTML = `<span class="spinner"></span> <span class="muted">Aether sedang melihat…</span>`;

    try {
        const r = await api.visionAnalyze({
            image: base64,
            mimeType: "image/jpeg",
            prompt: root.querySelector("#vis-prompt").value.trim() || undefined
        });
        out.innerHTML = `<div class="small selectable">${esc(r.text)}</div><div class="small dim mono" style="margin-top:4px">${esc(r.model)}</div>`;
    }
    catch (error) {
        out.innerHTML = `<span class="danger-text">${esc(error.message)}</span>`;
    }

}
