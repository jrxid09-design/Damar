import { store } from "../lib/store.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { esc, markdown, toast, clockTime } from "../lib/ui.js";
import { aiChoices } from "../lib/aiselect.js";

let scrollHost = null;

/** Ditahan agar tombol Stop bisa membekukan gelembung yang sedang tumbuh. */
let streamingBubble = null;

/** Bubble transient Beranda aktif? (dipakai saat mount dari dashboard). */
let bubblesOn = false;

/** Lampiran menunggu dikirim bersama pesan berikutnya. */
const pendingAttachments = [];

// ---- Sesi multi-tab ---------------------------------------------------

let sessionSeq = 1;

/** Sesi aktif saat ini (dibuat bila belum ada). */
export function currentSession() {
    const chat = store.get().chat;
    if (!chat.sessions[chat.activeId]) {
        chat.sessions[chat.activeId] = { title: `Sesi ${sessionSeq}`, messages: [] };
    }
    return chat.sessions[chat.activeId];
}

/** Sesi baru dengan judul otomatis; menjadi aktif. */
export function newSession(title = null) {
    const chat = store.get().chat;
    const id = `s${++sessionSeq}-${Date.now().toString(36)}`;
    chat.sessions[id] = { title: title ?? `Sesi ${sessionSeq}`, messages: [] };
    chat.activeId = id;
    return chat.sessions[id];
}

/** Pindah sesi aktif. */
export function switchSession(id) {
    const chat = store.get().chat;
    if (chat.sessions[id]) chat.activeId = id;
}

/** Hapus sesi; bila terakhir, buat baru otomatis. */
export function removeSession(id) {
    const chat = store.get().chat;
    delete chat.sessions[id];
    if (!Object.keys(chat.sessions).length) {
        sessionSeq = 1;
        chat.sessions.s1 = { title: "Sesi 1", messages: [] };
        chat.activeId = "s1";
    }
    else if (chat.activeId === id) {
        chat.activeId = Object.keys(chat.sessions).at(-1);
    }
}

/** Baca File jadi base64 murni (tanpa prefix data:). */
function readFileBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
        reader.onerror = () => reject(new Error("gagal membaca berkas"));
        reader.readAsDataURL(file);
    });
}

export const chat = {

    id: "chat",
    label: "Chat",
    icon: "chat",
    title: "Chat",
    subtitle: "Bicara langsung dengan AI yang sedang aktif.",

    render(root) {

        root.innerHTML = `
            <div class="view-head">
                <div>
                    <h1>Chat</h1>
                    <p>Bicara langsung dengan AI yang sedang aktif.</p>
                </div>
                <div class="actions">
                    <div class="seg" id="chat-mode" style="margin:0"></div>
                    <select id="chat-model" style="width:230px" title="Model"></select>
                    <button class="btn ghost sm" id="chat-clear">${icon("trash")} Bersihkan</button>
                </div>
            </div>

            <div class="chat-layout">

                <div class="panel flush" style="display:flex;flex-direction:column;min-height:0">
                    <div class="chat-tabs" id="chat-tabs"></div>
                    <div class="chat-scroll" id="chat-scroll" style="padding:16px"></div>
                </div>

                <div class="composer">
                    <button class="btn ghost sm" id="chat-attach" title="Lampirkan foto/file/dokumen">${icon("file")}</button>
                    <input type="file" id="chat-file" hidden multiple />
                    <div class="chat-attachments" id="chat-attachments"></div>
                    <textarea id="chat-input" rows="1"
                        placeholder="Tulis pesan… (Enter kirim, Shift+Enter baris baru)"></textarea>
                    <button class="btn primary" id="chat-send">${icon("send")} Kirim</button>
                    <button class="btn danger" id="chat-stop" style="display:none">${icon("stop")} Stop</button>
                </div>

            </div>`;

        scrollHost = root.querySelector("#chat-scroll");

        renderTabs();
        renderMessages();

    },

    async mount(root, { bubbles = false } = {}) {

        const input = root.querySelector("#chat-input");
        const sendBtn = root.querySelector("#chat-send");
        const stopBtn = root.querySelector("#chat-stop");
        const modeSeg = root.querySelector("#chat-mode");
        const modelSelect = root.querySelector("#chat-model");

        // Bubble transient di Beranda (opsional): respon memancar di
        // dekat orb selama beberapa detik, riwayat penuh tetap di sini.
        bubblesOn = Boolean(bubbles);

        // Selektor AI Lokal / AI Provider; ganti → muat ulang model aktif.
        await aiChoices.render(modeSeg, () => fillModels(modelSelect));

        await fillModels(modelSelect);

        modelSelect.addEventListener("change", async () => {

            try {
                await api.selectModel(modelSelect.value);
                toast(`Model: ${modelSelect.value}`, "ok");
            }
            catch (error) {
                toast(error.message, "danger");
            }

        });

        // Textarea tumbuh mengikuti isi, sampai batas CSS max-height.
        input.addEventListener("input", () => {
            input.style.height = "auto";
            input.style.height = `${Math.min(input.scrollHeight, 190)}px`;
        });

        input.addEventListener("keydown", event => {

            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
            }

        });

        sendBtn.addEventListener("click", send);

        stopBtn.addEventListener("click", () => {

            api.stopChat();

            settle(currentSession().messages.at(-1), "dihentikan");

        });

        /**
         * Satu-satunya tempat status "sedang streaming" dilepas —
         * dipakai oleh jalur sukses, error, maupun tombol Stop
         * supaya tombol tidak pernah tertinggal di posisi salah.
         */
        function settle(message, note) {

            if (message && message.role === "assistant") {
                message.streaming = false;
                message.note = note ?? message.note;
                if (Array.isArray(message.flow) && message.flow.length) {
                    message.flow.push(message.error
                        ? { tone: "warn", icon: "x", lbl: "Gagal" }
                        : { tone: "ok", icon: "check", lbl: "Selesai" });
                }
            }

            store.get().chat.streaming = false;

            sendBtn.style.display = "inline-flex";
            stopBtn.style.display = "none";

            streamingBubble = null;

            renderMessages();

        }

        root.querySelector("#chat-clear").addEventListener("click", () => {
            store.get().chat.messages = [];
            renderMessages();
        });
        async function send() {

            const text = input.value.trim();

            if (!text) {
                return;
            }

            if (!store.get().connected) {
                toast("Belum terhubung ke daemon.", "warn");
                return;
            }

            input.value = "";
            input.style.height = "auto";

            const conversation = currentSession();

            // Ambil & lepas lampiran menunggu — jadi bagian pesan ini.
            const attachments = pendingAttachments.splice(0, pendingAttachments.length);
            document.querySelectorAll("#chat-attachments .chat-attach-chip").forEach(c => c.remove());

            conversation.messages.push({
                role: "user",
                content: text,
                time: new Date().toISOString(),
                attachments: attachments.map(a => ({
                    name: a.name, kind: a.kind, path: a.path,
                    image: a.dataUri ?? null
                }))
            });

            // Payload disusun SEBELUM placeholder assistant dibuat.
            // Kalau placeholder yang masih kosong ikut terkirim,
            // model membacanya sebagai prefill jawaban dan sering
            // membalas dengan string kosong.
            //
            // Lampiran diringkas jadi teks konteks: gambar dianalisis
            // lewat jalur vision saat daemon memproses; dokumen sudah
            // berada di memori dan dirujuk lewat path-nya.
            const attachmentNote = attachments.length
                ? "\n\n[Lampiran dari pengguna]\n" + attachments.map(a =>
                    a.kind === "image"
                        ? `- Gambar: ${a.name}${a.dataUri ? " (terlampir, analisis via vision)" : " (tersimpan di server)"}`
                        : `- Dokumen: ${a.name} — tersimpan di ${a.path} dan sudah dibaca ke memori dokumen`
                ).join("\n")
                : "";

            const payload = conversation.messages
                .filter(message =>
                    message.role !== "system" &&
                    !message.error &&
                    message.content)
                .map(({ role, content, attachments: att }) => ({
                    role,
                    content: att?.length
                        ? content + "\n\n[Lampiran: " + att.map(a => a.name).join(", ") + "]"
                        : content
                }))
                .filter(m => m.content);

            const assistant = {
                role: "assistant",
                content: "",
                time: new Date().toISOString(),
                streaming: true,
                flow: [],          // langkah nyata: intent → model → tool → selesai
                _seen: new Set()
            };

            // Langkah pertama: maksud diterima (selalu benar, dari input user).
            assistant.flow.push({ tone: "acc", icon: "chat", lbl: "Maksud diterima" });

            conversation.messages.push(assistant);
            conversation.streaming = true;

            renderMessages();

            // Bubble transient di Beranda: user (+ thumbnail lampiran)
            // dan assistant (streaming).
            let homeAssistant = null;
            if (bubblesOn) {
                showBubble({
                    kind: attachments.length && attachments[0].kind === "image" && attachments[0].dataUri
                        ? "media"
                        : "chat",
                    role: "user",
                    text,
                    media: attachments[0]?.dataUri
                        ? { kind: "image", url: attachments[0].dataUri, caption: text }
                        : undefined
                });
                homeAssistant = showBubble({ kind: "chat", role: "assistant", text: "" });
            }

            sendBtn.style.display = "none";
            stopBtn.style.display = "inline-flex";

            streamingBubble = scrollHost.querySelector(".msg:last-child .bubble");

            const started = Date.now();

            try {

                await api.streamChat(
                    {
                        messages: payload,
                        model: modelSelect.value || undefined
                    },
                    ({ event, data }) => {

                        if (event === "start") {

                            // Planner memilih model/provider.
                            assistant.flow.push({
                                tone: "acc", icon: "cpu",
                                lbl: "Planner menyiapkan model",
                                sub: shortModel(data.model) + (data.provider ? ` · ${data.provider}` : "")
                            });
                            rerenderStreaming();

                        }

                        else if (event === "chunk") {

                            // Tool yang dipanggil model → langkah eksekusi nyata.
                            if (Array.isArray(data.toolCalls) && data.toolCalls.length) {
                                for (const tc of data.toolCalls) {
                                    const name = tc.function?.name ?? tc.name ?? "tool";
                                    const key = tc.id ?? name;
                                    if (assistant._seen.has(key)) continue;
                                    assistant._seen.add(key);
                                    assistant.flow.push({ tone: "ok", icon: "tool", lbl: `Menjalankan ${name}` });
                                }
                                rerenderStreaming();
                            }

                            if (data.delta) {
                                if (!assistant._answering) {
                                    assistant._answering = true;
                                    assistant.flow.push({ tone: "ok", icon: "activity", lbl: "Menyusun jawaban" });
                                }
                                assistant.content += data.delta;
                                if (streamingBubble) streamingBubble.innerHTML = markdown(assistant.content);
                                homeAssistant?.appendText(data.delta);
                                scrollToEnd();
                            }

                        }

                        else if (event === "error") {

                            assistant.content ||= "";
                            assistant.error = data.message;

                        }

                    }
                );

                settle(
                    assistant,
                    `${((Date.now() - started) / 1000).toFixed(1)}s`
                );

                homeAssistant?.setText(assistant.content || "(kosong)");

            }

            catch (error) {

                assistant.error = error.message;

                settle(assistant, null);

                homeAssistant?.setText(`⚠ ${error.message}`);

                toast(error.message, "danger");

            }

        }

        // ---- Lampiran berkas (foto/file/dokumen format apa pun) ----
        const attachBtn = root.querySelector("#chat-attach");
        const fileInput = root.querySelector("#chat-file");
        const attachHost = root.querySelector("#chat-attachments");

        attachBtn.addEventListener("click", () => fileInput.click());

        fileInput.addEventListener("change", async () => {

            for (const file of fileInput.files) {

                const chip = document.createElement("span");
                chip.className = "chat-attach-chip";
                chip.innerHTML = `<span class="spinner"></span> ${esc(file.name)}`;
                attachHost.appendChild(chip);

                try {

                    const data = await readFileBase64(file);

                    const r = await api.uploadChatFile({
                        name: file.name,
                        data,
                        mimeType: file.type || undefined
                    });

                    pendingAttachments.push({
                        name: r.name ?? file.name,
                        kind: r.kind,
                        path: r.path,
                        dataUri: r.dataUri,
                        chip
                    });

                    const ikon = r.kind === "image" ? "image" : "file";
                    chip.innerHTML = `${icon(ikon)} ${esc(r.name ?? file.name)}`;
                    chip.title = r.kind === "image"
                        ? "Gambar akan dianalisis saat dikirim"
                        : "Dokumen dimasukkan ke memori — Aether bisa merujuknya";

                    // Klik chip = lepas lampiran.
                    chip.addEventListener("click", () => {
                        const i = pendingAttachments.findIndex(a => a.chip === chip);
                        if (i >= 0) pendingAttachments.splice(i, 1);
                        chip.remove();
                    });

                    if (r.kind !== "image" && r.ingested?.error) {
                        toast(`Dokumen terlampir, tapi gagal dibaca: ${r.ingested.error}`, "warn", 5000);
                    }

                }
                catch (error) {
                    chip.remove();
                    toast(`Upload gagal: ${error.message}`, "danger");
                }

            }

            fileInput.value = "";

        });

        input.focus();

    }

};

async function fillModels(select, provider) {

    select.innerHTML = `<option value="">memuat…</option>`;

    try {

        const data = await api.models(provider);

        const models = data.models ?? [];

        if (models.length === 0) {

            select.innerHTML = `<option value="">tidak ada model</option>`;

            return;

        }

        select.innerHTML = models.map(model => {
            const glyph = model.status === "verified" ? "✓ "
                : (model.tier === "preview" || model.tier === "experimental") ? "⚠ " : "";
            return `<option value="${esc(model.id)}" ${model.id === data.defaultModel ? "selected" : ""}>
                ${glyph}${esc(model.name ?? model.id)}${model.free ? " · free" : ""}
            </option>`;
        }).join("");

    }

    catch (error) {

        select.innerHTML = `<option value="">gagal memuat</option>`;

        toast(`Model: ${error.message}`, "warn");

    }

}

function renderMessages() {

    if (!scrollHost) {
        return;
    }

    const messages = currentSession().messages;

    if (messages.length === 0) {

        scrollHost.innerHTML = `
            <div class="empty">
                ${icon("chat")}
                <div style="font-size:14px;color:var(--text)">Mulai percakapan</div>
                <div>Model bisa memanggil tool plugin Aether saat dibutuhkan.</div>
            </div>`;

        return;

    }

    scrollHost.innerHTML = messages.map(message => {

        const role = message.role;

        const avatar = role === "user" ? "You" : "AE";

        const attHtml = (message.attachments ?? []).map(a => a.image
            ? `<img class="msg-attach-img" src="${esc(a.image)}" alt="${esc(a.name)}" title="${esc(a.name)}">`
            : `<span class="msg-attach-file">${icon("file")} ${esc(a.name)}</span>`
        ).join("");

        const body = message.error
            ? `<span class="danger-text">${esc(message.error)}</span>`
            : (message.content
                ? markdown(message.content)
                : `<span class="dim">menunggu jawaban…</span>`);

        const footnote = [
            clockTime(message.time),
            message.note
        ].filter(Boolean).join(" · ");

        return `
            <div class="msg ${esc(role)}">
                <div class="avatar">${avatar}</div>
                <div style="min-width:0">
                    ${role === "assistant" ? flowStrip(message) : ""}
                    ${attHtml ? `<div class="msg-attachments">${attHtml}</div>` : ""}
                    <div class="bubble ${message.streaming ? "typing" : ""}">${body}</div>
                    ${footnote ? `<div class="footnote">${esc(footnote)}</div>` : ""}
                </div>
            </div>`;

    }).join("");

    scrollToEnd();

}

/** Strip alur nyata sebuah jawaban: maksud → model → tool → jawaban → selesai. */
function flowStrip(message) {

    if (!Array.isArray(message.flow) || message.flow.length === 0) {
        return "";
    }

    return `<div class="flow chat-flow">${message.flow.map(s => `
        <div class="step" data-tone="${esc(s.tone ?? "ok")}">
            <span class="node">${icon(s.icon ?? "check")}</span>
            <div><div class="lbl">${esc(s.lbl)}</div>${s.sub ? `<div class="sub">${esc(s.sub)}</div>` : ""}</div>
        </div>`).join("")}</div>`;

}

/** Tab sesi percakapan — tambah, pindah, tutup. */
function renderTabs() {

    const host = document.getElementById("chat-tabs");
    if (!host) return;

    const chat = store.get().chat;
    const ids = Object.keys(chat.sessions);

    host.innerHTML = ids.map(id => {
        const s = chat.sessions[id];
        const active = id === chat.activeId;
        const n = s.messages.length;
        return `<button class="chat-tab ${active ? "active" : ""}" data-sess="${esc(id)}" title="${esc(s.title)}">
            <span class="t">${esc(s.title)}${n ? ` <i>${n}</i>` : ""}</span>
            ${ids.length > 1 ? `<span class="x" data-close="${esc(id)}" title="Tutup sesi">✕</span>` : ""}
        </button>`;
    }).join("") + `<button class="chat-tab add" id="chat-tab-new" title="Sesi baru">+</button>`;

    host.querySelectorAll("[data-sess]").forEach(btn => {
        btn.addEventListener("click", e => {
            if (e.target.closest("[data-close]")) return;
            switchSession(btn.dataset.sess);
            renderTabs();
            renderMessages();
        });
    });

    host.querySelectorAll("[data-close]").forEach(x => {
        x.addEventListener("click", e => {
            e.stopPropagation();
            removeSession(x.dataset.close);
            renderTabs();
            renderMessages();
        });
    });

    host.querySelector("#chat-tab-new")?.addEventListener("click", () => {
        newSession();
        renderTabs();
        renderMessages();
        document.getElementById("chat-input")?.focus();
    });
}

function shortModel(name) {
    if (!name) return "—";
    const s = String(name).split("/").pop();
    return s.length > 20 ? s.slice(0, 19) + "…" : s;
}

/** Render ulang saat streaming lalu ambil kembali gelembung terakhir. */
function rerenderStreaming() {
    renderMessages();
    streamingBubble = scrollHost?.querySelector(".msg:last-child .bubble") ?? null;
}

function scrollToEnd() {

    if (scrollHost) {
        scrollHost.scrollTop = scrollHost.scrollHeight;
    }

}
