import { MicRecorder } from "./voice.js";

/**
 * Wake word "damar" — Damar selalu standby.
 *
 * DUA jalur:
 *   1. Web Speech API (SpeechRecognition) — ringan, tapi di Electron
 *      SERING TAK TERSEDIA (butuh layanan speech Google yang tak
 *      dibundel). Dipakai bila ada.
 *   2. Fallback WHISPER LOKAL — merekam jendela mic pendek beruntun lalu
 *      mentranskripsi lewat STT daemon (faster-whisper :8000), mencocokkan
 *      "damar". Inilah yang membuat wake-word benar-benar jalan di
 *      Electron selama STT dikonfigurasi.
 *
 * Degradasi anggun: tanpa mic/STT, available()=false dan pengguna pakai
 * tombol mic manual.
 */

const VARIANTS = [
    "damar", "either", "ether", "aither", "ather", "aetha", "aitha",
    "eter", "eater", "hey damar", "ok damar", "hai damar"
];

const WINDOW_MS = 2600;      // panjang tiap jendela dengar
const RETRY_MS = 4000;       // jeda saat STT/mic gagal
const POST_WAKE_MS = 12000;  // jeda setelah terpicu (biar sesi interaksi jalan)

export function createWakeWord({ onWake, onListenStart, onError, cooldownMs = 2500 } = {}) {

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const hasMic = !!navigator.mediaDevices?.getUserMedia;
    let rec = null;
    let active = false;
    let lastHit = 0;

    function available() { return !!SR || hasMic; }

    function matches(text) {
        const t = String(text || "").toLowerCase();
        return VARIANTS.some(v => t.includes(v));
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ---- Jalur 1: Web Speech API ---------------------------------
    function startSR() {
        rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = "en-US";

        rec.onresult = (e) => {
            const now = Date.now();
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const txt = e.results[i][0].transcript;
                if (matches(txt) && now - lastHit > cooldownMs) {
                    lastHit = now;
                    onWake?.(txt.trim());
                }
            }
        };
        rec.onerror = (ev) => {
            if (!["no-speech", "aborted"].includes(ev.error)) onError?.(ev.error);
        };
        rec.onend = () => { if (active) { try { rec.start(); } catch { /* retry */ } } };

        try { rec.start(); onListenStart?.(); return true; }
        catch { return false; }
    }

    // ---- Jalur 2: loop whisper lokal -----------------------------
    async function whisperLoop() {
        onListenStart?.();
        while (active) {
            let text = "";
            let recorder = null;
            try {
                recorder = new MicRecorder({ language: "id" });
                await recorder.start();
                await sleep(WINDOW_MS);
                if (!active) { try { recorder.abort(); } catch { /* */ } break; }
                const res = await recorder.stopAndTranscribe();
                text = res?.text || "";
            }
            catch (error) {
                try { recorder?.abort(); } catch { /* */ }
                onError?.(error.message);
                await sleep(RETRY_MS);   // STT/mic mati → jangan spin cepat
                continue;
            }

            const now = Date.now();
            if (matches(text) && now - lastHit > cooldownMs) {
                lastHit = now;
                onWake?.(String(text).trim());
                await sleep(POST_WAKE_MS);   // beri ruang untuk sesi interaksi
            }
        }
    }

    function start() {
        if (active) return false;
        active = true;
        // Utamakan Web Speech API bila BENAR-BENAR jalan; kalau gagal
        // start, jatuh ke whisper.
        if (SR && startSR()) return true;
        rec = null;
        if (hasMic) { whisperLoop(); return true; }
        active = false;
        return false;
    }

    function stop() {
        active = false;
        try { rec?.stop(); } catch { /* */ }
        rec = null;
    }

    return { available, start, stop, get active() { return active; } };
}
