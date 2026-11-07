import { api } from "../lib/api.js";
import { store } from "../lib/store.js";
import { icon } from "../lib/icons.js";
import { esc, pill, toast } from "../lib/ui.js";

/** Sumber daya media aktif; harus dilepas saat pindah view. */
const live = {
    audioStream: null,
    videoStream: null,
    audioContext: null,
    animation: null
};

let config = null;

export const devices = {

    id: "devices",
    label: "Devices",
    icon: "mic",
    title: "Devices",
    subtitle: "Mikrofon, kamera, dan sensor yang dipakai Damar.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Devices</h1>
                    <p>Mikrofon, kamera, dan sensor yang dipakai Damar.</p>
                </div>
                <div class="actions">
                    <button class="btn ghost sm" id="dev-permission">${icon("check")} Izinkan akses</button>
                    <button class="btn primary sm" id="dev-save">${icon("check")} Simpan</button>
                </div>
            </div>

            <div class="stack">

                <div class="grid cols-2">

                    <div class="panel">
                        <div class="panel-head">
                            <h2>${icon("mic")} Mikrofon</h2>
                            <span class="push" id="mic-status">${pill("Nonaktif", "idle")}</span>
                        </div>
                        <div class="stack" id="mic-body">
                            <div class="row"><span class="spinner"></span><span class="small muted">Memuat…</span></div>
                        </div>
                    </div>

                    <div class="panel">
                        <div class="panel-head">
                            <h2>${icon("camera")} Kamera</h2>
                            <span class="push" id="cam-status">${pill("Nonaktif", "idle")}</span>
                        </div>
                        <div class="stack" id="cam-body">
                            <div class="row"><span class="spinner"></span><span class="small muted">Memuat…</span></div>
                        </div>
                    </div>

                </div>

                <div class="panel">
                    <div class="panel-head">
                        <h2>${icon("sensor")} Sensor</h2>
                        <span class="hint push">dibaca lewat endpoint HTTP</span>
                    </div>
                    <div id="sensor-body"></div>
                </div>

            </div>`;

    },

    async mount(root) {

        try {
            const data = await api.devices();
            config = data.config;
        }
        catch (error) {
            toast(`Konfigurasi perangkat: ${error.message}`, "danger");
            config = null;
        }

        if (!config) {

            root.querySelector("#mic-body").innerHTML =
                `<div class="small danger-text">Tidak bisa memuat konfigurasi dari daemon.</div>`;

            root.querySelector("#cam-body").innerHTML = "";

            return;

        }

        // Chromium/Electron baru membocorkan deviceId (dan label) SETELAH
        // izin media diberikan minimal sekali di sesi ini. Tanpa langkah
        // ini, deviceId tersimpan tak cocok dengan daftar enumerasi →
        // pilihan device seolah "hilang" tiap kali Console dibuka ulang.
        await primePermission();

        await renderAudio(root);
        await renderVideo(root);
        await renderSensors(root);

        root.querySelector("#dev-permission").addEventListener("click", async () => {

            try {

                // Label perangkat baru terbaca setelah izin diberikan,
                // jadi minta izin dulu lalu enumerasi ulang.
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: true
                });

                stream.getTracks().forEach(track => track.stop());

                await renderAudio(root);
                await renderVideo(root);

                toast("Izin diberikan — daftar perangkat diperbarui", "ok");

            }

            catch (error) {
                toast(`Izin ditolak: ${error.message}`, "warn");
            }

        });

        root.querySelector("#dev-save").addEventListener("click", () => save(root));

    },

    /** Dipanggil router saat meninggalkan view. */
    unmount() {

        stopAudio();
        stopVideo();

    }

};

// ---- Mikrofon -----------------------------------------------------

async function renderAudio(root) {

    const body = root.querySelector("#mic-body");

    const list = await enumerate("audioinput");

    const audio = config.audio;

    body.innerHTML = `

        <div class="field">
            <label>Perangkat input</label>
            <select id="mic-device">
                <option value="">— belum dipilih —</option>
                ${deviceOptions(list, audio.inputDeviceId, audio.inputLabel, "Mikrofon")}
            </select>
            ${list.length === 0 || !list[0].label
                ? `<span class="help">Tekan "Izinkan akses" agar nama perangkat muncul.</span>`
                : ""}
        </div>

        <div class="field">
            <label>Level masukan</label>
            <div class="meter"><div class="fill" id="mic-meter"></div></div>
            <span class="help" id="mic-meter-label">Tekan Uji untuk melihat level suara.</span>
        </div>

        <div class="grid cols-2" style="gap:10px">
            <div class="field">
                <label>Sample rate</label>
                <select id="mic-rate">
                    ${[8000, 16000, 22050, 44100, 48000].map(rate => `
                        <option value="${rate}" ${rate === audio.sampleRate ? "selected" : ""}>${rate} Hz</option>`).join("")}
                </select>
            </div>
            <div class="field">
                <label>Ambang VAD</label>
                <input type="range" id="mic-vad" min="0" max="0.2" step="0.005" value="${audio.vadThreshold}">
                <span class="help mono" id="mic-vad-label">${audio.vadThreshold}</span>
            </div>
        </div>

        <div class="field">
            <label>Wake word</label>
            <input type="text" id="mic-wake" value="${esc(audio.wakeWord ?? "")}" placeholder="mis. hey damar">
            <span class="help">Disimpan sebagai konfigurasi; deteksinya menyusul di fase Voice.</span>
        </div>

        <div class="row wrap" style="gap:14px">
            ${toggle("mic-enabled", "Aktifkan mikrofon", audio.enabled)}
            ${toggle("mic-ns", "Noise suppression", audio.noiseSuppression)}
            ${toggle("mic-ec", "Echo cancellation", audio.echoCancellation)}
            ${toggle("mic-agc", "Auto gain", audio.autoGainControl)}
        </div>

        <div class="row">
            <button class="btn sm" id="mic-test">${icon("play")} Uji</button>
            <button class="btn sm ghost" id="mic-stop">${icon("stop")} Berhenti</button>
        </div>`;

    const vad = body.querySelector("#mic-vad");

    vad.addEventListener("input", () => {
        body.querySelector("#mic-vad-label").textContent = vad.value;
    });

    body.querySelector("#mic-test").addEventListener("click", () => startAudio(root));
    body.querySelector("#mic-stop").addEventListener("click", () => stopAudio(root));

}

async function startAudio(root) {

    stopAudio(root);

    const deviceId = root.querySelector("#mic-device").value;

    try {

        live.audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                noiseSuppression: root.querySelector("#mic-ns").checked,
                echoCancellation: root.querySelector("#mic-ec").checked,
                autoGainControl: root.querySelector("#mic-agc").checked
            }
        });

    }

    catch (error) {

        toast(`Mikrofon: ${error.message}`, "danger");

        return;

    }

    live.audioContext = new AudioContext();

    const source = live.audioContext.createMediaStreamSource(live.audioStream);

    const analyser = live.audioContext.createAnalyser();

    analyser.fftSize = 1024;

    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);

    const meter = root.querySelector("#mic-meter");
    const label = root.querySelector("#mic-meter-label");
    const statusChip = root.querySelector("#mic-status");

    statusChip.innerHTML = pill("Mendengarkan", "ok");

    const threshold = Number(root.querySelector("#mic-vad").value);

    const tick = () => {

        analyser.getFloatTimeDomainData(samples);

        // RMS lebih stabil daripada nilai puncak untuk meter.
        let sum = 0;

        for (const sample of samples) {
            sum += sample * sample;
        }

        const rms = Math.sqrt(sum / samples.length);

        // Skala akar membuat suara pelan tetap terlihat bergerak.
        const percent = Math.min(100, Math.sqrt(rms) * 190);

        meter.style.width = `${percent.toFixed(1)}%`;

        label.textContent =
            `RMS ${rms.toFixed(4)} · ${rms >= threshold ? "ADA SUARA" : "senyap"}`;

        label.className = rms >= threshold ? "help ok-text" : "help";

        live.animation = requestAnimationFrame(tick);

    };

    tick();

}

function stopAudio(root) {

    if (live.animation) {
        cancelAnimationFrame(live.animation);
        live.animation = null;
    }

    live.audioStream?.getTracks().forEach(track => track.stop());
    live.audioStream = null;

    live.audioContext?.close().catch(() => {});
    live.audioContext = null;

    if (root) {

        const meter = root.querySelector("#mic-meter");

        if (meter) {
            meter.style.width = "0%";
        }

        const statusChip = root.querySelector("#mic-status");

        if (statusChip) {
            statusChip.innerHTML = pill(
                config?.audio.enabled ? "Siap" : "Nonaktif",
                config?.audio.enabled ? "warn" : "idle"
            );
        }

    }

}

// ---- Kamera --------------------------------------------------------

async function renderVideo(root) {

    const body = root.querySelector("#cam-body");

    const list = await enumerate("videoinput");

    const video = config.video;

    body.innerHTML = `

        <div class="video-frame" id="cam-frame">
            <div class="placeholder">Pratinjau kamera muncul di sini.<br>Tekan Uji untuk menyalakan.</div>
        </div>

        <div class="field">
            <label>Perangkat</label>
            <select id="cam-device">
                <option value="">— belum dipilih —</option>
                ${deviceOptions(list, video.deviceId, video.label, "Kamera")}
            </select>
        </div>

        <div class="grid cols-3" style="gap:10px">
            <div class="field">
                <label>Resolusi</label>
                <select id="cam-res">
                    ${[[640, 360], [1280, 720], [1920, 1080]].map(([w, h]) => `
                        <option value="${w}x${h}" ${w === video.width ? "selected" : ""}>${w}×${h}</option>`).join("")}
                </select>
            </div>
            <div class="field">
                <label>Frame rate</label>
                <select id="cam-fps">
                    ${[15, 24, 30, 60].map(fps => `
                        <option value="${fps}" ${fps === video.frameRate ? "selected" : ""}>${fps} fps</option>`).join("")}
                </select>
            </div>
            <div class="field">
                <label>Interval tangkap</label>
                <select id="cam-interval">
                    ${[1, 2, 5, 10, 30].map(seconds => `
                        <option value="${seconds}" ${seconds === video.captureInterval ? "selected" : ""}>${seconds} detik</option>`).join("")}
                </select>
            </div>
        </div>

        <div class="row">
            ${toggle("cam-enabled", "Aktifkan kamera", video.enabled)}
        </div>

        <div class="row">
            <button class="btn sm" id="cam-test">${icon("play")} Uji</button>
            <button class="btn sm ghost" id="cam-stop">${icon("stop")} Berhenti</button>
        </div>`;

    body.querySelector("#cam-test").addEventListener("click", () => startVideo(root));
    body.querySelector("#cam-stop").addEventListener("click", () => stopVideo(root));

}

async function startVideo(root) {

    stopVideo(root);

    const deviceId = root.querySelector("#cam-device").value;

    const [width, height] = root.querySelector("#cam-res").value.split("x").map(Number);

    try {

        live.videoStream = await navigator.mediaDevices.getUserMedia({
            video: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                width: { ideal: width },
                height: { ideal: height },
                frameRate: { ideal: Number(root.querySelector("#cam-fps").value) }
            }
        });

    }

    catch (error) {

        toast(`Kamera: ${error.message}`, "danger");

        return;

    }

    const frame = root.querySelector("#cam-frame");

    frame.innerHTML = "";

    const element = document.createElement("video");

    element.autoplay = true;
    element.muted = true;
    element.playsInline = true;
    element.srcObject = live.videoStream;

    frame.appendChild(element);

    root.querySelector("#cam-status").innerHTML = pill("Menyala", "ok");

}

function stopVideo(root) {

    live.videoStream?.getTracks().forEach(track => track.stop());
    live.videoStream = null;

    if (!root) {
        return;
    }

    const frame = root.querySelector("#cam-frame");

    if (frame) {
        frame.innerHTML = `<div class="placeholder">Pratinjau kamera muncul di sini.<br>Tekan Uji untuk menyalakan.</div>`;
    }

    const statusChip = root.querySelector("#cam-status");

    if (statusChip) {
        statusChip.innerHTML = pill(
            config?.video.enabled ? "Siap" : "Nonaktif",
            config?.video.enabled ? "warn" : "idle"
        );
    }

}

// ---- Sensor ---------------------------------------------------------

async function renderSensors(root) {

    const body = root.querySelector("#sensor-body");

    const list = config.sensors ?? [];

    body.innerHTML = `

        ${list.length === 0
            ? `<div class="empty">${icon("sensor")}<div>Belum ada sensor terdaftar.</div></div>`
            : `<div class="scroll-x"><table class="table">
                <thead><tr>
                    <th>ID</th><th>Label</th><th>Tipe</th><th>Endpoint</th>
                    <th>Value path</th><th>Nilai</th><th style="width:1%"></th>
                </tr></thead>
                <tbody>
                    ${list.map(sensor => `
                        <tr data-sensor="${esc(sensor.id)}">
                            <td class="mono">${esc(sensor.id)}</td>
                            <td>${esc(sensor.label)}</td>
                            <td><span class="tag">${esc(sensor.type)}</span></td>
                            <td class="mono small truncate" style="max-width:220px">${esc(sensor.url ?? "—")}</td>
                            <td class="mono small">${esc(sensor.valuePath)}</td>
                            <td class="mono small" data-reading>—</td>
                            <td><button class="btn sm danger" data-remove>${icon("trash")}</button></td>
                        </tr>`).join("")}
                </tbody>
            </table></div>`}

        <div class="divider"></div>

        <div class="grid cols-4" style="gap:10px;align-items:end">
            <div class="field"><label>ID</label><input type="text" id="s-id" placeholder="suhu-ruang"></div>
            <div class="field"><label>Label</label><input type="text" id="s-label" placeholder="Suhu Ruang"></div>
            <div class="field"><label>Tipe</label><input type="text" id="s-type" placeholder="temperature"></div>
            <div class="field"><label>Satuan</label><input type="text" id="s-unit" placeholder="°C"></div>
            <div class="field" style="grid-column:span 2"><label>Endpoint JSON</label>
                <input type="url" id="s-url" placeholder="http://192.168.1.50/api/sensor"></div>
            <div class="field"><label>Value path</label><input type="text" id="s-path" placeholder="data.value" value="value"></div>
            <div><button class="btn primary" id="s-add" style="width:100%">${icon("plus")} Tambah</button></div>
        </div>

        <div class="row" style="margin-top:12px">
            <button class="btn ghost sm" id="s-read">${icon("refresh")} Baca semua sensor</button>
        </div>`;

    body.querySelectorAll("[data-remove]").forEach(button => {

        button.addEventListener("click", async () => {

            const id = button.closest("[data-sensor]").dataset.sensor;

            try {
                await api.removeSensor(id);
                config = (await api.devices()).config;
                await renderSensors(root);
                toast(`Sensor "${id}" dihapus`, "ok");
            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

    });

    body.querySelector("#s-add").addEventListener("click", async () => {

        const sensor = {
            id: body.querySelector("#s-id").value.trim(),
            label: body.querySelector("#s-label").value.trim(),
            type: body.querySelector("#s-type").value.trim() || "generic",
            unit: body.querySelector("#s-unit").value.trim() || null,
            url: body.querySelector("#s-url").value.trim(),
            valuePath: body.querySelector("#s-path").value.trim() || "value"
        };

        if (!sensor.id || !sensor.url) {
            toast("ID dan endpoint wajib diisi.", "warn");
            return;
        }

        try {
            await api.addSensor(sensor);
            config = (await api.devices()).config;
            await renderSensors(root);
            toast(`Sensor "${sensor.id}" ditambahkan`, "ok");
        }
        catch (error) {
            toast(error.message, "danger");
        }

    });

    body.querySelector("#s-read").addEventListener("click", async () => {

        try {

            const data = await api.sensorReadings();

            for (const reading of data.readings) {

                const cell = body.querySelector(
                    `[data-sensor="${CSS.escape(reading.id)}"] [data-reading]`
                );

                if (!cell) {
                    continue;
                }

                cell.textContent = reading.ok
                    ? `${reading.value ?? "—"}${reading.unit ?? ""}`
                    : (reading.error ?? "gagal");

                cell.className = reading.ok
                    ? "mono small ok-text"
                    : "mono small danger-text";

            }

            toast(`${data.readings.length} sensor dibaca`, "ok");

        }

        catch (error) {
            toast(error.message, "danger");
        }

    });

}

// ---- Simpan ----------------------------------------------------------

async function save(root) {

    const micDevice = root.querySelector("#mic-device");
    const camDevice = root.querySelector("#cam-device");

    const [width, height] = root.querySelector("#cam-res").value.split("x").map(Number);

    const patch = {

        audio: {
            inputDeviceId: micDevice.value || null,
            inputLabel: micDevice.selectedOptions[0]?.textContent.trim() || null,
            sampleRate: Number(root.querySelector("#mic-rate").value),
            vadThreshold: Number(root.querySelector("#mic-vad").value),
            wakeWord: root.querySelector("#mic-wake").value.trim() || null,
            enabled: root.querySelector("#mic-enabled").checked,
            noiseSuppression: root.querySelector("#mic-ns").checked,
            echoCancellation: root.querySelector("#mic-ec").checked,
            autoGainControl: root.querySelector("#mic-agc").checked
        },

        video: {
            deviceId: camDevice.value || null,
            label: camDevice.selectedOptions[0]?.textContent.trim() || null,
            width,
            height,
            frameRate: Number(root.querySelector("#cam-fps").value),
            captureInterval: Number(root.querySelector("#cam-interval").value),
            enabled: root.querySelector("#cam-enabled").checked
        }

    };

    try {

        config = await api.saveDevices(patch);

        store.set({ devices: config });

        toast("Konfigurasi perangkat disimpan", "ok");

    }

    catch (error) {
        toast(error.message, "danger");
    }

}

// ---- Pembantu ---------------------------------------------------------

async function enumerate(kind) {

    try {

        const list = await navigator.mediaDevices.enumerateDevices();

        return list.filter(device => device.kind === kind);

    }

    catch {
        return [];
    }

}

/**
 * Minta izin media sekali agar enumerateDevices() mengembalikan
 * deviceId & label yang sebenarnya. Dijalankan diam-diam; kegagalan
 * (mis. tak ada kamera) tidak fatal.
 */
async function primePermission() {

    for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {

        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        catch {
            // Coba kombinasi berikutnya (mis. hanya mic bila tak ada kamera).
        }

    }

}

/**
 * Bangun <option> daftar perangkat, sekaligus MENJAGA perangkat
 * yang tersimpan tetap terpilih walau sedang tidak ter-enumerasi
 * (mis. sempat dicabut) — supaya setelan tidak "hilang" sendiri.
 */
function deviceOptions(list, savedId, savedLabel, fallbackPrefix) {

    const options = list.map(device => `
        <option value="${esc(device.deviceId)}" ${device.deviceId === savedId ? "selected" : ""}>
            ${esc(device.label || `${fallbackPrefix} ${device.deviceId.slice(0, 6)}`)}
        </option>`);

    if (savedId && !list.some(device => device.deviceId === savedId)) {
        options.unshift(`
            <option value="${esc(savedId)}" selected>
                ${esc(savedLabel || `${fallbackPrefix} tersimpan`)} (tak terdeteksi)
            </option>`);
    }

    return options.join("");

}

function toggle(id, label, checked) {

    return `<label class="switch">
        <input type="checkbox" id="${id}" ${checked ? "checked" : ""}>
        <span class="track"></span>
        <span>${esc(label)}</span>
    </label>`;

}
