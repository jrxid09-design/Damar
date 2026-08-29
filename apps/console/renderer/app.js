import { store } from "./lib/store.js";
import { api } from "./lib/api.js";
import { icon, brandMark } from "./lib/icons.js";
import { $, esc, pill, toast } from "./lib/ui.js";
import { damarState } from "./lib/damarState.js";
import { agentBus } from "./lib/agentBus.js";
import { showBubble } from "./lib/homeBubbles.js";

import { createHologram } from "./lib/hologram.js";
import { createWakeWord } from "./lib/wakeword.js";
import { openOverlay, isOpen as overlayOpen, greetAndListen, close as closeOverlay } from "./lib/damarOverlay.js";

import { buildStudioApp } from "./views/apps/studio.js";
import { buildSpaceApp } from "./views/apps/space.js";
import { buildConnectApp } from "./views/apps/connect.js";
import { labApp } from "./views/lab/labApp.js";

// View mandiri (dipakai apa adanya sebagai "aplikasi").
import { damar } from "./views/damar.js";
import { dashboard } from "./views/dashboard.js";
import { memory } from "./views/memory.js";
import { models } from "./views/models.js";
import { runtime } from "./views/runtime.js";
import { awareness } from "./views/awareness.js";
import { logs } from "./views/logs.js";
import { settings } from "./views/settings.js";
import { family } from "./views/family.js";

// =====================================================================
// Registry APLIKASI — semua navigasi lama hidup di App Launcher (1 tombol)
// =====================================================================

const goHome = () => navigate("core");

// Warna semantik KANONIK (dari damar.tokens.css): cyan=identitas,
// violet=kognisi, hijau=ok, BIRU=processing (oranye bukan warna kanon).
const CY = "#00DFFF", AI = "#7C5CFF", OK = "#48E6A5", PR = "#28AFFF";

// Kategori Control Hub — Damar di pusat, sisanya "Applications".
const CATEGORIES = ["Inti", "Kecerdasan", "Ruang", "Sistem"];

/**
 * Registry APPLICATIONS. Tiap app = kapabilitas Damar dengan metadata OS:
 * category, version, capabilities, permissions, dependencies. Status runtime
 * (running/health) diturunkan LIVE dari overview di appStatus(). Menambah app
 * = satu entri (scalable). Status = fungsi murni (maintainable).
 */
const APPS = [
    { id: "core", label: "Beranda", icon: "orb", color: CY, desc: "Pusat entitas Damar", core: true, cat: "Inti",
      version: "3.0", caps: ["Suara", "Hologram", "Perintah"], perms: ["Mikrofon"], deps: [] },
    { id: "chat", label: "Damar", icon: "chat", color: CY, desc: "Percakapan & reasoning", view: damar, cat: "Inti",
      version: "3.0", caps: ["Chat", "Voice", "Streaming"], perms: ["AI", "Mikrofon"], deps: ["Model AI", "Memori"] },
    { id: "memory", label: "Memori", icon: "memory", color: AI, desc: "Ingatan jangka panjang", view: memory, cat: "Kecerdasan",
      version: "2.4", caps: ["Recall", "Graph", "Governance"], perms: ["Baca/Tulis memori"], deps: ["Model AI"] },
    { id: "models", label: "Model AI", icon: "cpu", color: AI, desc: "Provider & token", view: models, cat: "Kecerdasan",
      version: "2.1", caps: ["Provider", "Fallback", "Usage"], perms: ["Kunci API"], deps: [] },
    { id: "studio", label: "Studio", icon: "grid", color: AI, desc: "Skills · Agent · Tools", view: buildStudioApp(goHome), consolidated: true, cat: "Kecerdasan",
      version: "1.8", caps: ["Skills", "Agent", "Tools"], perms: ["Eksekusi tool"], deps: ["Model AI"] },
    { id: "awareness", label: "Kesadaran", icon: "activity", color: AI, desc: "Kesadaran ekosistem", view: awareness, cat: "Kecerdasan",
      version: "1.2", caps: ["Konteks", "Sinyal"], perms: [], deps: ["Memori"] },
    { id: "space", label: "Ruang", icon: "home", color: OK, desc: "Rumah · Vision · NAS", view: buildSpaceApp(goHome), consolidated: true, cat: "Ruang",
      version: "2.1", caps: ["Smart Home", "Vision", "NAS"], perms: ["Kamera", "Berkas"], deps: ["Terhubung"] },
    { id: "lab", label: "Laboratorium", icon: "flask", color: AI, desc: "Project bareng Damar & agents", view: labApp, cat: "Kecerdasan",
      version: "2.0", caps: ["Missions", "Agents", "Artifacts", "Experiments"], perms: ["Berkas", "Terminal"], deps: ["Model AI"] },
    // App "Terhubung" DIHAPUS — Perangkat & Integrasi kini jadi kategori
    // di Pengaturan (control-panel). opencode sudah terintegrasi sebagai
    // tool (opencode_run, dijembatani WSL).
    { id: "family", label: "Damar OSINT", icon: "search", color: AI, desc: "Investigasi · Kebocoran · Telepon · Pelacakan", view: family, cat: "Kecerdasan",
      version: "2.0", caps: ["OSINT", "Breach", "Phone Intel", "Tracking"], perms: [], deps: [] },
    { id: "dashboard", label: "Panel Sistem", icon: "dashboard", color: CY, desc: "Metrik & ringkasan sistem", view: dashboard, cat: "Sistem",
      version: "1.5", caps: ["Metrik", "Ringkasan"], perms: [], deps: [] },
    { id: "runtime", label: "Runtime", icon: "terminal", color: CY, desc: "Proses, terminal & log", view: runtime, cat: "Sistem",
      version: "1.6", caps: ["Proses", "Terminal", "Log"], perms: ["Shell"], deps: [] },
    // App "Log" dihapus — kejadian/notifikasi kini menyatu di Runtime.
    // App "Keamanan" sengaja tidak didaftarkan (permintaan pemilik).
    // Rem daruratnya tetap hidup sebagai tombol STOP di titlebar;
    // view-nya masih ada di views/safety.js bila kelak dibutuhkan.
    { id: "settings", label: "Pengaturan", icon: "gear", color: CY, desc: "Preferensi & koneksi", view: settings, cat: "Sistem",
      version: "1.4", caps: ["Preferensi", "Daemon"], perms: [], deps: [] }
];

/**
 * Status runtime sebuah app — DITURUNKAN dari data nyata (overview) supaya
 * Control Hub hidup, bukan hiasan. tone ∈ ok|ai|proc|idle|danger.
 */
function appStatus(app) {
    const s = store.get();
    if (!s.connected && app.id !== "settings" && app.id !== "core") return { tone: "idle", label: "Offline", running: false };
    const o = s.overview;
    switch (app.id) {
        case "core": return { tone: "ai", label: "Aktif", running: true };
        case "chat": return { tone: "ai", label: o?.ai?.active ? "Siap" : "Model?", running: true };
        case "connect": {
            const g = o?.integrations?.summary;
            return g ? { tone: g.online > 0 ? "ok" : "idle", label: `${g.online}/${g.enabled} online`, running: g.online > 0 } : { tone: "idle", label: "—", running: false };
        }
        case "models": return { tone: "ai", label: (o?.ai?.active ?? o?.ai?.defaultModel ?? "—").split("/").pop(), running: !!o?.ai?.active };
        case "studio": return { tone: "ok", label: `${o?.tools?.total ?? 0} tools`, running: true };
        case "runtime": return { tone: o ? "ok" : "idle", label: o ? `up ${durationShort(o.stats.daemon.uptime)}` : "—", running: !!o };
        case "logs": return { tone: s.logs.length ? "proc" : "idle", label: `${s.logs.length} event`, running: false };
        case "memory": return { tone: "ok", label: "Aktif", running: true };
        case "dashboard": return { tone: o ? "ok" : "idle", label: o ? `${Math.round(o.stats.cpu.usage)}% CPU` : "—", running: !!o };
        default: return { tone: s.connected ? "ok" : "idle", label: s.connected ? "Siap" : "Offline", running: false };
    }
}

let currentAppId = null;
let currentInstance = null;
let coreHolo = null;
let fabHolo = null;

/**
 * Hemat daya: hanya SATU entitas 3D yang animasi pada satu waktu.
 * - Inti Beranda tetap hidup walau bubble chat terbuka (orb bergeser
 *   kiri dan terus bereaksi — bubble TIDAK menutupinya).
 * - Orb fab disembunyikan+dijeda saat di Beranda / overlay (hindari 2 scene).
 */
function refreshHoloPower() {
    const overlay = overlayOpen();
    const onCore = currentAppId === "core";

    // Laboratorium punya baris perintahnya sendiri di kanan bawah —
    // persis tempat orb mengambang berdiri. Orb itu menelan klik pada
    // tombol Jalankan: tombolnya terlihat, tapi tak bisa ditekan.
    const bentrok = currentAppId === "lab";

    const sembunyi = onCore || overlay || bentrok;

    if (coreHolo) onCore ? coreHolo.resume() : coreHolo.pause();
    const fab = document.getElementById("holo-fab");
    if (fab) fab.style.display = sembunyi ? "none" : "";
    if (fabHolo) sembunyi ? fabHolo.pause() : fabHolo.resume();
}

// Semua hologram hidup (Beranda + fab) → disiarkan via bus keadaan.
const holos = new Set();
const holoState = (s) => damarState.set(s);   // bus: avatar+UI+partikel koheren
const holoLevel = (v) => damarState.setLevel(v);

let pollTimer = null;
let reconnectTimer = null;
let wake = null;

// =====================================================================
// Kerangka
// =====================================================================

function buildTitlebar() {

    $("#brand-mark").innerHTML = brandMark(20);
    $("#win-min").innerHTML = icon("minimize");
    $("#win-max").innerHTML = icon("maximize");
    $("#win-close").innerHTML = icon("close");

    $("#win-min").addEventListener("click", () => window.damar.window.minimize());
    $("#win-close").addEventListener("click", () => window.damar.window.close());
    $("#win-max").addEventListener("click", async () => {
        const maximized = await window.damar.window.toggleMaximize();
        $("#win-max").innerHTML = icon(maximized ? "restore" : "maximize");
    });
    window.damar.window.onState(({ maximized }) => {
        $("#win-max").innerHTML = icon(maximized ? "restore" : "maximize");
    });

    // Tombol APPS → launcher; chip koneksi → sambung/putus.
    $("#apps-btn").addEventListener("click", toggleLauncher);
    $("#connection-chip").addEventListener("click", () => store.get().connected ? disconnect() : connect());

    $("#stop-btn").addEventListener("click", toggleStop);
    refreshSafety();
}

// ---- Kill switch (Konstitusi Pasal 2.1) --------------------------

/** Keadaan terakhir yang diketahui; dipakai agar tombol tidak berkedip. */
let safetyState = { engaged: false };

async function refreshSafety() {

    try {
        const res = await api.safety();
        safetyState = res.data ?? { engaged: false };
    }
    catch {
        // Daemon tak terjangkau — jangan berpura-pura tahu keadaannya.
        safetyState = { engaged: null };
    }

    paintStopButton();

}

function paintStopButton() {

    const btn = $("#stop-btn");
    if (!btn) return;

    const engaged = safetyState.engaged === true;

    btn.classList.toggle("engaged", engaged);
    btn.querySelector(".txt").textContent = engaged ? "LANJUTKAN" : "STOP";
    btn.title = engaged
        ? `Damar dihentikan — ${safetyState.reason ?? "tanpa alasan"}. Klik untuk melanjutkan.`
        : "Hentikan Damar (semua tool & tugas otonom)";

}

async function toggleStop() {

    const engaged = safetyState.engaged === true;

    try {

        if (engaged) {
            await api.safetyRelease();
            toast("Damar dilanjutkan", "ok");
        }
        else {
            // Tanpa dialog konfirmasi: menghentikan adalah tindakan
            // AMAN dan dapat dibatalkan. Menaruh penghalang di depan
            // rem darurat justru berbahaya (§274).
            await api.safetyStop("dihentikan dari Console");
            toast("Damar dihentikan — tool & tugas otonom berhenti", "warn");
        }

    }
    catch (e) {
        toast(`Gagal: ${e.message}`, "err");
    }

    await refreshSafety();

}

// ---- App Launcher (satu tombol → semua aplikasi) ------------------

function buildLauncher() {
    $("#launcher-close").addEventListener("click", closeLauncher);
    $("#launcher").addEventListener("click", e => { if (e.target.id === "launcher") closeLauncher(); });
    renderHub();
}

/**
 * Control Hub — bukan menu, tapi pusat kendali: kartu app HIDUP berkategori,
 * status/health/versi diturunkan dari data nyata; Damar ditampilkan sebagai
 * pengoordinasi. Dipanggil ulang saat poll agar status tetap live.
 */
function renderHub() {
    const grid = document.getElementById("app-grid");
    if (!grid) return;

    const activeCount = APPS.filter(a => !a.core && appStatus(a).running).length;
    const header = document.getElementById("hub-head");
    if (header) header.innerHTML =
        `<span class="hub-brand">DAMAR</span> mengoordinasi <b>${activeCount}</b> aplikasi aktif`;

    grid.innerHTML = CATEGORIES.map(cat => {
        const apps = APPS.filter(a => a.cat === cat);
        if (!apps.length) return "";
        return `<div class="hub-cat">${esc(cat)}</div>
            <div class="hub-row">${apps.map(a => {
                const st = appStatus(a);
                return `<button class="hub-card${a.id === currentAppId ? " current" : ""}" data-app="${esc(a.id)}" style="--tile:${a.color}">
                    <div class="hub-top">
                        <span class="ico">${icon(a.icon)}</span>
                        <span class="hub-dot hub-dot-${st.tone}" title="${esc(st.label)}"></span>
                    </div>
                    <div class="hub-name">${esc(a.label)}${st.running ? `<span class="run">●</span>` : ""}</div>
                    <div class="hub-desc">${esc(a.desc)}</div>
                    <div class="hub-meta"><span class="ver">v${esc(a.version)}</span><span class="stt">${esc(st.label)}</span></div>
                    <div class="hub-caps">${a.caps.slice(0, 3).map(c => `<span>${esc(c)}</span>`).join("")}</div>
                </button>`;
            }).join("")}</div>`;
    }).join("");

    grid.querySelectorAll("[data-app]").forEach(b => b.addEventListener("click", () => navigate(b.dataset.app)));
}

/**
 * Segarkan hanya STATUS kartu app (dot, indikator jalan, label, kartu
 * aktif) TANPA membangun ulang innerHTML — supaya tak ada kedip saat
 * poll berkala menyegarkan status selagi launcher terbuka.
 */
function updateHubStatus() {
    const grid = document.getElementById("app-grid");
    if (!grid) return;

    const activeCount = APPS.filter(a => !a.core && appStatus(a).running).length;
    const header = document.getElementById("hub-head");
    if (header) header.innerHTML =
        `<span class="hub-brand">DAMAR</span> mengoordinasi <b>${activeCount}</b> aplikasi aktif`;

    grid.querySelectorAll("[data-app]").forEach(btn => {
        const a = APPS.find(x => x.id === btn.dataset.app);
        if (!a) return;
        const st = appStatus(a);

        btn.classList.toggle("current", a.id === currentAppId);

        const dot = btn.querySelector(".hub-dot");
        if (dot) { dot.className = `hub-dot hub-dot-${st.tone}`; dot.title = st.label; }

        const stt = btn.querySelector(".hub-meta .stt");
        if (stt) stt.textContent = st.label;

        const name = btn.querySelector(".hub-name");
        if (name) {
            const run = name.querySelector(".run");
            if (st.running && !run) name.insertAdjacentHTML("beforeend", `<span class="run">●</span>`);
            else if (!st.running && run) run.remove();
        }
    });
}

function toggleLauncher() { const l = $("#launcher"); l.classList.toggle("open"); if (l.classList.contains("open")) renderHub(); }
function closeLauncher() { $("#launcher").classList.remove("open"); }

// ---- Navigasi (tiap app = satu layar di #stage) -------------------

function ensureScreen(app) {
    let s = document.getElementById(`screen-${app.id}`);
    if (!s) {
        s = document.createElement("section");
        s.className = "app-screen" + (app.core ? " core" : "");
        s.id = `screen-${app.id}`;
        $("#stage").appendChild(s);
    }
    return s;
}

function navigate(id) {

    const app = APPS.find(a => a.id === id) || APPS[0];

    // Lepas sumber daya app sebelumnya.
    currentInstance?.unmount?.();
    if (currentAppId === "core") teardownCore();
    currentInstance = null;

    // Sesi bubble adalah percakapan DI BERANDA. Membawanya ke Pengaturan
    // atau Log hanya menyisakan gelembung yatim yang menutupi konten —
    // jadi pindah aplikasi = sesi ditutup.
    if (app.id !== "core") closeOverlay();

    currentAppId = app.id;

    const screen = ensureScreen(app);
    document.querySelectorAll(".app-screen").forEach(s => s.classList.toggle("active", s === screen));

    if (app.core) {
        renderCore(screen);
    }
    else if (app.consolidated) {
        app.view.render(screen);
        currentInstance = app.view;
    }
    else {
        currentInstance = mountStandalone(screen, app);
    }

    location.hash = app.id;
    refreshHoloPower();
    closeLauncher();
}

/** Bungkus view mandiri dengan app-head (judul + kembali). */
function mountStandalone(screen, app) {
    screen.innerHTML = `
        <div class="app-head">
            <button class="back" title="Kembali ke Beranda">${icon("chevron-left") || "‹"}</button>
            <div class="title">${esc(app.label)}<small>${esc(app.desc)}</small></div>
        </div>
        <div class="app-body" style="height:calc(100% - 58px)"></div>`;
    screen.querySelector(".back").addEventListener("click", goHome);
    const body = screen.querySelector(".app-body");
    app.view.render(body);
    app.view.mount?.(body);
    return { unmount() { app.view.unmount?.(); } };
}

// ---- Beranda hologram (core) --------------------------------------

function greeting() {
    const h = new Date().getHours();
    const line = h < 5 ? "Selamat malam" : h < 11 ? "Selamat pagi" : h < 15 ? "Selamat siang" : h < 19 ? "Selamat sore" : "Selamat malam";
    return { line, sub: "Ucapkan “Damar” atau ketik untuk memulai." };
}

function renderCore(screen) {

    const g = greeting();

    // Kanvas entitas dibuat FULL-BLEED (lebih lebar dari layar) alih-alih
    // kotak kecil di tengah. Dua masalah selesai sekaligus: orb tampil
    // jauh lebih besar dalam piksel nyata, dan orb agen yang terbang ke
    // tepi orbit tidak lagi terpotong batas kanvas. Teks & kotak ketik
    // melayang DI ATAS kanvas, bukan mendorongnya jadi kecil.
    screen.innerHTML = `
        <div class="holo-home">
            <div class="holo-canvas" id="core-holo" aria-hidden="true"></div>
            <div class="holo-fore">
                <div class="holo-hero">
                    <div class="holo-greet" id="core-greet"></div>
                    <div class="holo-sub" id="core-sub">${esc(g.sub)}</div>
                </div>
                <div class="holo-dock">
                    <div class="holo-stats" id="core-stats" aria-live="polite"></div>
                    <form class="holo-prompt" id="core-prompt">
                        <input type="text" autocomplete="off" placeholder="Tanya apa saja pada Damar…" />
                        <button class="mic" type="button" id="core-mic" title="Bicara">${icon("mic")}</button>
                    </form>
                </div>
            </div>
        </div>`;

    // Progressive disclosure: statistik ambient — muncul saat wilayah
    // bawah di-hover / system aktif; menetap tenang saat idle (spec:
    // jangan isi layar dengan panel tanpa tugas aktif).
    try {
        // 60 fps di layar utama: panel 180 Hz membuat gerak orbit halus
        // tanpa tearing (renderer vsync); fab & mini tetap hemat (24).
        coreHolo = createHologram({ maxFps: 20 });
        screen.querySelector("#core-holo").appendChild(coreHolo.el);
        holos.add(coreHolo);
        damarState.set(store.get().connected ? "idle" : "offline");
    }
    catch { coreHolo = null; }

    renderCoreStats();

    // Sapaan diketik perlahan — kemunculan yang tenang & hangat.
    typeGreeting(screen, `${g.line}, aku Damar`);

    // Mulai sesi (teks) → sapaan memudar perlahan, bubble muncul,
    // orb bergeser kiri. Input TETAP di kotak ketik dashboard ini.
    const form = screen.querySelector("#core-prompt");
    form.addEventListener("submit", e => {
        e.preventDefault();
        const v = form.querySelector("input").value.trim();
        if (!v) return;
        form.querySelector("input").value = "";
        fadeGreeting(screen);
        openOverlay({ text: v });
    });
    // Mic: Damar ANTUSIAS menyapa lalu mendengar — sesi tetap
    // berpusat di dashboard (kotak ketik + mic ini satu-satunya input).
    screen.querySelector("#core-mic").addEventListener("click", () => {
        fadeGreeting(screen);
        greetAndListen();
    });

    // Progressive disclosure: statistik redup secara default, terang saat
    // kursor mendekat (interaksi → intensitas lokal meningkat).
    const stats = screen.querySelector("#core-stats");
    if (stats) {
        stats.classList.add("ambient");
        stats.addEventListener("pointerenter", () => stats.classList.remove("ambient"));
        stats.addEventListener("pointerleave", () => stats.classList.add("ambient"));
    }
}

/** Sapaan berketik lambat — muncul tenang, kata "Damar" ditebalkan. */
function typeGreeting(screen, text) {
    const el = screen.querySelector("#core-greet");
    if (!el) return;
    let i = 0;
    el.classList.remove("fading");
    el.innerHTML = "<span class='tw'></span><span class='caret'></span>";
    const tw = el.querySelector(".tw");
    const step = () => {
        if (el.classList.contains("fading")) return;
        i++;
        // 6 huruf terakhir ("Damar") masuk sebagai bagian tebal.
        const plain = text;
        const head = plain.slice(0, Math.min(i, plain.length - 6));
        const tail = i > plain.length - 6 ? `<b>${plain.slice(plain.length - 6)}</b>` : "";
        tw.innerHTML = esc(head) + tail;
        if (i < plain.length) setTimeout(step, 68);   // lambat & tenang
        else el.classList.add("typed");               // sembunyikan kursor
    };
    setTimeout(step, 600);
}

/** Sesi dimulai → sapaan lenyap PELAN (bukan hilang seketika). */
function fadeGreeting(screen) {
    const greet = screen.querySelector("#core-greet");
    const sub = screen.querySelector("#core-sub");
    if (greet && !greet.classList.contains("fading")) {
        greet.classList.add("fading");
        setTimeout(() => { greet.innerHTML = ""; greet.classList.remove("fading", "typed"); }, 2600);
    }
    if (sub && !sub.classList.contains("fading")) {
        sub.classList.add("fading");
    }
}

function renderCoreStats() {
    const el = document.getElementById("core-stats");
    if (!el) return;
    const s = store.get(), o = s.overview;
    const chip = (on, label, val) => `<span class="holo-chip${on ? "" : " off"}"><span class="d"></span>${esc(label)} <b>${esc(String(val))}</b></span>`;
    if (!s.connected || !o) { el.innerHTML = chip(false, "Daemon", "terputus"); return; }
    el.innerHTML =
        chip(true, "Daemon", shortHost(s.settings.daemonUrl))
        + chip(true, "CPU", Math.round(o.stats.cpu.usage) + "%")
        + chip(true, "RAM", Math.round(o.stats.memory.usedPercent) + "%")
        + chip(true, "Tools", o.tools.total)
        + chip(true, "Model", (o.ai.active ?? o.ai.defaultModel ?? "—").split("/").pop());
}

function teardownCore() {
    if (coreHolo) { holos.delete(coreHolo); coreHolo.destroy(); coreHolo = null; }
}

// =====================================================================
// Wake word — Damar selalu standby
// =====================================================================

function initWake() {
    wake = createWakeWord({
        onWake: () => {
            if (overlayOpen()) return;               // sudah dalam percakapan
            showWakeBadge();
            holoState("curious");                    // Damar tersapa → antusias
            greetAndListen();                        // orb menyapa + dengar; bubble muncul
        },
        onError: () => { /* diam: 'not-allowed' dll — fab manual tetap ada */ }
    });
    if (wake.available()) {
        try { wake.start(); } catch { /* butuh izin mic */ }
    }
}

let wakeBadgeTimer = null;
function showWakeBadge() {
    const b = $("#wake-badge");
    b.classList.add("show");
    clearTimeout(wakeBadgeTimer);
    wakeBadgeTimer = setTimeout(() => b.classList.remove("show"), 2600);
}

// =====================================================================
// Chrome (chip koneksi + status bar HUD)
// =====================================================================

function updateChrome() {

    const state = store.get();
    const chip = $("#connection-chip");

    if (state.connecting) {
        chip.innerHTML = `<span class="spinner"></span><span class="small muted">menyambung…</span>`;
    }
    else if (state.connected) {
        chip.innerHTML = pill(shortHost(state.settings.daemonUrl), "ok");
    }
    else {
        chip.innerHTML = pill("terputus", "danger");
    }

    if (currentAppId === "core") renderCoreStats();
    // Update status app IN-PLACE (jangan rebuild innerHTML tiap poll —
    // itu membuat semua kartu app berkedip tiap ~5 detik saat launcher
    // terbuka). renderHub() penuh hanya saat launcher dibuka.
    if ($("#launcher").classList.contains("open")) updateHubStatus();

    updateStatusBar(state);

    // Keadaan rem ikut disegarkan tiap poll: bila STOP ditarik dari
    // Telegram, CLI, atau perangkat lain, tombol di sini harus jujur.
    refreshSafety();
}

/** Bottom status bar — denyut sistem yang selalu terlihat. */
function updateStatusBar(state) {

    const bar = $("#statusbar");
    if (!bar) return;

    const o = state.overview;
    const online = state.connected;

    const seg = (cls, label, val) =>
        `<span class="seg ${cls}"><span class="d"></span><span class="lbl">${esc(label)}</span>${val != null ? `<span class="val">${esc(val)}</span>` : ""}</span>`;

    if (!online || !o) {
        bar.innerHTML = seg("off", "Daemon", "terputus")
            + `<span class="seg push"><span class="lbl">Damar OS</span></span>`;
        return;
    }

    const s = o.integrations.summary;
    bar.innerHTML =
        seg("on", "Daemon", shortHost(state.settings.daemonUrl))
        + seg(s.online >= s.enabled ? "on" : "off", "Runtime", `${s.online}/${s.enabled}`)
        + seg("", "CPU", `${Math.round(o.stats.cpu.usage)}%`)
        + seg("", "RAM", `${Math.round(o.stats.memory.usedPercent)}%`)
        + seg("", "Model", (o.ai.active ?? o.ai.defaultModel ?? "—").split("/").pop())
        + seg("", "Tools", o.tools.total)
        + seg("", "Uptime", durationShort(o.stats.daemon.uptime))
        + `<span class="seg push"><span class="lbl">Damar OS</span><span class="val">v${esc(o.daemon.version)}</span></span>`;
}

function durationShort(sec) {
    if (!Number.isFinite(sec)) return "—";
    const d = Math.floor(sec / 86400), h = Math.floor((sec / 3600) % 24), m = Math.floor((sec / 60) % 60);
    return d ? `${d}h ${h}j` : h ? `${h}j ${m}m` : `${m}m`;
}

function shortHost(url) {
    try { const p = new URL(url); return `${p.hostname}:${p.port || 80}`; }
    catch { return url; }
}

// =====================================================================
// Koneksi (dipertahankan dari versi sebelumnya)
// =====================================================================

async function connect() {

    clearTimeout(reconnectTimer);
    const settingsState = store.get().settings;
    api.configure({ baseUrl: settingsState.daemonUrl, token: settingsState.token });
    store.set({ connecting: true, lastError: null });
    updateChrome();

    try {
        const overview = await api.overview();
        store.set({ connected: true, connecting: false, lastError: null, overview });
        store.pushHistory(overview.stats.cpu.usage, overview.stats.memory.usedPercent);
        openEventStream();
        startPolling();
        holoState("idle");
        updateChrome();
        toast(`Terhubung ke ${shortHost(settingsState.daemonUrl)}`, "ok");
    }
    catch (error) {
        store.set({ connected: false, connecting: false, lastError: error.message });
        holoState("offline");
        updateChrome();
        toast(error.message, "danger", 5000);
        scheduleReconnect();
    }
}

function disconnect() {
    clearTimeout(reconnectTimer);
    stopPolling();
    api.disconnectEvents();
    store.set({ connected: false, connecting: false, overview: null, lastError: "diputuskan manual" });
    holoState("offline");
    updateChrome();
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!store.get().settings.autoConnect) return;
    reconnectTimer = setTimeout(connect, 8000);
}

function openEventStream() {
    api.connectEvents({
        onOpen: ({ backlog }) => {
            const state = store.get();
            state.logs = [...(backlog ?? [])];
            store.set({ logs: state.logs });
        },
        onLog: entry => store.pushLog(entry),
        onEvent: event => {
            store.pushLog({
                id: event.id, time: event.time, level: "event",
                message: `${event.type} ${summarize(event.payload)}`
            });
            if (event.type === "damar:present") presentMedia(event.payload);
            // Aktivitas multi-agent → orb agent di sekitar orb utama
            // (mendekat, menyalurkan energi, flash hasil).
            if (String(event.type ?? "").startsWith("orchestrator:")) {
                agentBus.ingest(event.type, event.payload);
            }
            // Damar Lab: event lab:* → mission control realtime.
            if (String(event.type ?? "").startsWith("lab:")) {
                document.dispatchEvent(new CustomEvent("damar:lab-event", {
                    detail: { ...event.payload, type: String(event.type).slice(4) }
                }));
            }
        },
        onError: () => { /* EventSource menyambung ulang sendiri */ }
    });
}

/**
 * Damar meminta sesuatu DITAMPILKAN (gambar/video/dokumen) atau
 * DIBUKA (url/terminal) — bukan sekadar dijawab dengan teks.
 *
 * Media kini tampil sebagai BUBBLE di dashboard Beranda (transien,
 * maks 3, umur 1 menit) DAN panel besar saat diklik. Path lokal
 * daemon dialihkan lewat endpoint /vision/raw agar renderer selalu
 * bisa memuatnya — inilah perbaikan "jendela kosong": sebelumnya
 * path/URL daemon tidak bisa diakses & gambar >2 MB dibuang.
 */
function presentMedia(p) {
    if (!p) return;

    if (p.kind === "url" && p.url) {
        window.damar?.shell?.open(p.url);
        return;
    }

    if (p.kind === "terminal") {
        navigate("runtime");
        toast(`Damar membuka terminal${p.command ? `: ${p.command}` : ""}`, "info");
        return;
    }

    // Media player (YouTube, Vimeo, SoundCloud) → embedded player
    if (p.kind === "youtube" || p.kind === "vimeo" || p.kind === "soundcloud") {
        presentPlayer(p);
        return;
    }

    if (p.kind === "stop") {
        stopPlayer();
        return;
    }

    // Laporan berupa TEKS (mis. hasil misi Lab) tidak punya URL untuk
    // dimuat — isinya sudah ikut di payload, jadi ia langsung dibuka.
    if (p.kind === "text") {
        showBubble({ kind: "chat", role: "assistant", text: p.title ?? "Laporan" });
        openPresentPanel(p);
        return;
    }

    // Chart live (TradingView) → popup mengambang beriframe.
    if (p.kind === "chart" && p.embedUrl) {
        openPresentPanel(p);
        return;
    }

    if (!["image", "video", "document", "audio"].includes(p.kind)) return;

    // --- Resolve URL yang BISA dimuat renderer ---------------------
    const src = resolveMediaSrc(p);

    // Langsung buka sebagai popup mengambang di posisi acak — TANPA
    // gelembung di dekat chat (mengganggu percakapan). Popup bisa
    // digeser ke mana saja.
    openPresentPanel(src ? { ...p, url: src } : p);
}

/**
 * Ubah sumber media menjadi URL yang bisa dimuat renderer:
 *   - http(s)/data: apa adanya;
 *   - path lokal daemon → streaming endpoint /vision/raw.
 * Mengembalikan null bila tidak ada sumber yang bisa dipakai.
 */
function resolveMediaSrc(p) {

    if (p.url && /^(https?:|data:)/i.test(p.url)) {
        // URL Immich butuh x-api-key yang tak bisa dikirim <img> →
        // lewatkan ke proksi daemon.
        const tok = api.token ? `&token=${encodeURIComponent(api.token)}` : "";

        // Aset foto: ambil id-nya (endpoint bervariasi antar versi —
        // /api/asset/file/ID, /api/assets/ID/original, dll). Proksi
        // pakai id + endpoint yang benar untuk versi Immich terpasang.
        const assetId = /^https?:/i.test(p.url)
            ? p.url.match(/\/api\/assets?\/(?:file\/)?([0-9a-fA-F-]{36})/)?.[1]
            : null;
        if (assetId) {
            return `${api.root}/vision/immich?id=${assetId}${tok}`;
        }

        // Thumbnail orang (endpoint people, bukan asset) → passthrough proksi.
        if (/\/api\/people\/[0-9a-fA-F-]{36}\/thumbnail/.test(p.url)) {
            return `${api.root}/vision/immich?url=${encodeURIComponent(p.url)}${tok}`;
        }

        return p.url;
    }

    const path = p.url ?? p.path;

    if (path && !/^[a-z]+:\/\//i.test(path)) {

        // Semua route /api/v1/console DI BELAKANG auth (app.js), jadi
        // <img>/<video> ke daemon WAJIB membawa token. Elemen media tak
        // bisa mengirim header Authorization → token lewat ?token=.
        // Tanpa ini gambar lokal (Immich/kamera) kena 401 dan tampil
        // BLANK/hanya judul, sedang gambar http/data langsung tetap muncul
        // — itu sebab "kadang muncul kadang blank".
        const tok = api.token ? `token=${encodeURIComponent(api.token)}` : "";

        // URL relatif daemon → absolut.
        if (path.startsWith("/")) {
            const sep = path.includes("?") ? "&" : "?";
            return tok ? `${api.root}${path}${sep}${tok}` : `${api.root}${path}`;
        }

        // Path lokal daemon → streaming endpoint.
        return `${api.root}/vision/raw?path=${encodeURIComponent(path)}${tok ? `&${tok}` : ""}`;

    }

    return null;

}

/**
 * Sebar popup ke posisi ACAK di layar, dijauhkan dari sisi kanan tempat
 * bubble chat & composer berada — layar lebar, jadi popup boleh muncul
 * di mana saja kecuali menutupi percakapan.
 */
function randomPopupPos(el) {
    const w = el.offsetWidth || 420;
    const h = el.offsetHeight || 300;
    // Batasi X ke ~58% kiri layar (kanan = area chat).
    const safeRight = window.innerWidth * 0.58 - w;
    const maxX = Math.max(20, Math.min(window.innerWidth - w - 20, safeRight));
    const maxY = Math.max(60, window.innerHeight - h - 40);
    const x = 20 + Math.random() * Math.max(0, maxX - 20);
    const y = 56 + Math.random() * Math.max(0, maxY - 56);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
}

/**
 * Geser `el` agar SELURUHNYA masuk viewport. Dipanggil setelah media
 * (gambar/video) selesai dimuat: popup membesar dari ukuran header,
 * dan kalau posisi acak tadi dekat tepi bawah, isinya bisa meluber ke
 * luar layar dan tampak "blank". Ini menariknya kembali ke dalam.
 */
function clampIntoView(el) {
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top;
    if (r.right  > window.innerWidth  - 12) left = window.innerWidth  - r.width  - 12;
    if (r.bottom > window.innerHeight - 12) top  = window.innerHeight - r.height - 12;
    el.style.left = `${Math.round(Math.max(12, left))}px`;
    el.style.top  = `${Math.round(Math.max(12, top))}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
}

/** Jadikan `el` bisa DIGESER dengan menyeret `handle`. */
function makeDraggable(el, handle) {
    if (!handle) return;
    let drag = null;
    handle.style.cursor = "grab";
    handle.addEventListener("pointerdown", e => {
        if (e.target.closest("button, a, input, video, iframe")) return;  // kontrol tetap berfungsi
        const r = el.getBoundingClientRect();
        el.style.right = "auto"; el.style.bottom = "auto";
        el.style.left = `${r.left}px`; el.style.top = `${r.top}px`;
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        handle.setPointerCapture(e.pointerId);
        handle.style.cursor = "grabbing";
    });
    handle.addEventListener("pointermove", e => {
        if (!drag) return;
        const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
        const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
        el.style.left = `${x}px`; el.style.top = `${y}px`;
    });
    handle.addEventListener("pointerup", e => {
        drag = null; handle.style.cursor = "grab";
        try { handle.releasePointerCapture(e.pointerId); } catch { /* abaikan */ }
    });
}

/**
 * Popup mengambang untuk foto/video/dokumen/teks. Dulu overlay fullscreen
 * dengan blur (foto memenuhi layar); kini JENDELA kecil yang bisa digeser,
 * muncul di posisi acak jauh dari chat. Beberapa boleh hidup bersamaan.
 */
function openPresentPanel(p) {

    const popup = document.createElement("div");
    popup.className = "damar-popup";

    const title = p.title ?? p.caption ??
        ({ image: "Foto", video: "Video", document: "Dokumen", text: "Catatan" }[p.kind] ?? "Media");

    let body = "";
    if (p.kind === "text") {
        body = `<div class="ap-text">${p.title ? `<h3>${esc(p.title)}</h3>` : ""}<div class="ap-text-body">${esc(p.text ?? "")}</div></div>`;
    }
    else if (p.kind === "image") {
        body = p.url
            ? `<img src="${esc(p.url)}" alt="" onerror="this.outerHTML='<div style=padding:40px;color:#ff6b6b>Gambar gagal dimuat</div>'" />`
            : `<div style="padding:40px;color:var(--warn)">Gambar tidak tersedia</div>`;
    }
    else if (p.kind === "video") {
        body = p.url
            ? `<video src="${esc(p.url)}" controls autoplay playsinline></video>`
            : `<div style="padding:40px;color:var(--warn)">Video tidak tersedia</div>`;
    }
    else if (p.kind === "audio") {
        body = p.url
            ? `<audio src="${esc(p.url)}" controls autoplay playsinline style="width:100%;max-width:520px"></audio>`
            : `<div style="padding:40px;color:var(--warn)">Audio tidak tersedia</div>`;
    }
    else if (p.kind === "document") {
        body = p.url
            ? `<iframe src="${esc(p.url)}" title="dokumen"></iframe>`
            : `<div style="padding:40px;color:var(--warn)">Dokumen tidak tersedia</div>`;
    }
    else if (p.kind === "chart") {
        body = p.embedUrl
            ? `<iframe src="${esc(p.embedUrl)}" title="chart" allowtransparency="true"
                    style="width:min(760px,84vw);height:60vh;border:0"></iframe>`
            : `<div style="padding:40px;color:var(--warn)">Chart tidak tersedia</div>`;
    }
    else {
        return;
    }

    const caption = (p.caption && p.caption !== title)
        ? `<div class="pp-caption">${esc(p.caption)}</div>` : "";

    popup.innerHTML = `
        <div class="pp-header">
            <div class="pp-title">${esc(title)}</div>
            <button class="pp-close" title="Tutup">✕</button>
        </div>
        <div class="pp-body">${body}</div>
        ${caption}
    `;

    document.body.appendChild(popup);
    popup.querySelector(".pp-close").addEventListener("click", () => popup.remove());
    makeDraggable(popup, popup.querySelector(".pp-header"));

    // Posisi acak awal, lalu tarik ke dalam layar setelah media dimuat
    // (ukuran popup baru pasti begitu gambar/video siap).
    requestAnimationFrame(() => { randomPopupPos(popup); popup.classList.add("show"); });

    const media = popup.querySelector("img, video, iframe");
    if (media) {
        const fix = () => clampIntoView(popup);
        media.addEventListener("load", fix, { once: true });
        media.addEventListener("loadedmetadata", fix, { once: true });
    }
}

/**
 * Embedded media player untuk YouTube/Vimeo/SoundCloud.
 * Muncul sebagai panel mengambang di kanan bawah (seperti mini player).
 */
function presentPlayer(p) {

    // Hapus player lama bila ada
    stopPlayer();

    const player = document.createElement("div");
    player.id = "damar-player";
    player.className = "damar-player";

    // URL yang BOLEH di-iframe. YouTube menolak /watch?v= (ERR_BLOCKED_BY_
    // RESPONSE lewat frame-ancestors) — hanya /embed/ID yang boleh. Itu
    // sebab jendela hitam walau judul lagu sudah ada. Bangun bentuk embed
    // dari videoId; sumber lain sudah kirim embedUrl-nya sendiri.
    const ytId = p.videoId
        ?? (typeof p.url === "string" ? (p.url.match(/[?&]v=([\w-]{6,})/)?.[1] ?? null) : null);
    // youtube-nocookie: domain privacy-enhanced yang lebih longgar soal
    // pembatasan embed/referrer — sering menghilangkan "error 153 /
    // configure error" yang muncul di www.youtube.com dari dalam
    // Electron. playsinline+modestbranding menstabilkan pemutaran.
    const embedUrl = p.embedUrl
        ?? (p.kind === "youtube" && ytId
            ? `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=${p.autoplay ? 1 : 0}&rel=0&playsinline=1&modestbranding=1`
            : p.url);
    const title = p.title ?? "Media Player";
    const channel = p.channel ?? "";

    // URL asli untuk jalur kabur. Bila iframe YouTube gagal (error 153:
    // pembatasan embed/origin — renderer dimuat dari file:// jadi origin
    // null, sebagian video menolak diputar dari sana), tombol "buka di
    // browser" memakai jalur yang PASTI jalan: shell.open ke Chrome.
    const extUrl = (p.kind === "youtube" && ytId)
        ? `https://www.youtube.com/watch?v=${ytId}`
        : (typeof p.url === "string" ? p.url : null);

    // HANYA URL sematan yang boleh masuk iframe. Bila embedUrl ternyata
    // halaman penuh (mis. youtube.com/results?search_query=… atau /watch),
    // memuatnya di iframe menampilkan halaman pencarian YouTube mentah —
    // beriklan, disandbox, tak memutar apa pun. Itulah "jendela pemutar
    // error" yang terlihat. Tolak: tampilkan pesan + tombol buka-browser.
    const embeddable = typeof embedUrl === "string" &&
        /(youtube(-nocookie)?\.com\/embed\/|player\.vimeo\.com\/|w\.soundcloud\.com\/player|open\.spotify\.com\/embed)/.test(embedUrl);

    // Media diputar di <video> native dari berkas LOKAL daemon (mediaId),
    // bukan URL googlevideo langsung — memutar googlevideo dari <video>
    // memicu 429 + macet. Daemon sudah mengunduhnya sekali; di sini kita
    // arahkan <video> ke /media/<id> daemon (token lewat query karena
    // <video> tak bisa kirim header Authorization). Embed jadi cadangan.
    const streamUrl = p.mediaId
        ? `${api.root}/media/${encodeURIComponent(p.mediaId)}?token=${encodeURIComponent(api.token || "")}`
        : ((typeof p.streamUrl === "string" && p.streamUrl.startsWith("http")) ? p.streamUrl : null);

    const frameInner = streamUrl
        ? `<video src="${esc(streamUrl)}" controls autoplay playsinline preload="auto"
                style="width:100%;height:100%;background:#000;">
           </video>`
        : embeddable
            ? `<iframe src="${esc(embedUrl)}"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen
                    style="width:100%;height:100%;border:0;">
               </iframe>`
            : `<div class="ap-error" style="display:grid;place-items:center;height:100%;padding:24px;text-align:center;color:var(--warn);font-size:13px;line-height:1.5">
                    Media ini tak bisa disematkan di sini.${extUrl ? "<br>Klik ⧉ di atas untuk membukanya di browser." : ""}
               </div>`;

    player.innerHTML = `
        <div class="ap-header">
            <div class="ap-info">
                <div class="ap-title">${esc(title)}</div>
                ${channel ? `<div class="ap-channel">${esc(channel)}</div>` : ""}
            </div>
            <div class="ap-controls">
                ${extUrl ? `<button class="ap-ext" title="Buka di browser">⧉</button>` : ""}
                <button class="ap-min" title="Minimize">−</button>
                <button class="ap-close" title="Tutup">✕</button>
            </div>
        </div>
        <div class="ap-frame">
            ${frameInner}
        </div>
    `;

    document.body.appendChild(player);

    // Wire controls
    player.querySelector(".ap-close").addEventListener("click", stopPlayer);
    player.querySelector(".ap-min").addEventListener("click", () => {
        player.classList.toggle("minimized");
    });
    const extBtn = player.querySelector(".ap-ext");
    if (extBtn && extUrl) {
        extBtn.addEventListener("click", () => {
            try { window.damar?.shell?.open(extUrl); } catch { /* abaikan */ }
        });
    }

    // Bisa DIGESER lewat header, dan muncul di posisi ACAK (bukan lagi
    // terpaku kanan-bawah dekat chat). Helper dipakai bersama popup lain.
    makeDraggable(player, player.querySelector(".ap-header"));

    requestAnimationFrame(() => {
        randomPopupPos(player);
        player.classList.add("show");
    });

}

function stopPlayer() {
    const existing = document.getElementById("damar-player");
    if (existing) existing.remove();
}

function summarize(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.id && payload.status) return `${payload.id} → ${payload.status.online ? "online" : "offline"}`;
    if (payload.tool) return `${payload.tool}${payload.error ? ` (${payload.error})` : ""}`;
    return Object.entries(payload).slice(0, 3).map(([k, v]) => `${k}=${typeof v === "object" ? "…" : v}`).join(" ");
}

function startPolling() {
    stopPolling();
    const interval = store.get().settings.pollInterval ?? 5000;
    pollTimer = setInterval(async () => {
        try {
            const overview = await api.overview();
            store.set({ overview, connected: true, lastError: null });
            store.pushHistory(overview.stats.cpu.usage, overview.stats.memory.usedPercent);
            updateChrome();
        }
        catch (error) {
            store.set({ connected: false, lastError: error.message });
            stopPolling();
            api.disconnectEvents();
            holoState("offline");
            updateChrome();
            toast("Koneksi ke daemon terputus", "warn");
            scheduleReconnect();
        }
    }, interval);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// =====================================================================
// Bootstrap
// =====================================================================

async function main() {

    buildTitlebar();
    buildLauncher();

    // Ctrl+K → launcher (pencarian/nav terpadu). Escape → tutup.
    document.addEventListener("keydown", e => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); toggleLauncher(); }
        if (e.key === "Escape") closeLauncher();
    });

    // Pintasan mengambang: simbol SVG STATIS, bukan hologram WebGL.
    // Orb 3D di sini menyalakan scene GPU kedua yang animasi terus —
    // beban besar untuk pintasan yang sekadar tombol. Simbol diam sudah
    // cukup. fabHolo dibiarkan null; refreshHoloPower & kode lain sudah
    // menjaga kasus null.
    $("#holo-fab").innerHTML = brandMark(24);

    // Jeda/lanjut entitas saat overlay dibuka/ditutup (hemat daya).
    document.addEventListener("damar:overlay", refreshHoloPower);

    // Hemat GPU: saat jendela Console TIDAK fokus (pengguna di app lain),
    // hentikan semua animasi hologram. Saat fokus kembali, kembalikan ke
    // keadaan semestinya. Ini memangkas beban GPU jadi nol ketika Console
    // sekadar terbuka di latar.
    window.addEventListener("blur", () => { for (const h of holos) h.pause(); });
    window.addEventListener("focus", () => refreshHoloPower());

    // Orb fab (di app non-Beranda) → sapaan + sesi dengar; bubble chat
    // muncul di kanan dan interaksi tetap lewat input dashboard.
    $("#holo-fab").addEventListener("click", () => {
        goHome();
        setTimeout(() => greetAndListen(), 120);
    });

    const saved = await window.damar.settings.get();
    store.set({ settings: saved });
    api.configure({ baseUrl: saved.daemonUrl, token: saved.token });

    window.damar.daemon.onOutput(({ channel, text }) => {
        for (const line of text.split(/\r?\n/)) {
            if (line.trim()) {
                store.pushLog({
                    id: Date.now(), time: new Date().toISOString(),
                    level: channel === "stderr" ? "error" : "info", message: `[daemon] ${line}`
                });
            }
        }
    });

    window.damar.daemon.onExit(({ code }) => {
        store.patch("localDaemon", { running: false, pid: null });
        toast(`Daemon lokal berhenti (kode ${code})`, "warn");
    });

    document.addEventListener("damar:reconnect", () => connect());

    navigate(location.hash.slice(1) || "core");
    updateChrome();

    initWake();

    if (saved.autoConnect) connect();
}

main();
