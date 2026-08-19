import { store } from "./store.js";
import { api } from "./api.js";
import { esc, toast } from "./ui.js";
import { aetherState } from "./aetherState.js";
import { tts, MicRecorder } from "./voice.js";

/**
 * Aether Chat — gelembung percakapan MURNI di sisi kanan.
 *
 * - TIDAK ada panel, statusline, maupun kotak ketik/kirim di sini:
 *   seluruh interaksi (teks & mic) hanya lewat kotak ketik dan mic
 *   di dashboard Beranda. Yang muncul di kanan HANYA bubble.
 * - Saat bubble muncul, orb utama otomatis MENGGESER KE KIRI agar
 *   tidak terhalang (body.chat-open). Kotak ketik TIDAK ikut bergeser.
 * - TANPA tombol tutup: sesi ini transien. Ia lenyap sendiri setelah
 *   satu menit tanpa aktivitas (dari pengguna maupun Aether), dan
 *   ditutup begitu pemilik pindah aplikasi. Esc tetap ada sebagai
 *   jalan keluar cepat lewat papan ketik.
 * - Maksimal 3 gelembung terlihat; yang lebih tua menggulung keluar.
 *   Riwayat penuh tetap hidup di aplikasi Aether (chat).
 */

/** Berapa banyak gelembung boleh terlihat sekaligus. */
const MAX_BUBBLES = 3;

/** Senyap selama ini → sesi memudar sendiri. */
const IDLE_TTL_MS = 60000;

// Percakapan Beranda TERHUBUNG dengan chat Ikhtisar: keduanya membaca/
// menulis store.chat.sessions[activeId].messages yang SAMA, sehingga
// riwayat tetap ada di kedua layar selama sesi belum ditutup. (Format
// pesan kompatibel — kedua render hanya membaca role/content/error;
// field ekstra chat.js seperti streaming/flow diabaikan di sini.)
function conv() {
    const chat = store.get().chat;
    chat.sessions ??= {};
    const id = chat.activeId ?? (chat.activeId = Object.keys(chat.sessions)[0] ?? "s1");
    if (!chat.sessions[id]) chat.sessions[id] = { title: "Sesi 1", messages: [] };
    return chat.sessions[id].messages;
}
let recorder = null;
let recording = false;
let busy = false;
let voiceMode = false;
let sttConfigured = false;
/** Kalimat bantuan dari daemon bila servis suaranya belum jalan. */
let sttHint = null;
let vad = null;
let els = null;

const prefs = { autoSpeak: true, voiceName: null, rate: 1, robot: false };

// ---- DOM (dibangun sekali) ----------------------------------------

function build() {
    if (els) return els;

    const el = document.createElement("div");
    el.className = "ae-chat-panel";
    el.id = "ae-chat-panel";
    // HANYA bubble — tanpa statusline, tanpa form ketik/kirim, dan
    // tanpa tombol tutup (sesi berumur pendek, lihat catatan di atas).
    el.innerHTML = `<div class="ae-chat-convo" id="ae-cp-convo"></div>`;
    document.body.appendChild(el);

    els = {
        root: el,
        convo: el.querySelector("#ae-cp-convo")
    };

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && el.classList.contains("open")) close();
    });

    return els;
}

/**
 * Umur sesi disegarkan oleh SETIAP aktivitas: pertanyaan baru, potongan
 * jawaban yang mengalir, mic yang mulai mendengar. Yang memicu
 * penutupan hanyalah senyap sungguhan selama satu menit penuh —
 * bukan sekadar jeda antar kalimat.
 */
let idleTimer = null;

function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        // Jangan potong Aether yang masih bekerja atau sedang mendengar.
        if (busy || recording) { touchIdle(); return; }
        close();
    }, IDLE_TTL_MS);
}

function stopIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
}

// ---- Buka / tutup --------------------------------------------------

export async function openOverlay({ text = null, voice = false } = {}) {

    build();
    els.root.classList.add("open");
    document.body.classList.add("chat-open");     // orb utama bergeser kiri
    document.dispatchEvent(new CustomEvent("aether:overlay", { detail: { open: true } }));

    aetherState.set(store.get().connected ? "idle" : "offline");
    render();
    touchIdle();

    // Preferensi suara + kesiapan STT.
    try {
        const saved = await window.aether.settings.get();
        if (saved.tts) Object.assign(prefs, saved.tts);
    } catch { /* default */ }
    await tts.load();
    await tts.refreshStatus();
    // Terkonfigurasi TIDAK sama dengan hidup. Menyalakan mic untuk
    // servis yang mati hanya menghasilkan rekaman yang dibuang.
    try {
        const v = await api.voiceStatus();
        sttConfigured = v.stt.configured && v.stt.online !== false;
        sttHint = v.hint ?? null;
    }
    catch { sttConfigured = false; }

    voiceMode = voice;

    if (text) { await ask(text); }
}

export function close() {
    if (!els) return;
    stopIdle();
    voiceMode = false;
    tts.cancel();
    stopVad();
    recorder?.abort(); recorder = null; recording = false;
    els.root.classList.remove("open");
    document.body.classList.remove("chat-open");
    document.dispatchEvent(new CustomEvent("aether:overlay", { detail: { open: false } }));
}

export function isOpen() { return !!els && els.root.classList.contains("open"); }

/**
 * Sesi bicara dari Beranda: orb MENYAPA dulu (curious), lalu antusias
 * masuk mode dengar saat mic aktif. Hanya bubble yang muncul;
 * input tetap dari kotak ketik + mic di dashboard.
 */
export async function greetAndListen() {
    build();
    document.body.classList.add("chat-open");
    els.root.classList.add("open");
    aetherState.set(store.get().connected ? "curious" : "offline");
    render();
    touchIdle();

    try {
        const saved = await window.aether.settings.get();
        if (saved.tts) Object.assign(prefs, saved.tts);
    } catch { /* default */ }
    await tts.load();
    await tts.refreshStatus();
    // Terkonfigurasi TIDAK sama dengan hidup. Menyalakan mic untuk
    // servis yang mati hanya menghasilkan rekaman yang dibuang.
    try {
        const v = await api.voiceStatus();
        sttConfigured = v.stt.configured && v.stt.online !== false;
        sttHint = v.hint ?? null;
    }
    catch { sttConfigured = false; }

    voiceMode = true;
    await startListening();
}

// ---- Percakapan ----------------------------------------------------

async function ask(text) {

    if (!store.get().connected) { toast("Belum terhubung ke daemon.", "warn"); aetherState.set("offline"); return; }

    busy = true;
    conv().push({ role: "user", content: text });
    const assistant = { role: "assistant", content: "" };
    conv().push(assistant);
    render();
    aetherState.set("thinking");

    try {
        await api.streamChat(
            {
                messages: conv().filter(m => m.content && !m.error).map(({ role, content }) => ({ role, content })),
                model: undefined
            },
            ({ event, data }) => {
                if (event === "chunk" && data.delta) { assistant.content += data.delta; render(); }
                else if (event === "error") { assistant.error = data.message; }
            }
        );

        if (assistant.error) { aetherState.set("error"); toast(assistant.error, "danger"); }
        else if (assistant.content.trim()) { await speak(assistant.content); }
        else { aetherState.set("idle"); }
    }
    catch (error) {
        assistant.error = error.message; render(); aetherState.set("error"); toast(error.message, "danger");
    }
    finally {
        busy = false;
        if (aetherState.state !== "error" && !recording) aetherState.set("idle");
    }
}

async function speak(text) {
    if (!prefs.autoSpeak || !tts.available()) {
        aetherState.set("idle");
        if (voiceMode && sttConfigured) startListening();
        return;
    }
    aetherState.set("speaking");
    await tts.say(text, {
        voice: prefs.voiceName, rate: prefs.rate ?? 1, pitch: 1, robot: prefs.robot,
        onLevel: (v) => aetherState.setMouth(v),
        onEnd: () => {
            aetherState.setMouth(0);
            aetherState.set("idle");
            if (voiceMode && sttConfigured) startListening();   // lanjut dengar (hands-free)
        }
    });
}

// ---- Suara masuk (STT daemon) + VAD auto-stop ----------------------

async function startListening() {
    if (recording || busy) return;
    if (!sttConfigured) {
        voiceMode = false;
        toast(sttHint
            ?? "Suara-masuk belum diset (AETHER_STT_URL). Ketik saja — Aether tetap menjawab bersuara.",
            "warn", 7000);
        aetherState.set("idle");
        return;
    }
    try {
        tts.cancel();
        recorder = new MicRecorder({ language: "id" });
        let loudAt = 0, heard = false;
        recorder.onLevel = (v) => {
            aetherState.setLevel(v);
            const now = Date.now();
            if (v > 0.14) { loudAt = now; heard = true; }
            if (heard && now - loudAt > 1400) finishListening();
        };
        await recorder.start();
        recording = true;
        touchIdle();
        aetherState.set("listening");
        aetherState.set("listening");
        vad = setTimeout(() => { if (!heard) finishListening(); }, 8000);
    }
    catch (error) { toast(`Mikrofon: ${error.message}`, "danger"); aetherState.set("idle"); }
}

async function finishListening() {
    if (!recorder) return;
    recording = false;
    stopVad();
    aetherState.setLevel(0);
    aetherState.set("thinking");
    aetherState.set("thinking");
    try {
        const { text } = await recorder.stopAndTranscribe();
        recorder = null;
        if (text?.trim()) await ask(text.trim());
        else { aetherState.set("idle"); if (voiceMode && sttConfigured) startListening(); }
    }
    catch (error) { toast(error.message, "danger"); aetherState.set("idle"); }
}

function stopVad() { if (vad) { clearTimeout(vad); vad = null; } }

// ---- Tampilan ------------------------------------------------------



function render() {
    if (!els) return;

    // Setiap gambar ulang berarti ada yang terjadi (pertanyaan masuk,
    // potongan jawaban tiba) — umur sesi ikut disegarkan di sini
    // supaya jawaban panjang tidak terpotong hitungan mundur.
    touchIdle();

    const host = els.convo;
    const msgs = conv();
    if (msgs.length === 0) {
        host.innerHTML = `<div class="ae-hint">Tanyakan apa saja pada Aether…</div>`;
        return;
    }
    // Hanya beberapa gelembung terakhir yang terlihat; riwayat penuh
    // tersimpan di sesi chat (dan tampil di Ikhtisar) — Beranda bukan arsip.
    host.innerHTML = msgs.slice(-MAX_BUBBLES).map(m => {
        const cls = m.role === "user" ? "u" : "a";
        const body = m.error ? `<span class="danger-text">${esc(m.error)}</span>` : esc(m.content || "…");
        return `<div class="ae-chat-msg ${cls}"><div class="bub">${body}</div></div>`;
    }).join("");
    host.scrollTop = host.scrollHeight;
}
