import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, pill, toast } from "../lib/ui.js";
// "Terhubung" diserap ke Pengaturan: Perangkat + Integrasi jadi kategori.
import { devices } from "./devices.js";
import { integrations } from "./integrations.js";

export const settings = {

    id: "settings",
    label: "Settings",
    icon: "settings",
    title: "Settings",
    subtitle: "Koneksi ke daemon dan kendali proses lokal.",

    render(root) {

        const s = store.get().settings;

        const local = store.get().localDaemon;

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Settings</h1>
                    <p>Koneksi ke daemon dan kendali proses lokal.</p>
                </div>
            </div>

            <div class="grid cols-2">

                <div class="panel">
                    <div class="panel-head"><h2>${icon("plug")} Koneksi daemon</h2></div>

                    <div class="stack">

                        <div class="field">
                            <label>Alamat daemon</label>
                            <input type="url" id="set-url" value="${esc(s.daemonUrl)}"
                                placeholder="http://192.168.1.10:3000">
                            <span class="help">
                                Pakai <span class="mono">localhost</span> bila daemon jalan di perangkat ini,
                                atau IP LAN PC rumah bila memantau dari laptop.
                            </span>
                        </div>

                        <div class="field">
                            <label>Token akses</label>
                            <input type="password" id="set-token" value="${esc(s.token)}"
                                placeholder="kosongkan bila DAMAR_TOKEN tidak diset">
                            <span class="help">
                                Harus sama dengan <span class="mono">DAMAR_TOKEN</span> di
                                <span class="mono">.env</span> daemon. Tanpa token, siapa pun
                                di jaringan yang sama bisa mengakses API.
                            </span>
                        </div>

                        <div class="field">
                            <label>Interval polling</label>
                            <select id="set-poll">
                                ${[2000, 5000, 10000, 30000].map(ms => `
                                    <option value="${ms}" ${ms === s.pollInterval ? "selected" : ""}>
                                        ${ms / 1000} detik
                                    </option>`).join("")}
                            </select>
                        </div>

                        <label class="switch">
                            <input type="checkbox" id="set-auto" ${s.autoConnect ? "checked" : ""}>
                            <span class="track"></span>
                            <span>Sambung otomatis saat Console dibuka</span>
                        </label>

                        <div class="row">
                            <button class="btn primary" id="set-save">${icon("check")} Simpan &amp; sambungkan</button>
                        </div>

                    </div>
                </div>

                <div class="stack">

                    <div class="panel">
                        <div class="panel-head">
                            <h2>${icon("server")} Daemon lokal</h2>
                            <span class="hint push" id="local-state">
                                ${local.running ? `berjalan (pid ${local.pid})` : "berhenti"}
                            </span>
                        </div>

                        <div class="small muted" style="margin-bottom:10px">
                            Menjalankan <span class="mono">src/server.js</span> dari repo ini sebagai
                            proses anak. Berguna saat mengembangkan di laptop; di PC rumah
                            sebaiknya daemon dijalankan sebagai service tersendiri.
                        </div>

                        <div class="row">
                            <button class="btn" id="local-start">${icon("play")} Jalankan</button>
                            <button class="btn ghost" id="local-stop">${icon("stop")} Hentikan</button>
                        </div>

                        <div class="divider"></div>

                        <div class="small dim mono selectable" id="local-path">—</div>
                    </div>

                    <div class="panel">
                        <div class="panel-head"><h2>${icon("alert")} Catatan keamanan</h2></div>
                        <div class="small muted stack" style="gap:8px">
                            <p style="margin:0">
                                Daemon mendengarkan di <span class="mono">0.0.0.0</span>, jadi begitu
                                dijalankan di PC rumah ia terjangkau seluruh perangkat pada LAN yang sama.
                            </p>
                            <p style="margin:0">
                                Set <span class="mono selectable">DAMAR_TOKEN</span> di berkas
                                <span class="mono">.env</span> PC tersebut, lalu isikan token yang sama
                                di kolom di samping. Tanpa itu, endpoint chat, eksekusi tool, dan
                                filesystem terbuka tanpa autentikasi.
                            </p>
                        </div>
                    </div>

                </div>

            </div>

            <div id="set-daemon-config" class="stack" style="margin-top:14px"></div>`;

    },

    async mount(root) {

        const status = await window.damar.daemon.status();

        root.querySelector("#local-path").textContent = status.entry;

        const updateLocal = (running, pid) => {

            store.patch("localDaemon", { running, pid: pid ?? null });

            root.querySelector("#local-state").textContent =
                running ? `berjalan (pid ${pid})` : "berhenti";

        };

        updateLocal(status.running, status.pid);

        root.querySelector("#set-save").addEventListener("click", async () => {

            const patch = {
                daemonUrl: root.querySelector("#set-url").value.trim(),
                token: root.querySelector("#set-token").value,
                pollInterval: Number(root.querySelector("#set-poll").value),
                autoConnect: root.querySelector("#set-auto").checked
            };

            const saved = await window.damar.settings.set(patch);

            store.set({ settings: saved });

            toast("Pengaturan disimpan", "ok");

            document.dispatchEvent(new CustomEvent("damar:reconnect"));

        });

        root.querySelector("#local-start").addEventListener("click", async () => {

            const result = await window.damar.daemon.start();

            if (result.error) {
                toast(result.error, "danger");
                return;
            }

            // Daemon lain sudah hidup di alamat ini — Console tidak
            // menjalankan proses kedua, cukup menyambung.
            if (result.external) {

                updateLocal(false, null);

                toast("Daemon sudah berjalan di alamat ini — menyambungkan…", "ok");

                document.dispatchEvent(new CustomEvent("damar:reconnect"));

                return;

            }

            updateLocal(true, result.pid);

            toast(
                result.alreadyRunning
                    ? "Daemon lokal sudah berjalan"
                    : `Daemon lokal dijalankan (pid ${result.pid})`,
                "ok"
            );

            // Beri jeda agar server sempat listen sebelum disambung.
            setTimeout(
                () => document.dispatchEvent(new CustomEvent("damar:reconnect")),
                1800
            );

        });

        root.querySelector("#local-stop").addEventListener("click", async () => {

            await window.damar.daemon.stop();

            updateLocal(false, null);

            toast("Daemon lokal dihentikan", "warn");

        });

        // Panel konfigurasi daemon (AI provider + Telegram) butuh
        // koneksi; muat setelah panel dasar siap.
        await renderDaemonConfig(root);

    }

};

/**
 * Panel yang mengonfigurasi DAEMON (bukan Console): platform AI +
 * API key, dan Telegram. Hanya bisa dimuat saat terhubung.
 */
async function renderDaemonConfig(root) {

    const host = root.querySelector("#set-daemon-config");

    if (!store.get().connected) {
        host.innerHTML = `
            <div class="panel"><div class="small dim">
                ${icon("plug")} Sambungkan ke daemon dulu untuk mengatur provider AI &amp; Telegram.
            </div></div>`;
        return;
    }

    // Control-Panel: grid kategori (bukan tumpukan panel yang panjang).
    renderCategoryGrid(root);
}

/**
 * Kategori Control-Panel. Tiap kategori punya sumber data + panel +
 * wiring yang sudah ada — di sini hanya diorganisir jadi kartu ikon
 * ala Control Panel Windows: klik kartu → buka panelnya, tak perlu
 * scroll melewati semua panel sekaligus.
 */
const CATEGORIES = [
    { id: "ai",         label: "AI & Model",       icon: "cpu",      desc: "Provider, API key, model" },
    { id: "voice",      label: "Suara",            icon: "mic",      desc: "STT, TTS, suara Damar" },
    { id: "home",       label: "Rumah & Perangkat",icon: "home",     desc: "Home Assistant" },
    { id: "people",     label: "Orang & Wajah",    icon: "search",   desc: "Pengenalan wajah" },
    { id: "channels",   label: "WhatsApp & Telegram", icon: "plug",  desc: "Kanal percakapan" },
    { id: "crypto",     label: "Crypto (Binance)", icon: "activity", desc: "Trading, monitor, API" },
    { id: "automation", label: "Otomasi",          icon: "activity", desc: "Brief harian terjadwal" },
    { id: "roles",      label: "Peran Agen",       icon: "grid",     desc: "Peran & spesialisasi" },
    // Diserap dari app "Terhubung".
    { id: "devices",      label: "Perangkat",   icon: "plug", desc: "Perangkat terhubung" },
    { id: "integrations", label: "Integrasi",   icon: "grid", desc: "OpenClaw, Hermes, dll" }
];

/** Ambil data + panel + wiring untuk satu kategori. */
async function categoryContent(catId, root) {
    switch (catId) {
        case "ai": {
            const cfg = await api.request("/ai/config");
            return { html: aiPanel(cfg), wire: () => wireAiPanel(root, cfg) };
        }
        case "voice": {
            const v = await api.voiceConfig();
            return { html: voicePanel(v), wire: () => wireVoicePanel(root) };
        }
        case "home": {
            const h = await api.homeStatus().catch(() => null);
            return { html: homePanel(h), wire: () => wireHomePanel(root) };
        }
        case "people": {
            const p = await api.request("/people/status").catch(() => null);
            return { html: peoplePanel(p), wire: () => wirePeoplePanel(root) };
        }
        case "channels": {
            const tg = await api.request("/whatsapp/status").catch(() => null);
            return { html: whatsappPanel(tg), wire: () => wireWhatsappPanel(root) };
        }
        case "crypto": {
            const c = await api.cryptoConfig().catch(() => null);
            return { html: cryptoPanel(c), wire: () => wireCryptoPanel(root) };
        }
        case "automation": {
            const a = await api.request("/automation/status").catch(() => null);
            return { html: automationPanel(a), wire: () => wireAutomationPanel(root) };
        }
        case "roles": {
            const r = await api.request("/roles").catch(() => null);
            return { html: rolesPanel(r), wire: () => wireRolesPanel(root) };
        }
        // Kategori yang memuat VIEW penuh (dari app Terhubung).
        case "devices":      return { view: devices };
        case "integrations": return { view: integrations };
        default:
            return { html: `<div class="panel"><div class="small dim">Kategori tak dikenal.</div></div>`, wire: () => {} };
    }
}

function renderCategoryGrid(root) {
    const host = root.querySelector("#set-daemon-config");
    host.innerHTML = `
        <div class="panel">
            <div class="panel-head"><h2>${icon("gear")} Kontrol Panel</h2>
                <span class="hint push">Pilih kategori pengaturan</span></div>
            <div class="cp-grid">
                ${CATEGORIES.map(c => `
                    <button class="cp-card" data-cat="${c.id}">
                        <span class="cp-ico">${icon(c.icon)}</span>
                        <span class="cp-lab">${esc(c.label)}</span>
                        <span class="cp-desc">${esc(c.desc)}</span>
                    </button>`).join("")}
            </div>
        </div>`;
    host.querySelectorAll(".cp-card").forEach(b =>
        b.addEventListener("click", () => openCategory(root, b.dataset.cat)));
}

async function openCategory(root, catId) {
    const host = root.querySelector("#set-daemon-config");
    const cat = CATEGORIES.find(c => c.id === catId);
    host.innerHTML = `
        <div class="cp-detail-bar">
            <button class="btn ghost sm" id="cp-back">← Kembali</button>
            <h2 style="margin:0 0 0 10px">${icon(cat?.icon ?? "gear")} ${esc(cat?.label ?? "Pengaturan")}</h2>
        </div>
        <div id="cp-detail"><div class="panel"><div class="row">
            <span class="spinner"></span><span class="small muted">Memuat…</span></div></div></div>`;
    host.querySelector("#cp-back").addEventListener("click", () => renderCategoryGrid(root));

    try {
        const content = await categoryContent(catId, root);
        const detail = host.querySelector("#cp-detail");
        if (content.view) {
            // View penuh (Perangkat/Integrasi) — render + mount seperti app.
            detail.innerHTML = "";
            content.view.render(detail);
            await content.view.mount?.(detail);
        }
        else {
            detail.innerHTML = content.html;
            content.wire?.();
        }
    }
    catch (error) {
        host.querySelector("#cp-detail").innerHTML =
            `<div class="panel"><div class="empty">${icon("alert")}<div class="danger-text">${esc(error.message)}</div></div></div>`;
    }
}

function aiPanel(cfg) {

    const isLocal = cfg.active === "ollama";

    const fellBack = cfg.resolved.fellBackFrom;

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("cpu")} Provider AI</h2>
                <span class="push">${pill(
                    `aktif: ${cfg.resolved.label}`,
                    cfg.resolved.kind === "ollama" ? "warn" : "ok"
                )}</span>
            </div>

            <div class="small muted" style="margin-bottom:6px">
                Pilih otak Damar: <strong>AI Lokal</strong> (Ollama — gratis, privat,
                jalan di mesin sendiri) atau <strong>AI Provider</strong> (cloud pakai
                API key). Kosongkan key &amp; simpan untuk balik ke AI Lokal.
                ${fellBack ? `<span class="warn-text"> (key ${esc(fellBack)} kosong, sekarang pakai AI Lokal)</span>` : ""}
            </div>

            <div class="seg" id="ai-mode">
                <button type="button" data-mode="ollama" class="${isLocal ? "active" : ""}">
                    ${icon("server")} AI Lokal</button>
                <button type="button" data-mode="provider" class="${isLocal ? "" : "active"}">
                    ${icon("cloud")} AI Provider</button>
            </div>

            <div id="ai-provider-fields"></div>

            <div class="row" style="margin-top:10px">
                <button class="btn primary" id="ai-save">${icon("check")} Simpan &amp; terapkan</button>
                <span class="small dim">langsung dipakai tanpa restart</span>
            </div>
        </div>`;

}

/** Penanda status model di dropdown: ✓ terverifikasi, ⚠ preview/eksperimental. */
function modelGlyph(m) {
    if (m.status === "verified") return "✓ ";
    if (m.tier === "preview" || m.tier === "experimental") return "⚠ ";
    return "";
}

/** Kolom Model: dropdown terisi lewat "Muat", dengan opsi ketik manual. */
function modelField(currentModel) {

    return `
        <div class="field">
            <label>Model</label>
            <div class="row" style="gap:6px">
                <select id="ai-model" style="flex:1">
                    <option value="">— pilih model —</option>
                    ${currentModel ? `<option value="${esc(currentModel)}" selected>${esc(currentModel)}</option>` : ""}
                    <option value="__manual__">✎ ketik manual…</option>
                </select>
                <button type="button" class="btn ghost sm" id="ai-load-models">${icon("refresh")} Muat</button>
                <button type="button" class="btn ghost sm" id="ai-verify-models">${icon("check")} Verifikasi</button>
            </div>
            <input type="text" id="ai-model-manual" style="display:none;margin-top:6px"
                value="${esc(currentModel ?? "")}" placeholder="nama model, mis. gpt-4o-mini">
            <span class="help" id="ai-model-help">Tekan <strong>Muat</strong> untuk daftar model.
                <strong>Verifikasi</strong> menguji tiap model (pakai kuota) &amp; menandai ✓ yang benar-benar bisa dipakai.</span>
        </div>`;

}

function voicePanel(v) {

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("mic")} Suara (STT &amp; TTS)</h2>
                <span class="push">${pill(
                    v.tts.configured ? "TTS neural" : "suara OS",
                    v.tts.configured ? "ok" : "idle"
                )}</span>
            </div>

            <div class="small muted" style="margin-bottom:10px">
                <strong>Suara masuk (STT):</strong> endpoint transcribe kompatibel-OpenAI
                (mis. faster-whisper-server) agar mic bisa mengetik ucapan.<br>
                <strong>Suara keluar (TTS):</strong> endpoint /v1/audio/speech
                (mis. <span class="mono">Kokoro-FastAPI</span>) untuk banyak suara &amp;
                bahasa Indonesia. Kosong → pakai suara OS.
            </div>

            <div class="divider" style="margin:6px 0"></div>
            <div class="small dim" style="margin-bottom:6px">Suara masuk — STT</div>
            <div class="grid cols-3" style="gap:10px">
                <div class="field"><label>Endpoint</label>
                    <input type="url" id="stt-url" value="${esc(v.stt.url)}"
                        placeholder="http://localhost:8000/v1/audio/transcriptions"></div>
                <div class="field"><label>Model</label>
                    <input type="text" id="stt-model" value="${esc(v.stt.model)}"
                        placeholder="Systran/faster-whisper-base"></div>
                <div class="field"><label>API key ${v.stt.hasKey ? `<span class="dim">(${esc(v.stt.keyHint)})</span>` : ""}</label>
                    <input type="password" id="stt-key" placeholder="opsional"></div>
            </div>

            <div class="divider" style="margin:12px 0 6px"></div>
            <div class="small dim" style="margin-bottom:6px">Suara keluar — TTS neural</div>
            <div class="grid cols-4" style="gap:10px">
                <div class="field" style="grid-column:span 2"><label>Endpoint</label>
                    <input type="url" id="tts-url" value="${esc(v.tts.url)}"
                        placeholder="http://localhost:8880/v1/audio/speech"></div>
                <div class="field"><label>Model</label>
                    <input type="text" id="tts-model" value="${esc(v.tts.model)}" placeholder="kokoro"></div>
                <div class="field"><label>Voice
                    <button type="button" class="btn ghost sm" id="tts-load-voices" style="margin-left:6px">${icon("refresh")} Muat daftar</button></label>
                    <input type="text" id="tts-voice" list="tts-voice-list" value="${esc(v.tts.voice)}" placeholder="af_heart / id_...">
                    <datalist id="tts-voice-list"></datalist>
                    <div class="small dim" id="tts-voice-hint">Klik "Muat daftar" untuk menarik suara dari container TTS.</div>
                </div>
                <div class="field" style="grid-column:span 2"><label>API key ${v.tts.hasKey ? `<span class="dim">(${esc(v.tts.keyHint)})</span>` : ""}</label>
                    <input type="password" id="tts-key" placeholder="opsional"></div>
            </div>

            <div class="row" style="margin-top:10px">
                <button class="btn primary" id="voice-save">${icon("check")} Simpan suara</button>
                <span class="small dim">efek robot diatur di layar Damar</span>
            </div>
        </div>`;

}

function wireVoicePanel(root) {

    // Muat daftar suara dari container TTS (bukan suara OS). Datalist
    // membuatnya bisa dipilih sekaligus tetap boleh diketik.
    root.querySelector("#tts-load-voices")?.addEventListener("click", async () => {
        const hint = root.querySelector("#tts-voice-hint");
        const dl = root.querySelector("#tts-voice-list");
        hint.textContent = "Memuat…";
        try {
            const r = await api.voiceVoices();
            dl.innerHTML = (r.voices ?? []).map(v => `<option value="${esc(v.id)}">${esc(v.name ?? v.id)}</option>`).join("");
            hint.textContent = r.voices?.length
                ? `${r.voices.length} suara dari ${r.source === "neural" ? "container" : "konfigurasi"} (${esc(r.url ?? "")}). ` +
                  (r.source === "configured" ? "Container ini tak menyediakan daftar — arahkan URL ke Kokoro (8880) untuk banyak suara." : "Ketik/pilih lalu Simpan.")
                : "Tidak ada suara — pastikan URL TTS benar dan container hidup.";
        }
        catch (e) { hint.textContent = `Gagal memuat: ${e.message}`; }
    });

    root.querySelector("#voice-save").addEventListener("click", async () => {

        const val = id => root.querySelector(id).value.trim();

        const body = {
            stt: { url: val("#stt-url"), model: val("#stt-model") },
            tts: { url: val("#tts-url"), model: val("#tts-model"), voice: val("#tts-voice") }
        };

        // Hanya kirim key bila diisi (biar tak menimpa yang tersimpan).
        const sttKey = root.querySelector("#stt-key").value;
        const ttsKey = root.querySelector("#tts-key").value;
        if (sttKey) body.stt.key = sttKey;
        if (ttsKey) body.tts.key = ttsKey;

        try {
            await api.saveVoiceConfig(body);
            toast("Konfigurasi suara disimpan", "ok");
            await renderDaemonConfig(root);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }

    });

}

function cryptoPanel(c) {
    c = c || { hasKey: false, hasSecret: false, testnet: false, proxyUrl: null, configured: false };
    return `
    <div class="panel">
        <div class="panel-head"><h2>${icon("plug")} Crypto — Binance</h2></div>
        <div class="panel-body">
            <div class="small dim" style="margin-bottom:8px">
                Pantau &amp; eksekusi crypto. API key butuh izin BACA (dan izin TRADE bila mau eksekusi).
                api.binance.com sering diblokir di Indonesia (403) — set Proxy untuk saldo/eksekusi;
                harga tetap jalan tanpa proxy.
            </div>
            <label>API Key ${c.hasKey ? `<span class="small dim">(tersimpan: ${esc(c.keyHint || "")})</span>` : ""}
                <input type="password" id="bn-key" placeholder="${c.hasKey ? "•••• (kosongkan agar tak berubah)" : "API key Binance"}"></label>
            <label>Secret ${c.hasSecret ? `<span class="small dim">(tersimpan)</span>` : ""}
                <input type="password" id="bn-secret" placeholder="${c.hasSecret ? "•••• (kosongkan agar tak berubah)" : "API secret"}"></label>
            <label>Proxy URL <span class="small dim">(opsional — untuk saldo/eksekusi lewat region diizinkan)</span>
                <input type="text" id="bn-proxy" value="${esc(c.proxyUrl || "")}" placeholder="http://user:pass@host:port"></label>
            <label class="switch"><input type="checkbox" id="bn-testnet" ${c.testnet ? "checked" : ""}> <span>Testnet</span></label>
            <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn primary" id="bn-save">${icon("check")} Simpan</button>
                <button class="btn ghost" id="bn-test">${icon("refresh")} Test koneksi</button>
            </div>
            <div class="small dim" id="bn-status" style="margin-top:8px">${c.configured ? "Terkonfigurasi." : "Belum dikonfigurasi."}</div>
        </div>
    </div>`;
}

function wireCryptoPanel(root) {
    root.querySelector("#bn-save")?.addEventListener("click", async () => {
        const body = {
            proxyUrl: root.querySelector("#bn-proxy").value.trim() || null,
            testnet: root.querySelector("#bn-testnet").checked
        };
        // Hanya kirim key/secret bila diisi — biar tak menimpa yang tersimpan.
        const key = root.querySelector("#bn-key").value.trim();
        const secret = root.querySelector("#bn-secret").value.trim();
        if (key) body.apiKey = key;
        if (secret) body.secret = secret;
        try {
            await api.saveCryptoConfig(body);
            toast("Konfigurasi Binance disimpan", "ok");
            await renderDaemonConfig(root);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }
    });

    root.querySelector("#bn-test")?.addEventListener("click", async () => {
        const el = root.querySelector("#bn-status");
        el.textContent = "Menguji…";
        try {
            const s = await api.cryptoStatus();
            const parts = [`Harga publik: ${s.public ? `OK (BTC $${s.btcUsdt})` : "GAGAL"}`];
            if (s.configured) parts.push(`Akun: ${s.account ? `OK (${s.spotAssets} aset)` : `GAGAL — ${s.accountError || ""}`}`);
            else parts.push("Akun: belum ada API key");
            if (s.hint) parts.push(s.hint);
            el.textContent = parts.join(" · ");
        }
        catch (error) {
            el.textContent = "Gagal: " + error.message;
        }
    });
}

function homePanel(h) {

    const online = h?.health?.online;

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("home")} Rumah (Home Assistant)</h2>
                <span class="push">${pill(
                    !h?.configured ? "belum diatur" : (online ? "tersambung" : "offline"),
                    !h?.configured ? "idle" : (online ? "ok" : "danger")
                )}</span>
            </div>

            <div class="small muted" style="margin-bottom:10px">
                Sambungkan ke Home Assistant untuk mengendalikan lampu, AC, saklar,
                Sonoff, Zigbee, dll. Token = <em>long-lived access token</em> dari
                profil HA-mu. Disimpan lokal (gitignored).
            </div>

            <div class="grid cols-2" style="gap:10px">
                <div class="field">
                    <label>URL Home Assistant</label>
                    <input type="url" id="ha-url" value="${esc(h?.url ?? "")}"
                        placeholder="http://192.168.1.10:8123">
                </div>
                <div class="field">
                    <label>Token ${h?.hasToken ? `<span class="dim">(${esc(h.tokenHint)})</span>` : ""}</label>
                    <input type="password" id="ha-token" placeholder="${h?.hasToken ? "isi untuk mengganti" : "long-lived access token"}">
                </div>
            </div>
            ${h?.health?.error && h?.configured ? `<div class="small danger-text" style="margin-top:6px">${esc(h.health.error)}</div>` : ""}
            <div class="row" style="margin-top:10px">
                <button class="btn primary" id="ha-save">${icon("check")} Simpan &amp; sambungkan</button>
            </div>
        </div>`;

}

function wireHomePanel(root) {

    const btn = root.querySelector("#ha-save");
    if (!btn) return;

    btn.addEventListener("click", async () => {

        const body = { url: root.querySelector("#ha-url").value.trim() };
        const token = root.querySelector("#ha-token").value.trim();
        if (token) body.token = token;

        try {
            await api.saveHomeConfig(body);
            const status = await api.homeStatus();
            toast(
                status.health?.online ? "Home Assistant tersambung ✅"
                    : (status.health?.error ?? "Tersimpan"),
                status.health?.online ? "ok" : "warn",
                5000
            );
            await renderDaemonConfig(root);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }

    });

}

function peoplePanel(p) {

    const im = p?.immich ?? {};
    const fc = p?.face ?? {};
    const online = im.health?.online;

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("camera")} Orang &amp; Wajah</h2>
                <span class="push">${pill(
                    !im.configured ? "Immich belum diatur" : (online ? "Immich tersambung" : "Immich offline"),
                    !im.configured ? "idle" : (online ? "ok" : "danger")
                )}</span>
            </div>

            <div class="small muted" style="margin-bottom:10px">
                <strong>Immich</strong> = galeri + pengenalan wajah bawaan: cari foto
                ("foto ibu", "saat ke Bandung"). <strong>Layanan wajah</strong> (CompreFace)
                = kenali siapa di CCTV secara langsung. Keduanya opsional.
            </div>

            <div class="small dim" style="margin-bottom:6px">Immich</div>
            <div class="grid cols-2" style="gap:10px">
                <div class="field"><label>URL Immich</label>
                    <input type="url" id="im-url" value="${esc(im.url ?? "")}" placeholder="http://192.168.1.10:2283"></div>
                <div class="field"><label>API key ${im.hasKey ? `<span class="dim">(${esc(im.keyHint)})</span>` : ""}</label>
                    <input type="password" id="im-key" placeholder="${im.hasKey ? "isi untuk ganti" : "API key Immich"}"></div>
            </div>
            <div class="row" style="margin-top:8px">
                <button class="btn primary sm" id="im-save">${icon("check")} Simpan Immich</button>
            </div>

            <div class="divider" style="margin:12px 0 6px"></div>
            <div class="small dim" style="margin-bottom:6px">Layanan wajah (CompreFace-compatible) — untuk CCTV</div>
            <div class="grid cols-2" style="gap:10px">
                <div class="field"><label>URL</label>
                    <input type="url" id="fc-url" value="${esc(fc.url ?? "")}" placeholder="http://localhost:8000"></div>
                <div class="field"><label>API key ${fc.hasKey ? `<span class="dim">(${esc(fc.keyHint)})</span>` : ""}</label>
                    <input type="password" id="fc-key" placeholder="${fc.hasKey ? "isi untuk ganti" : "recognition API key"}"></div>
            </div>
            <div class="row" style="margin-top:8px">
                <button class="btn primary sm" id="fc-save">${icon("check")} Simpan layanan wajah</button>
            </div>
        </div>`;

}

function wirePeoplePanel(root) {

    const im = root.querySelector("#im-save");
    if (im) im.addEventListener("click", async () => {
        const body = { url: root.querySelector("#im-url").value.trim() };
        const k = root.querySelector("#im-key").value.trim();
        if (k) body.key = k;
        try {
            await api.request("/people/immich", { method: "POST", body });
            const st = await api.request("/people/status");
            toast(st.immich?.health?.online ? "Immich tersambung ✅" : (st.immich?.health?.error ?? "Tersimpan"),
                st.immich?.health?.online ? "ok" : "warn", 5000);
            await renderDaemonConfig(root);
        }
        catch (error) { toast(error.message, "danger", 6000); }
    });

    const fc = root.querySelector("#fc-save");
    if (fc) fc.addEventListener("click", async () => {
        const body = { url: root.querySelector("#fc-url").value.trim() };
        const k = root.querySelector("#fc-key").value.trim();
        if (k) body.key = k;
        try {
            await api.request("/people/face", { method: "POST", body });
            toast("Layanan wajah disimpan", "ok");
            await renderDaemonConfig(root);
        }
        catch (error) { toast(error.message, "danger", 6000); }
    });

}

function whatsappPanel(wa) {

    const statusPill = wa.connected
        ? pill(wa.number ? `tersambung · ${wa.number}` : "tersambung", "ok")
        : (wa.available ? pill("belum tertaut", "idle") : pill("paket belum diinstall", "warn"));

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("send")} WhatsApp</h2>
                <span class="push">${statusPill}</span>
            </div>

            <div class="stack">
                ${!wa.available ? `<div class="small warn-text">Jalankan di folder proyek:
                    <span class="mono">npm install @whiskeysockets/baileys qrcode</span> lalu mulai ulang daemon.</div>` : ""}

                <div class="field">
                    <label>Pindai QR untuk menautkan</label>
                    <span class="help">Tekan <strong>Hubungkan</strong>, lalu di HP: WhatsApp →
                        <em>Perangkat Tertaut → Tautkan Perangkat</em> → pindai QR di bawah.</span>
                </div>
                <div id="wa-qr-box" style="display:${wa.qr && !wa.connected ? "block" : "none"};text-align:center;padding:8px">
                    <img id="wa-qr" src="${wa.qr ?? ""}" alt="QR WhatsApp"
                        style="width:260px;height:260px;background:#fff;border-radius:12px;padding:8px">
                    <div class="small dim">QR berlaku singkat — bila kedaluwarsa, tekan Hubungkan lagi.</div>
                </div>

                <div class="field">
                    <label>Nomor pribadi yang diizinkan</label>
                    <input type="text" id="wa-allowed" value="${esc((wa.allowed ?? []).join(", "))}"
                        placeholder="mis. 6281111, 6282222">
                    <span class="help">Kirim <span class="mono">/id</span> ke Damar untuk tahu nomormu. Pisahkan koma. Tanpa ini chat pribadi ditolak.</span>
                </div>
                <div class="field">
                    <div class="row" style="align-items:center">
                        <label style="flex:1">Grup tempat Damar tergabung</label>
                        <button type="button" class="btn ghost sm" id="wa-groups-refresh" ${wa.connected ? "" : "disabled"}>${icon("refresh")} Muat grup</button>
                    </div>
                    <div id="wa-groups-list" class="small dim" style="margin-top:6px">
                        ${wa.connected ? "Tekan \"Muat grup\" untuk melihat grup yang bisa diizinkan sekali klik." : "Hubungkan WhatsApp dulu untuk melihat daftar grup."}
                    </div>
                </div>
                <div class="field">
                    <label>Id grup (manual, opsional)</label>
                    <input type="text" id="wa-groups" value="${esc((wa.groups ?? []).join(", "))}"
                        placeholder="mis. 120363012345678901@g.us">
                    <span class="help">Biasanya cukup pakai tombol di atas. Manual bila grup belum muncul. Di grup, Damar menjawab saat di-mention (sebut <em>Damar</em>) atau di-reply.</span>
                </div>
                ${wa.lastError ? `<div class="small danger-text">${esc(wa.lastError)}</div>` : ""}
                <div class="small dim" style="line-height:1.7">
                    state: <span class="mono">${esc(wa.state ?? "idle")}</span> ·
                    registered: <span class="mono">${wa.registered ? "ya" : "belum"}</span> ·
                    reconnect: <span class="mono">${wa.reconnectAttempts ?? 0}</span>
                    ${wa.waVersion ? ` · WA v${esc(wa.waVersion)}` : ""}
                    ${wa.connectedAt ? `<br>tersambung: <span class="mono">${esc(wa.connectedAt)}</span>` : ""}
                    ${wa.lastDisconnect ? `<br>disconnect terakhir: <span class="mono">${esc(String(wa.lastDisconnect.code ?? "?"))}</span> ${esc((wa.lastDisconnect.reason ?? "").slice(0, 60))} <span class="dim">(${esc(wa.lastDisconnect.at)})</span>` : ""}
                </div>
                <div class="row">
                    <button class="btn primary" id="wa-save">${icon("check")} Simpan</button>
                    <button class="btn" id="wa-connect">${icon("plug")} Hubungkan / tampilkan QR</button>
                    <button class="btn ghost" id="wa-test" ${wa.connected ? "" : "disabled"}>${icon("send")} Kirim uji</button>
                    <button class="btn ghost danger" id="wa-logout" ${wa.connected ? "" : "disabled"}>${icon("x")} Putuskan</button>
                </div>
            </div>
        </div>`;

}

function providerFields(cfg, mode, platformId) {

    if (mode === "ollama") {
        const o = cfg.ollama;
        return `
            <div class="field">
                <label>Base URL Ollama</label>
                <input type="url" id="ai-baseurl" value="${esc(o.baseUrl)}" placeholder="http://localhost:11434">
            </div>
            ${modelField(o.model)}`;
    }

    const p = cfg.providers[platformId];

    return `
        <div class="field">
            <label>Platform</label>
            <select id="ai-platform">
                ${Object.keys(cfg.providers).map(pid =>
                    `<option value="${esc(pid)}" ${pid === platformId ? "selected" : ""}>${esc(cfg.providers[pid].label)}</option>`
                ).join("")}
            </select>
        </div>
        <div class="field">
            <label>API key ${p.hasKey ? `<span class="dim">(tersimpan: ${esc(p.keyHint)})</span>` : ""}</label>
            <input type="password" id="ai-key" placeholder="${p.hasKey ? "isi untuk mengganti, kosongkan untuk pakai AI Lokal" : "tempel API key di sini"}">
            <span class="help">Kosongkan &amp; simpan untuk menghapus key (Damar balik ke AI Lokal).</span>
        </div>
        <div class="field">
            <label>Base URL</label>
            <input type="url" id="ai-baseurl" value="${esc(p.baseUrl)}" placeholder="${esc(p.defaultBaseUrl)}">
        </div>
        ${modelField(p.model)}`;

}

function wireAiPanel(root, cfg) {

    const modeSeg = root.querySelector("#ai-mode");
    const fields = root.querySelector("#ai-provider-fields");

    const providerIds = Object.keys(cfg.providers);

    let mode = cfg.active === "ollama" ? "ollama" : "provider";
    let platform = cfg.active !== "ollama"
        ? cfg.active
        : (providerIds.find(id => cfg.providers[id].hasKey) ?? providerIds[0]);

    const draw = () => {
        fields.innerHTML = providerFields(cfg, mode, platform);
        wireFields();
    };

    function wireFields() {

        const plat = fields.querySelector("#ai-platform");
        if (plat) {
            plat.addEventListener("change", () => { platform = plat.value; draw(); });
        }

        const modelSel = fields.querySelector("#ai-model");
        const manual = fields.querySelector("#ai-model-manual");
        if (modelSel && manual) {
            modelSel.addEventListener("change", () => {
                const isManual = modelSel.value === "__manual__";
                manual.style.display = isManual ? "" : "none";
                if (isManual) manual.focus();
            });
        }

        const loadBtn = fields.querySelector("#ai-load-models");
        if (loadBtn) {
            loadBtn.addEventListener("click", loadModels);
        }

        const verifyBtn = fields.querySelector("#ai-verify-models");
        if (verifyBtn) {
            verifyBtn.addEventListener("click", verifyModels);
        }

    }

    /** Uji tiap model (opt-in, pakai kuota) → tandai ✓ yang bisa dipakai. */
    async function verifyModels() {

        const help = fields.querySelector("#ai-model-help");
        const btn = fields.querySelector("#ai-verify-models");

        help.textContent = "Menguji tiap model (pakai kuota, bisa sebentar)…";
        btn.disabled = true;

        try {
            await persist(false);      // pastikan provider aktif = platform ini
            const r = await api.request("/ai/models/verify", { method: "POST", body: {}, timeout: 180000 });
            const ok = (r.results ?? []).filter(x => x.ok).length;
            await loadModels();        // muat ulang → glyph ✓ muncul, yang mati hilang
            help.textContent = `${ok}/${(r.results ?? []).length} model bisa dipakai (✓). Yang gagal disembunyikan.`;
        }
        catch (error) {
            help.textContent = `Gagal verifikasi: ${error.message}`;
        }
        finally {
            btn.disabled = false;
        }

    }

    /** Simpan kredensial lalu ambil daftar model yang benar-benar tersedia. */
    async function loadModels() {

        const help = fields.querySelector("#ai-model-help");
        const modelSel = fields.querySelector("#ai-model");
        const loadBtn = fields.querySelector("#ai-load-models");

        help.textContent = "Menyimpan kredensial & memuat model…";
        loadBtn.disabled = true;

        try {

            // Model hanya bisa didaftar dengan provider yang aktif,
            // jadi simpan dulu (tanpa toast) agar daemon memakai key ini.
            await persist(false);

            const data = await api.models();
            const list = data.models ?? [];

            const current = data.defaultModel ?? "";

            modelSel.innerHTML =
                `<option value="">— pilih model —</option>` +
                list.map(m =>
                    `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${modelGlyph(m)}${esc(m.name ?? m.id)}${m.free ? " · free" : ""}</option>`
                ).join("") +
                `<option value="__manual__">✎ ketik manual…</option>`;

            help.textContent = list.length
                ? `${list.length} model tersedia (✓ terverifikasi, ⚠ preview/eksperimental) — pilih lalu Simpan.`
                : "Tidak ada model terbaca. Coba ketik manual atau periksa key/URL.";

        }
        catch (error) {
            help.textContent = `Gagal memuat: ${error.message}`;
        }
        finally {
            loadBtn.disabled = false;
        }

    }

    /** Baca model terpilih (dropdown atau input manual). */
    function readModel() {
        const modelSel = fields.querySelector("#ai-model");
        const manual = fields.querySelector("#ai-model-manual");
        if (modelSel?.value === "__manual__") {
            return manual.value.trim();
        }
        return modelSel?.value.trim() ?? "";
    }

    /** Kirim konfigurasi ke daemon. showToast=false dipakai saat memuat model. */
    async function persist(showToast) {

        const baseUrl = fields.querySelector("#ai-baseurl")?.value.trim();
        const model = readModel();

        const body = { active: mode === "ollama" ? "ollama" : platform };

        if (mode === "ollama") {
            body.ollama = { baseUrl, model };
        }
        else {
            const key = fields.querySelector("#ai-key")?.value ?? "";
            body.provider = {
                id: platform,
                ...(key !== "" ? { apiKey: key } : {}),
                baseUrl,
                model
            };
        }

        const result = await api.request("/ai/config", { method: "POST", body });

        if (showToast) {
            const v = result.verify;
            toast(
                v?.note ? `${result.reconfigured.platform}: ${v.note}` : `AI aktif: ${result.reconfigured.platform}`,
                v && v.ok === false ? "warn" : "ok",
                6000
            );
            await renderDaemonConfig(root);
            document.dispatchEvent(new CustomEvent("damar:reconnect"));
        }

        return result;

    }

    modeSeg.querySelectorAll("[data-mode]").forEach(button => {
        button.addEventListener("click", () => {
            mode = button.dataset.mode;
            modeSeg.querySelectorAll("[data-mode]").forEach(b =>
                b.classList.toggle("active", b === button));
            draw();
        });
    });

    root.querySelector("#ai-save").addEventListener("click", async () => {
        try {
            await persist(true);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }
    });

    draw();

}

function wireWhatsappPanel(root) {

    const body = () => ({
        allowed: root.querySelector("#wa-allowed").value.trim(),
        groups: root.querySelector("#wa-groups").value.trim()
    });

    root.querySelector("#wa-save").addEventListener("click", async () => {
        try {
            await api.request("/whatsapp/config", { method: "POST", body: body() });
            toast("Setelan WhatsApp disimpan", "ok");
            await renderDaemonConfig(root);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }
    });

    root.querySelector("#wa-connect").addEventListener("click", async () => {
        try {
            await api.request("/whatsapp/config", { method: "POST", body: body() });
            await api.request("/whatsapp/connect", { method: "POST", body: {} });
            toast("Menyambungkan… QR akan muncul sebentar lagi.", "ok", 4000);

            // Polling QR/koneksi ±30 dtk (QR muncul asinkron setelah WS siap).
            const boxEl = root.querySelector("#wa-qr-box");
            const imgEl = root.querySelector("#wa-qr");
            let tries = 0;
            const timer = setInterval(async () => {
                tries++;
                let s;
                try { s = await api.request("/whatsapp/status"); }
                catch { return; }
                if (s.qr && !s.connected) {
                    imgEl.src = s.qr;
                    boxEl.style.display = "block";
                }
                if (s.connected || tries > 20) {
                    clearInterval(timer);
                    if (s.connected) toast(`WhatsApp tersambung ${s.number ?? ""}`, "ok");
                    await renderDaemonConfig(root);
                }
            }, 1500);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }
    });

    // --- Daftar grup: pilih izin sekali klik ---
    async function loadGroups() {
        const box = root.querySelector("#wa-groups-list");
        if (!box) return;
        box.textContent = "Memuat grup…";
        let data;
        try { data = await api.request("/whatsapp/groups"); }
        catch (error) { box.textContent = error.message; return; }
        const groups = data.groups || [];
        if (!groups.length) {
            box.textContent = "Tak ada grup terdeteksi (pastikan tersambung & Damar sudah masuk grup).";
            return;
        }
        box.innerHTML = groups.map(g => `
            <div class="row" data-gid="${esc(g.id)}" style="justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--line)">
                <span class="text">${esc(g.subject)} <span class="dim">(${g.size})</span></span>
                <button type="button" class="btn sm ${g.allowed ? "ghost danger" : "primary"}" data-allow="${g.allowed ? "0" : "1"}">
                    ${g.allowed ? "Cabut izin" : "Izinkan akses"}
                </button>
            </div>`).join("");
        box.querySelectorAll("[data-allow]").forEach(btn =>
            btn.addEventListener("click", () =>
                toggleGroup(btn.closest("[data-gid]").dataset.gid, btn.dataset.allow === "1")));
    }

    async function toggleGroup(jid, allow) {
        const box = root.querySelector("#wa-groups-list");
        // Kumpulkan grup yang saat ini diizinkan (tombol "Cabut izin") + manual.
        const set = new Set(
            (root.querySelector("#wa-groups").value || "").split(",").map(s => s.trim()).filter(Boolean)
        );
        box.querySelectorAll("[data-gid]").forEach(row => {
            const b = row.querySelector("[data-allow]");
            if (b && b.dataset.allow === "0") set.add(row.dataset.gid);   // sudah diizinkan
        });
        if (allow) set.add(jid); else set.delete(jid);
        try {
            await api.request("/whatsapp/config", { method: "POST", body: {
                allowed: root.querySelector("#wa-allowed").value.trim(),
                groups: [...set].join(", ")
            }});
            root.querySelector("#wa-groups").value = [...set].join(", ");
            toast(allow ? "Grup diizinkan" : "Izin grup dicabut", "ok");
            await loadGroups();
        }
        catch (error) { toast(error.message, "danger", 6000); }
    }

    const groupsBtn = root.querySelector("#wa-groups-refresh");
    if (groupsBtn) groupsBtn.addEventListener("click", loadGroups);

    const testBtn = root.querySelector("#wa-test");
    if (testBtn) testBtn.addEventListener("click", async () => {
        try {
            const r = await api.request("/whatsapp/test", { method: "POST", body: {} });
            toast(`Terkirim ke ${r.recipients} chat`, "ok");
        }
        catch (error) {
            toast(error.message, "danger");
        }
    });

    const logoutBtn = root.querySelector("#wa-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", async () => {
        try {
            await api.request("/whatsapp/logout", { method: "POST", body: {} });
            toast("WhatsApp diputuskan", "ok");
            await renderDaemonConfig(root);
        }
        catch (error) {
            toast(error.message, "danger");
        }
    });

}

function rolesPanel(r) {

    r = r ?? { superadmins: [], admins: [], enforced: false };

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("activity")} Peran pengguna</h2>
                <span class="push">${pill(r.enforced ? "aktif" : "belum diatur", r.enforced ? "ok" : "idle")}</span>
            </div>
            <div class="small muted" style="margin-bottom:10px">
                Kelas akses lewat WhatsApp:
                <strong>SuperAdmin</strong> — kendali penuh tanpa batas ·
                <strong>Admin</strong> — operasional harian (tanpa kelola skill / tool sistem berbahaya) ·
                <strong>User</strong> — anggota grup, asisten AI pribadi (chat + tool aman).
                Console/CLI di mesin ini selalu SuperAdmin. Bila kosong, semua nomor
                yang diizinkan diperlakukan sebagai SuperAdmin.
            </div>
            <div class="field">
                <label>Nomor SuperAdmin</label>
                <input type="text" id="role-super" value="${esc((r.superadmins ?? []).join(", "))}"
                    placeholder="mis. 6281111, 6282222">
            </div>
            <div class="field">
                <label>Nomor Admin</label>
                <input type="text" id="role-admin" value="${esc((r.admins ?? []).join(", "))}"
                    placeholder="mis. 6283333">
            </div>
            <div class="row">
                <button class="btn primary" id="role-save">${icon("check")} Simpan peran</button>
                <span class="small dim">selain daftar ini = User</span>
            </div>
        </div>`;

}

function wireRolesPanel(root) {
    const btn = root.querySelector("#role-save");
    if (!btn) return;
    btn.addEventListener("click", async () => {
        try {
            await api.request("/roles", { method: "POST", body: {
                superadmins: root.querySelector("#role-super").value.trim(),
                admins: root.querySelector("#role-admin").value.trim()
            }});
            toast("Peran disimpan", "ok");
            await renderDaemonConfig(root);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }
    });
}

function automationPanel(a) {

    a = a ?? { enabled: false, time: "07:00", lastSent: null };

    return `
        <div class="panel">
            <div class="panel-head">
                <h2>${icon("activity")} Proaktif — brief harian</h2>
                <span class="push">${pill(a.enabled ? "aktif" : "mati", a.enabled ? "ok" : "idle")}</span>
            </div>
            <div class="small muted" style="margin-bottom:10px">
                Damar menyapa lebih dulu: ringkasan keadaan rumah dikirim otomatis
                ke WhatsApp yang diizinkan pada jam yang kamu tentukan.
            </div>
            <div class="row wrap" style="gap:14px">
                <label class="switch">
                    <input type="checkbox" id="auto-enabled" ${a.enabled ? "checked" : ""}>
                    <span class="track"></span><span>Aktifkan brief harian</span>
                </label>
                <div class="field" style="max-width:140px">
                    <label>Jam kirim</label>
                    <input type="time" id="auto-time" value="${esc(a.time ?? "07:00")}">
                </div>
            </div>
            <div class="row" style="margin-top:10px">
                <button class="btn primary" id="auto-save">${icon("check")} Simpan</button>
                <button class="btn ghost" id="auto-run">${icon("send")} Kirim brief sekarang</button>
                ${a.lastSent ? `<span class="small dim">terakhir: ${esc(a.lastSent)}</span>` : ""}
            </div>
        </div>`;

}

function wireAutomationPanel(root) {

    root.querySelector("#auto-save").addEventListener("click", async () => {
        try {
            await api.request("/automation/config", { method: "POST", body: {
                enabled: root.querySelector("#auto-enabled").checked,
                time: root.querySelector("#auto-time").value
            }});
            toast("Setelan brief disimpan", "ok");
            await renderDaemonConfig(root);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }
    });

    root.querySelector("#auto-run").addEventListener("click", async () => {
        try {
            const r = await api.request("/automation/run", { method: "POST", body: {} });
            toast(`Brief terkirim ke ${r.recipients} chat`, r.recipients ? "ok" : "warn", 5000);
        }
        catch (error) {
            toast(error.message, "danger", 6000);
        }
    });

}
