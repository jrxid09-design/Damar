import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, toast } from "../lib/ui.js";

/**
 * Rumah — kendali perangkat rumah lewat Home Assistant.
 *
 * Menampilkan perangkat per jenis dengan kontrol cepat (nyala/mati,
 * kecerahan, suhu). Bila HA belum dikonfigurasi, memandu ke Settings.
 */

const CONTROLLABLE = new Set(["light", "switch", "fan", "climate", "media_player", "input_boolean"]);

export const home = {

    id: "home",
    label: "Rumah",
    icon: "home",
    title: "Rumah",
    subtitle: "Kendalikan lampu, AC, dan perangkat lewat Home Assistant.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Rumah</h1>
                    <p>Kendalikan lampu, AC, dan perangkat lewat Home Assistant.</p>
                </div>
                <div class="actions">
                    <select id="home-domain" style="width:150px">
                        <option value="">Semua jenis</option>
                        <option value="light">Lampu</option>
                        <option value="switch">Saklar</option>
                        <option value="climate">AC / Climate</option>
                        <option value="fan">Kipas</option>
                        <option value="media_player">Media</option>
                        <option value="camera">Kamera / CCTV</option>
                        <option value="sensor">Sensor</option>
                    </select>
                    <button class="btn ghost sm" id="home-refresh">${icon("refresh")} Muat ulang</button>
                </div>
            </div>
            <div id="home-body" class="stack"></div>`;

    },

    async mount(root) {

        const body = root.querySelector("#home-body");
        const domainSel = root.querySelector("#home-domain");

        const load = async () => {

            body.innerHTML = `<div class="panel"><div class="row">
                <span class="spinner"></span><span class="small muted">Memuat perangkat…</span></div></div>`;

            let status;
            try {
                status = await api.homeStatus();
            }
            catch (error) {
                body.innerHTML = errorPanel(error.message);
                return;
            }

            if (!status.configured) {
                body.innerHTML = notConfigured();
                return;
            }

            if (!status.health?.online) {
                body.innerHTML = errorPanel(
                    `Home Assistant offline: ${status.health?.error ?? "tidak terjangkau"}`
                );
                return;
            }

            try {
                // CCTV ditarik terpisah: entitas camera.* memang ada di
                // daftar perangkat, tetapi tanpa gambar ia cuma baris
                // teks — dan gambar itulah yang dicari pemiliknya.
                const [data, cams] = await Promise.all([
                    api.homeDevices(domainSel.value || null),
                    api.homeCameras().then(r => r.cameras ?? []).catch(() => [])
                ]);
                body.innerHTML = cameraPanel(cams) + render(data);
                wire(body, load);
            }
            catch (error) {
                body.innerHTML = errorPanel(error.message);
            }

        };

        domainSel.addEventListener("change", load);
        root.querySelector("#home-refresh").addEventListener("click", load);

        await load();

    }

};

function render(data) {

    const groups = {};
    for (const d of data.devices) {
        (groups[d.domain] ??= []).push(d);
    }

    const order = ["light", "switch", "climate", "fan", "media_player"];
    const domains = Object.keys(groups).sort((a, b) => {
        const ai = order.indexOf(a); const bi = order.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const sm = data.summary;
    const summary = sm ? `
        <div class="home-hero">
            <div class="hh-core"><span class="hh-ring"></span>${icon("home")}</div>
            <div class="hh-stat"><span class="hh-v">${sm.total}</span><span class="hh-k">perangkat</span></div>
            <div class="hh-stat on"><span class="hh-v">${sm.on}</span><span class="hh-k">menyala</span></div>
            <div class="hh-stat"><span class="hh-v">${Math.max(0, (sm.total ?? 0) - (sm.on ?? 0))}</span><span class="hh-k">mati</span></div>
        </div>` : "";

    return summary + domains.map(domain => `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon(domainIconOf(domain))} ${esc(domainLabel(domain))}</h2>
                <span class="hint push">${groups[domain].length}</span>
            </div>
            <div class="home-grid">
                ${groups[domain].map(deviceRow).join("")}
            </div>
        </div>`).join("");

}

/**
 * Panel CCTV.
 *
 * Gambarnya diambil dari daemon (bukan langsung dari Home Assistant)
 * karena URL HA menuntut long-lived token; `?t=` memaksa muat ulang
 * supaya yang terlihat bingkai terbaru, bukan cache.
 */
function cameraPanel(cams) {

    if (!cams.length) return "";

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("camera") || icon("sensor")} CCTV</h2>
                <span class="hint push">${cams.length} kamera</span>
            </div>
            <div class="home-cams">
                ${cams.map(c => `
                    <figure class="home-cam" data-cam="${esc(c.id)}">
                        <img src="${esc(api.root + c.snapshot)}?t=${Date.now()}${api.token ? `&token=${encodeURIComponent(api.token)}` : ""}"
                             alt="${esc(c.name)}" loading="lazy"
                             onerror="this.closest('.home-cam').classList.add('gagal')">
                        <figcaption>
                            <span class="nm">${esc(c.name)}</span>
                            <span class="st">${esc(c.state ?? "")}</span>
                        </figcaption>
                    </figure>`).join("")}
            </div>
            <div class="small dim" style="margin-top:8px">
                Gambar diam, disegarkan tiap kali halaman dimuat ulang.
            </div>
        </div>`;

}

function domainIconOf(domain) {
    return {
        light: "activity", switch: "tool", climate: "sensor", fan: "refresh",
        media_player: "activity", sensor: "sensor", binary_sensor: "sensor", cover: "home",
        camera: "camera"
    }[domain] ?? "home";
}

function deviceRow(d) {

    const on = d.state === "on";
    const controllable = CONTROLLABLE.has(d.domain);

    let controls = "";

    if (d.domain === "light" || d.domain === "switch" || d.domain === "fan" || d.domain === "input_boolean" || d.domain === "media_player") {
        controls = `<button class="btn sm ${on ? "" : "ghost"}" data-toggle="${esc(d.id)}">
            ${on ? "Matikan" : "Nyalakan"}</button>`;
        if (d.domain === "light" && on) {
            const b = Math.round((d.attributes?.brightness ?? 0) / 255 * 100) || 0;
            controls += `<input type="range" min="0" max="100" value="${b}" data-bri="${esc(d.id)}" style="width:90px" title="kecerahan">`;
        }
    }
    else if (d.domain === "climate") {
        const temp = d.attributes?.temperature ?? "";
        controls = `<input type="number" value="${esc(temp)}" data-temp="${esc(d.id)}" style="width:70px" title="suhu"> °C`;
    }

    const stateLabel = on ? pill("on", "ok")
        : (d.state === "off" || d.state === "unavailable")
            ? pill(d.state, d.state === "off" ? "idle" : "danger")
            : `<span class="tag mono">${esc(d.state)}</span>`;

    return `
        <div class="dev-card ${on ? "on" : ""}" data-device="${esc(d.id)}">
            <div class="row" style="gap:10px;align-items:flex-start">
                <span class="tile">${icon(domainIconOf(d.domain))}</span>
                <div style="min-width:0;flex:1">
                    <div class="title truncate">${esc(d.name)}</div>
                    <div class="sub mono truncate">${esc(d.id)}</div>
                </div>
                ${stateLabel}
            </div>
            ${controls ? `<div class="row dev-controls" style="gap:8px">${controls}</div>` : ""}
        </div>`;

}

function wire(scope, reload) {

    scope.querySelectorAll("[data-toggle]").forEach(btn => {
        btn.addEventListener("click", async () => {
            try {
                await api.homeControl({ entity_id: btn.dataset.toggle, action: "toggle" });
                setTimeout(reload, 400);
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });
    });

    scope.querySelectorAll("[data-bri]").forEach(sl => {
        sl.addEventListener("change", async () => {
            try {
                await api.homeControl({ entity_id: sl.dataset.bri, action: "brightness", value: Number(sl.value) });
                toast("Kecerahan diatur", "ok");
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });
    });

    scope.querySelectorAll("[data-temp]").forEach(inp => {
        inp.addEventListener("change", async () => {
            try {
                await api.homeControl({ entity_id: inp.dataset.temp, action: "temperature", value: Number(inp.value) });
                toast("Suhu diatur", "ok");
            }
            catch (error) {
                toast(error.message, "danger");
            }
        });
    });

}

function domainLabel(domain) {
    return {
        light: "Lampu", switch: "Saklar", climate: "AC / Climate", fan: "Kipas",
        media_player: "Media Player", sensor: "Sensor", binary_sensor: "Sensor Biner",
        cover: "Tirai/Pintu", input_boolean: "Sakelar Virtual", camera: "Kamera / CCTV"
    }[domain] ?? domain;
}

function notConfigured() {
    return `<div class="panel"><div class="empty">
        ${icon("home")}
        <div style="font-size:14px;color:var(--text)">Home Assistant belum tersambung</div>
        <div>Buka <strong>Settings → Rumah (Home Assistant)</strong>, isi URL &amp; token
        (long-lived access token dari profil HA-mu).</div>
    </div></div>`;
}

function errorPanel(message) {
    return `<div class="panel"><div class="empty">${icon("alert")}
        <div class="danger-text">${esc(message)}</div></div></div>`;
}
