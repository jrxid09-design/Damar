import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, toast } from "../lib/ui.js";
import { createHologram } from "../lib/hologram.js";
import { tts, MicRecorder } from "../lib/voice.js";

/**
 * Layar utama Aether sebagai entitas hidup.
 *
 * Avatar minibot di tengah bereaksi terhadap alur percakapan
 * (menyimak → berpikir → berbicara), dengan suara masuk (mic)
 * dan keluar (TTS). Ini wajah Aether — bukan sekadar kotak chat.
 */

// Konteks percakapan bertahan selama aplikasi hidup (di luar
// render agar tidak hilang saat pindah tab).
// Chat aplikasi Aether TERHUBUNG dengan chat Beranda & Panel Sistem:
// semua membaca/menulis store.chat.sessions[activeId].messages yang
// sama, jadi riwayat konsisten di semua layar selama sesi tak ditutup.
function conv() {
    const chat = store.get().chat;
    chat.sessions ??= {};
    const id = chat.activeId ?? (chat.activeId = Object.keys(chat.sessions)[0] ?? "s1");
    if (!chat.sessions[id]) chat.sessions[id] = { title: "Sesi 1", messages: [] };
    return chat.sessions[id].messages;
}

let avatar = null;
let recorder = null;
let recording = false;
let busy = false;
let sttConfigured = false;

const prefs = {
    autoSpeak: true,
    voiceName: null,
    rate: 1,
    robot: false
};

const STATUS = {
    idle:      { text: "Siap", tone: "muted" },
    listening: { text: "Menyimak…", tone: "ok" },
    thinking:  { text: "Berpikir…", tone: "ai" },
    speaking:  { text: "Berbicara…", tone: "accent" },
    success:   { text: "Selesai", tone: "ok" },
    error:     { text: "Ada kendala", tone: "danger" },
    offline:   { text: "Tidak terhubung", tone: "danger" }
};

export const aether = {

    id: "aether",
    label: "Aether",
    icon: "orb",
    title: "Aether",
    subtitle: "Ngobrol langsung — dengan suara atau teks.",

    render(root) {

        const connected = store.get().connected;

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Aether</h1>
                    <p>Ngobrol langsung — dengan suara atau teks.</p>
                </div>
                <div class="actions">
                    <label class="switch" title="Baca jawaban dengan suara">
                        <input type="checkbox" id="ae-speak" ${prefs.autoSpeak ? "checked" : ""}>
                        <span class="track"></span>
                        <span class="small">Suara</span>
                    </label>
                    <label class="switch" title="Efek suara robot">
                        <input type="checkbox" id="ae-robot" ${prefs.robot ? "checked" : ""}>
                        <span class="track"></span>
                        <span class="small">Robot</span>
                    </label>
                    <select id="ae-voice" style="width:180px" title="Pilih suara (Kokoro neural bila ada, atau OS)"></select>
                </div>
            </div>

            <div class="aether-stage">

                <div class="aether-orb">
                    <div class="aether-avatar-holder" id="ae-avatar"></div>
                    <div class="aether-status" id="ae-status">
                        <span class="dot"></span><span class="label">Siap</span>
                    </div>
                    <div class="aether-mic-level"><div class="fill" id="ae-level"></div></div>
                </div>

                <div class="aether-transcript" id="ae-transcript"></div>

            </div>

            <div class="composer aether-composer">
                <button class="mic-btn" id="ae-mic" title="Tekan untuk bicara">
                    ${icon("mic")}
                </button>
                <textarea id="ae-input" rows="1"
                    placeholder="Tulis atau tekan mikrofon untuk bicara…"></textarea>
                <button class="btn primary" id="ae-send">${icon("send")} Kirim</button>
            </div>`;

        // Hologram JARVIS — entitas cahaya, bukan karakter.
        avatar = createHologram({ maxFps: 30 });
        root.querySelector("#ae-avatar").appendChild(avatar.el);
        setState(connected ? "idle" : "offline");

        renderTranscript(root);

    },

    async mount(root) {

        const input = root.querySelector("#ae-input");
        const sendBtn = root.querySelector("#ae-send");
        const micBtn = root.querySelector("#ae-mic");
        const speakToggle = root.querySelector("#ae-speak");
        const voiceSelect = root.querySelector("#ae-voice");

        // Muat preferensi tersimpan.
        try {
            const saved = await window.aether.settings.get();
            if (saved.tts) {
                Object.assign(prefs, saved.tts);
                speakToggle.checked = prefs.autoSpeak;
            }
        }
        catch { /* pakai default */ }

        // Cek neural dulu, lalu isi daftar suara (neural bila ada, OS bila tidak).
        await tts.load();
        await tts.refreshStatus();
        await populateVoices(voiceSelect);

        const robotToggle = root.querySelector("#ae-robot");
        robotToggle.addEventListener("change", () => {
            prefs.robot = robotToggle.checked;
            savePrefs();
        });

        // Cek kesiapan STT (mic akan dinonaktifkan bila belum ada).
        try {
            const status = await api.voiceStatus();
            sttConfigured = status.stt.configured;
        }
        catch {
            sttConfigured = false;
        }

        if (!sttConfigured) {
            micBtn.classList.add("disabled");
            micBtn.title =
                "Suara-masuk belum dikonfigurasi (set AETHER_STT_URL). " +
                "Kamu tetap bisa mengetik, dan Aether tetap menjawab dengan suara.";
        }

        input.addEventListener("input", () => {
            input.style.height = "auto";
            input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
        });

        input.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
            }
        });

        sendBtn.addEventListener("click", submit);

        micBtn.addEventListener("click", () => toggleMic(root));

        speakToggle.addEventListener("change", () => {
            prefs.autoSpeak = speakToggle.checked;
            if (!prefs.autoSpeak) {
                tts.cancel();
            }
            savePrefs();
        });

        voiceSelect.addEventListener("change", () => {
            prefs.voiceName = voiceSelect.value || null;
            savePrefs();
            // Cicip suara terpilih.
            if (prefs.autoSpeak) {
                tts.say("Halo, aku Aether.", { ...voiceOptions(), robot: prefs.robot });
            }
        });

        async function submit() {

            const text = input.value.trim();

            if (!text || busy) {
                return;
            }

            input.value = "";
            input.style.height = "auto";

            await ask(root, text);

        }

        input.focus();

    },

    unmount() {
        tts.cancel();
        recorder?.abort();
        recorder = null;
        recording = false;
        avatar?.destroy();
        avatar = null;
    }

};

// =====================================================================
// Alur percakapan
// =====================================================================

async function ask(root, text) {

    if (!store.get().connected) {
        toast("Belum terhubung ke daemon.", "warn");
        setState("offline");
        return;
    }

    busy = true;

    conv().push({ role: "user", content: text });
    renderTranscript(root);

    const assistant = { role: "assistant", content: "" };
    conv().push(assistant);

    setState("thinking");

    try {

        await api.streamChat(
            {
                messages: conv()
                    .filter(m => m.content && !m.error)
                    .map(({ role, content }) => ({ role, content })),
                model: undefined
            },
            ({ event, data }) => {

                if (event === "chunk" && data.delta) {
                    assistant.content += data.delta;
                    renderTranscript(root);
                }
                else if (event === "error") {
                    assistant.error = data.message;
                }

            }
        );

        if (assistant.error) {
            setState("error");
            toast(assistant.error, "danger");
        }
        else if (assistant.content.trim()) {
            await speak(assistant.content);
        }
        else {
            setState("idle");
        }

    }

    catch (error) {
        assistant.error = error.message;
        renderTranscript(root);
        setState("error");
        toast(error.message, "danger");
    }

    finally {
        busy = false;
        if (avatar && avatar.state !== "error") {
            setState("idle");
        }
    }

}

/** Ucapkan jawaban sambil menggerakkan mulut avatar. */
async function speak(text) {

    if (!prefs.autoSpeak || !tts.available()) {
        setState("idle");
        return;
    }

    setState("speaking");

    // say() memilih suara neural (Kokoro dsb) bila ada, atau suara
    // OS. Mulut avatar digerakkan dari amplitudo suara sungguhan.
    await tts.say(text, {
        ...voiceOptions(),
        robot: prefs.robot,
        onLevel: (level) => avatar?.setMouth(level),
        onEnd: () => setState("idle")
    });

}

// =====================================================================
// Mikrofon (STT)
// =====================================================================

async function toggleMic(root) {

    if (busy && !recording) {
        return;
    }

    if (!sttConfigured) {
        toast(
            "Suara-masuk belum dikonfigurasi. Set AETHER_STT_URL di daemon. " +
            "Sementara, ketik saja — Aether tetap menjawab dengan suara.",
            "warn",
            6000
        );
        return;
    }

    const micBtn = root.querySelector("#ae-mic");
    const level = root.querySelector("#ae-level");

    if (recording) {

        // Selesai bicara → transkripsi → tanyakan.
        recording = false;
        micBtn.classList.remove("recording");
        level.style.width = "0%";

        setState("thinking");

        try {
            const { text } = await recorder.stopAndTranscribe();

            if (text?.trim()) {
                await ask(root, text.trim());
            }
            else {
                toast("Tidak ada suara yang terdengar.", "warn");
                setState("idle");
            }
        }
        catch (error) {
            toast(error.message, "danger");
            setState("idle");
        }

        return;

    }

    // Mulai merekam.
    try {

        tts.cancel();

        recorder = new MicRecorder({ language: "id" });
        recorder.onLevel = (v) => {
            level.style.width = `${(v * 100).toFixed(0)}%`;
        };

        await recorder.start();

        recording = true;
        micBtn.classList.add("recording");
        setState("listening");

    }

    catch (error) {
        toast(`Mikrofon: ${error.message}`, "danger");
        setState("idle");
    }

}

// =====================================================================
// Tampilan
// =====================================================================

function setState(state) {

    avatar?.setState(state);

    const host = document.querySelector("#ae-status");

    if (!host) {
        return;
    }

    const info = STATUS[state] ?? STATUS.idle;

    host.querySelector(".label").textContent = info.text;
    host.dataset.tone = info.tone;

}

function renderTranscript(root) {

    const host = (root ?? document).querySelector("#ae-transcript");

    if (!host) {
        return;
    }

    const msgs = conv();
    if (msgs.length === 0) {
        host.innerHTML = `
            <div class="aether-hint">
                ${esc("Sapa Aether — tanya kabar server, minta ingat sesuatu, atau apa saja.")}
            </div>`;
        return;
    }

    // Tampilkan beberapa giliran terakhir agar avatar tetap fokus.
    host.innerHTML = msgs.slice(-6).map(message => {

        const who = message.role === "user" ? "Kamu" : "Aether";
        const cls = message.role === "user" ? "u" : "a";

        const body = message.error
            ? `<span class="danger-text">${esc(message.error)}</span>`
            : esc(message.content || "…");

        return `<div class="line ${cls}"><span class="who">${who}</span> ${body}</div>`;

    }).join("");

    host.scrollTop = host.scrollHeight;

}

async function populateVoices(select) {

    // Utamakan suara NEURAL (Kokoro) — itu yang benar-benar dipakai
    // say()/speakNeural dan yang bisa efek robot. Sebelumnya picker hanya
    // memuat suara OS speechSynthesis (Microsoft); id yang terpilih lalu
    // dikirim ke Kokoro yang tak mengenalnya, sehingga selalu jatuh ke
    // suara default dan robot tak terdengar. /voice/voices mengembalikan
    // {source:"neural", voices:[{id,name}]} bila container TTS terjangkau.
    try {
        const res = await api.voiceVoices();
        if (res?.source === "neural" && Array.isArray(res.voices) && res.voices.length) {
            const list = res.voices.map(v => ({ id: v.id ?? v.name, name: v.name ?? v.id }));
            if (!prefs.voiceName || !list.some(v => v.id === prefs.voiceName)) {
                prefs.voiceName = res.current && list.some(v => v.id === res.current)
                    ? res.current : list[0].id;
            }
            select.innerHTML = list.map(v =>
                `<option value="${esc(v.id)}" ${v.id === prefs.voiceName ? "selected" : ""}>` +
                `${esc(v.name)} (neural)</option>`
            ).join("");
            return;
        }
    }
    catch { /* neural tak terjangkau → jatuh ke suara OS di bawah */ }

    const voices = tts.voices;

    if (voices.length === 0) {
        select.innerHTML = `<option value="">(tidak ada suara)</option>`;
        return;
    }

    const def = tts.pickDefault();

    // Utamakan Indonesia, lalu sisanya.
    const sorted = [...voices].sort((a, b) => {
        const ai = /^id/i.test(a.lang) ? 0 : 1;
        const bi = /^id/i.test(b.lang) ? 0 : 1;
        return ai - bi;
    });

    select.innerHTML = sorted.map(v => {
        const selected = (prefs.voiceName ? v.name === prefs.voiceName : v === def)
            ? "selected" : "";
        return `<option value="${esc(v.name)}" ${selected}>${esc(v.name)} — ${esc(v.lang)}</option>`;
    }).join("");

    if (!prefs.voiceName && def) {
        prefs.voiceName = def.name;
    }

}

function voiceOptions() {
    return {
        voice: prefs.voiceName,
        rate: prefs.rate ?? 1,
        pitch: 1
    };
}

function savePrefs() {
    window.aether.settings.set({ tts: { ...prefs } }).catch(() => {});
}
