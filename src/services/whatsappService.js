const path = require("node:path");
const fs = require("node:fs");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

/**
 * Jembatan WhatsApp â€” pengganti Telegram.
 *
 * Memakai Baileys (WhatsApp Web multi-device) via WebSocket: tak
 * perlu Chromium, tak perlu URL publik, jalan di belakang NAT rumah
 * persis seperti long-polling Telegram dulu. Login pakai PAIRING
 * CODE (kode 8 karakter) â€” pengguna memasukkan nomornya, dapat kode,
 * lalu tempel di WhatsApp > Perangkat Tertaut > Tautkan dengan nomor.
 *
 * Keamanan: hanya melayani nomor yang diizinkan (privat) dan grup
 * yang didaftarkan (di grup Damar menjawab saat di-mention/di-reply).
 *
 * ponytail: Baileys dep berat tapi tak terhindarkan (protokol WA
 * Web bukan "beberapa baris"); di-require malas agar daemon tetap
 * jalan walau paket belum di-`npm install`.
 */

const AUTH_DIR = path.join(__dirname, "..", "..", "configs", "wa-auth");

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "whatsapp.json"),
    { number: null, allowed: [], groups: [] }
);

// Logger no-op berbentuk pino (Baileys memanggil .child()/.level).
const silentLogger = {
    level: "silent",
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return silentLogger; }
};

class WhatsAppService {

    constructor() {

        const saved = store.read();

        this.number = saved.number ?? null;
        this.allowed = new Set((saved.allowed ?? []).map(String));
        this.groups = new Set((saved.groups ?? []).map(String));

        this.sock = null;
        this.connected = false;
        this.me = null;                 // { number }
        this.qr = null;                 // data-URL QR untuk dipindai
        this._qrcode = undefined;       // cache require malas
        this.lastError = null;
        this.startedAt = null;

        // Diagnostik pairing (dibaca Console).
        this.state = "idle";            // connecting | open | close
        this.registered = false;
        this.pairingRequested = false;
        this.lastDisconnect = null;     // { code, reason, at }
        this.reconnectAttempts = 0;
        this._reconnectTimer = null;
        this.lastConnectedAt = null;
        this.waVersion = null;

        /**
         * Sesi percakapan kini persisten (SQLite, lintas restart) lewat
         * src/channels — bukan lagi Map dalam memori yang hilang saat
         * daemon mati. Konteks obrolan bisa berlanjut setelah restart.
         */
        /** Jendela sesi grup (jid → kedaluwarsa ms). */
        this.groupSessions = new Map();
        /** Chat yang sedang dilayani â€” dibaca tool kirim media. */
        this.currentChatId = null;

        this._baileys = undefined;      // cache hasil require malas
    }

    /** require Baileys secara malas; null bila belum diinstall. */
    lib() {
        if (this._baileys === undefined) {
            try {
                this._baileys = require("@whiskeysockets/baileys");
            }
            catch {
                this._baileys = null;
            }
        }
        return this._baileys;
    }

    get available() {
        return this.lib() !== null;
    }

    get running() {
        return this.connected;
    }

    parseList(value) {
        if (Array.isArray(value)) {
            return value.map(v => String(v).trim()).filter(Boolean);
        }
        return String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);
    }

    /** Cocokkan jid ke daftar nomor izin (bandingkan digit nomornya). */
    isAllowed(jid) {
        if (this.allowed.size === 0) return false;
        const num = String(jid ?? "").split("@")[0].split(":")[0];
        return this.allowed.has(num);
    }

    isGroupRegistered(jid) {
        // Terima id penuh (xxx@g.us) maupun bagian angkanya.
        return this.groups.has(String(jid)) || this.groups.has(String(jid).split("@")[0]);
    }

    // ---- Siklus koneksi ------------------------------------------

    /** Dipanggil saat boot: sambung diam-diam bila sudah pernah tertaut. */
    async start() {
        if (!this.available) {
            telemetry.info("[whatsapp] paket @whiskeysockets/baileys belum diinstall â€” nonaktif.");
            return this;
        }
        if (fs.existsSync(path.join(AUTH_DIR, "creds.json"))) {
            await this.connect().catch(e => telemetry.warn(`[whatsapp] auto-connect gagal: ${e.message}`));
        }
        return this;
    }

    async connect() {

        const baileys = this.lib();
        if (!baileys) {
            this.lastError = "Paket @whiskeysockets/baileys belum diinstall.";
            throw new Error(this.lastError);
        }

        if (this.sock) return this;    // sudah tersambung/menyambung

        const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

        fs.mkdirSync(AUTH_DIR, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        this.saveCreds = saveCreds;
        this.registered = Boolean(state.creds.registered);
        this.pairingRequested = false;

        // WAJIB: pakai versi WA-web terkini. Tanpa ini Baileys memakai
        // versi bundel yang bisa usang â†’ server WhatsApp menolak tautan
        // ("Cannot link device") lalu mengirim loggedOut, dan registered
        // tak pernah jadi true.
        const { version } = await fetchLatestBaileysVersion();
        this.waVersion = version;

        const sock = makeWASocket({
            version,
            auth: state,
            logger: silentLogger,
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Damar"),
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        this.sock = sock;

        // creds.update: simpan + segarkan status registrasi.
        sock.ev.on("creds.update", async () => {
            await saveCreds();
            this.registered = Boolean(sock.authState.creds.registered);
        });
        sock.ev.on("connection.update", (u) => this.onConnection(u));
        sock.ev.on("messages.upsert", (m) => {
            this.onMessages(m).catch(err =>
                telemetry.warn(`[whatsapp] gagal proses pesan: ${err.message}`));
        });

        return this;
    }

    /** require qrcode secara malas; null bila belum diinstall. */
    qrlib() {
        if (this._qrcode === undefined) {
            try { this._qrcode = require("qrcode"); }
            catch { this._qrcode = null; }
        }
        return this._qrcode;
    }

    /** Ubah string QR Baileys jadi data-URL PNG untuk ditampilkan Console. */
    async renderQr(qr) {
        const lib = this.qrlib();
        if (!lib) {
            this.lastError = "Paket qrcode belum diinstall (npm install qrcode).";
            return null;
        }
        try {
            this.qr = await lib.toDataURL(qr, { margin: 1, width: 300 });
            telemetry.info("[whatsapp] QR siap dipindai (Perangkat Tertaut > Tautkan perangkat).");
            return this.qr;
        }
        catch (error) {
            this.lastError = `Gagal buat QR: ${error.message}`;
            return null;
        }
    }

    onConnection(update) {
        const { connection, lastDisconnect, qr } = update;

        if (connection) this.state = connection;

        // Socket siap â†’ render QR untuk dipindai (tanpa perlu nomor).
        if (qr && !this.registered) {
            this.renderQr(qr).catch(() => {});
        }

        if (connection === "open") {
            this.connected = true;
            this.registered = true;
            this.pairingRequested = false;
            this.qr = null;
            this.lastError = null;
            this.reconnectAttempts = 0;
            this.lastConnectedAt = Date.now();
            this.startedAt ??= Date.now();
            this.me = { number: String(this.sock?.user?.id ?? "").split(":")[0].split("@")[0] };
            telemetry.info(`[whatsapp] tersambung sebagai ${this.me.number}`);
        }

        if (connection === "close") {
            this.connected = false;
            this.pairingRequested = false;

            const DR = this.lib()?.DisconnectReason ?? {};
            const code = lastDisconnect?.error?.output?.statusCode ?? null;

            this.lastDisconnect = {
                code,
                reason: lastDisconnect?.error?.message ?? null,
                at: Date.now()
            };

            const loggedOut = code === (DR.loggedOut ?? 401);
            const wasRegistered = this.registered;

            this.sock = null;

            if (loggedOut) {
                if (wasRegistered) {
                    this.qr = null;
                    telemetry.warn(
                        `[whatsapp] loggedOut (${code}) - tautkan ulang dari Settings.`
                    );
                    return;
                }

                telemetry.warn(
                    `[whatsapp] 401 sebelum pairing selesai - reset auth dan minta QR baru.`
                );

                this.qr = null;

                try {
                    fs.rmSync(AUTH_DIR, {
                        recursive: true,
                        force: true
                    });
                }
                catch (error) {
                    telemetry.warn(
                        `[whatsapp] gagal reset auth state: ${error.message}`
                    );
                }

                this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1;

                clearTimeout(this._reconnectTimer);

                this._reconnectTimer = setTimeout(() => {
                    this.connect().catch(error => {
                        this.lastError = error.message;
                        telemetry.warn(
                            `[whatsapp] pairing reconnect gagal: ${error.message}`
                        );
                    });
                }, 1500);

                return;
            }

            this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1;

            telemetry.info(
                `[whatsapp] connection close (${code}) - reconnect #${this.reconnectAttempts}`
            );

            clearTimeout(this._reconnectTimer);

            this._reconnectTimer = setTimeout(() => {
                this.connect().catch(error => {
                    this.lastError = error.message;
                    telemetry.warn(
                        `[whatsapp] reconnect gagal: ${error.message}`
                    );
                });
            }, 3000);
        }
    }

    async logout() {
        try { await this.sock?.logout(); } catch { /* abaikan */ }
        this.sock = null;
        this.connected = false;
        this.registered = false;
        this.me = null;
        this.qr = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        return this.status();
    }

    stop() {
        try { this.sock?.end?.(); } catch { /* abaikan */ }
        this.sock = null;
        this.connected = false;
    }

    /** Simpan setelan dari Settings lalu (re)connect untuk pairing. */
    async reconfigure({ number, allowed, groups } = {}) {
        const current = store.read();
        const next = {
            number: number !== undefined ? (number || null) : current.number,
            allowed: allowed !== undefined ? this.parseList(allowed) : (current.allowed ?? []),
            groups: groups !== undefined ? this.parseList(groups) : (current.groups ?? [])
        };
        store.write(next);

        this.number = next.number;
        this.allowed = new Set(next.allowed.map(String));
        this.groups = new Set(next.groups.map(String));

        // Bila belum tersambung, mulai koneksi agar QR muncul untuk dipindai.
        if (!this.connected && this.available) {
            await this.connect();
        }
        return this.status();
    }

    // ---- Pesan masuk ---------------------------------------------

    async onMessages({ messages, type }) {
        if (type !== "notify") return;

        for (const msg of messages ?? []) {
            if (!msg.message || msg.key?.fromMe) continue;
            await this.handle(msg).catch(err =>
                telemetry.warn(`[whatsapp] handle gagal: ${err.message}`));
        }
    }

    async handle(msg) {

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith("@g.us");
        const senderJid = isGroup ? (msg.key.participant ?? "") : jid;

        // Konteks permintaan: tool kirim-media membaca tujuan dari sini
        // (AsyncLocalStorage), bukan variabel global yang saling menimpa.
        const channels = require("../channels");

        return channels.manager.runWithContext(
            { channel: "whatsapp", chatId: jid, isGroup },
            () => this._handle(msg, jid, isGroup, senderJid)
        );

    }

    async _handle(msg, jid, isGroup, senderJid) {

        const text = this.extractText(msg).trim();

        // /id & /start selalu boleh (agar pengguna tahu id-nya).
        if (/^\/(id|start)\b/i.test(text)) {
            return this.sendId(jid, senderJid, isGroup);
        }

        // Izin: privat â†’ nomor diizinkan; grup â†’ grup terdaftar ATAU
        // pengirim diizinkan.
        const allowed = isGroup
            ? (this.isGroupRegistered(jid) || this.isAllowed(senderJid))
            : this.isAllowed(jid);

        if (!allowed) {
            if (!isGroup) {
                await this.send(jid,
                    `Maaf, kamu belum diizinkan. Nomor ini: ${jid.split("@")[0]}. ` +
                    "Minta pemilik menambahkannya di Console â†’ Settings â†’ WhatsApp.", msg);
            }
            return;
        }

        // Di grup: hanya respon bila di-mention/di-reply atau sesi aktif.
        if (isGroup) {
            if (this.isTriggered(msg, text) || this.sessionActive(jid)) {
                this.touchSession(jid);
            }
            else {
                return;
            }
        }

        telemetry.publish("whatsapp:message", {
            jid, group: isGroup, preview: text.slice(0, 60)
        });

        // Peran pengirim menentukan tool yang boleh dipakai Damar.
        const role = require("./roleService").roleOf(senderJid.split("@")[0].split(":")[0]);

        const media = this.mediaType(msg);
        if (media) {
            return this.handleMedia(jid, msg, media, this.stripMention(text), role);
        }

        if (text.startsWith("/")) {
            return this.handleCommand(jid, text, msg);
        }

        if (!text) return;

        return this.converse(jid, this.stripMention(text), msg, role);
    }

    extractText(msg) {
        const m = msg.message ?? {};
        return (
            m.conversation ??
            m.extendedTextMessage?.text ??
            m.imageMessage?.caption ??
            m.videoMessage?.caption ??
            m.documentMessage?.caption ??
            ""
        );
    }

    mediaType(msg) {
        const m = msg.message ?? {};
        if (m.imageMessage) return "image";
        if (m.stickerMessage) return "sticker";
        if (m.videoMessage) return "video";
        if (m.audioMessage) return "audio";
        if (m.documentMessage) return "document";
        return null;
    }

    /**
     * Apakah pesan grup ditujukan ke Damar? Cukup salah satu:
     *  1) teks memuat kata "damar" (tanpa perlu mention/reply),
     *  2) reply ke pesan bot, 3) mention @Damar.
     * Deteksi nomor bot toleran (device-suffix / format lid).
     */
    isTriggered(msg, text) {
        // 1) Kata pemicu â€” jalur utama & paling andal.
        //    "aether" = nama LAMA, diterima sebagai kompatibilitas
        //    sapaan; ia menuju identitas yang SAMA (Damar), bukan
        //    identitas kedua. DEPRECATED.
        if (/damar|aether/i.test(text || "")) return true;

        const m = msg.message || {};
        const ctx =
            m.extendedTextMessage?.contextInfo ||
            m.imageMessage?.contextInfo ||
            m.videoMessage?.contextInfo ||
            m.documentMessage?.contextInfo ||
            m.audioMessage?.contextInfo || {};

        const norm = v => String(v ?? "").split(":")[0].split("@")[0].replace(/\D/g, "");
        const meNums = new Set(
            [this.sock?.user?.id, this.me?.number, this.number].map(norm).filter(Boolean)
        );

        // 2) Reply ke pesan bot.
        if (meNums.has(norm(ctx.participant))) return true;
        // 3) Mention @Damar.
        if ((ctx.mentionedJid ?? []).some(j => meNums.has(norm(j)))) return true;

        return false;
    }

    stripMention(text) {
        return String(text ?? "").replace(/@\d+/g, "").trim();
    }

    sessionActive(jid) {
        const until = this.groupSessions.get(jid);
        return until && Date.now() < until;
    }

    touchSession(jid) {
        this.groupSessions.set(jid, Date.now() + 15000);
    }

    async handleCommand(jid, text, msg) {
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();

        switch (cmd.toLowerCase()) {
            case "help":
                return this.send(jid,
                    "Perintah:\n/status â€” kesiapan sistem\n/recall <kata> â€” cari memori\n" +
                    "/reset â€” lupakan konteks\n/id â€” tampilkan id\n\nSelain itu, ketik apa saja untuk ngobrol.", msg);
            case "status":
                return this.sendStatus(jid, msg);
            case "recall":
                return this.sendRecall(jid, arg, msg);
            case "reset":
                await require("../channels").manager.forget(
                    "whatsapp", jid, jid.endsWith("@g.us") ? "group" : "dm"
                );
                return this.send(jid, "Oke, konteks percakapan kukosongkan.", msg);
            default:
                return this.send(jid, `Perintah tidak dikenal: /${cmd}`, msg);
        }
    }

    /** Teruskan ke kognisi Damar; external chat tidak mengeksekusi tool. */
    async converse(jid, text, msg, userRole = "user") {
        const aiRuntime = require("./aiRuntimeService");
        const { manager } = require("../channels");

        const kind = jid.endsWith("@g.us") ? "group" : "dm";

        this.currentChatId = jid;

        // Sesi persisten: muat riwayat + catat giliran pengguna.
        const session = await manager.history("whatsapp", jid, kind);
        session.push({ role: "user", content: text });
        await manager.remember("whatsapp", jid, { role: "user", content: text }, kind);

        this.sock?.sendPresenceUpdate?.("composing", jid).catch(() => {});

        try {
            // Kanal hanya menyumbang konteks dan identitas. Batas AI eksternal
            // bersama menghapus tool sebelum provider/runtime digunakan.
            const response = await aiRuntime.chat({
                messages: session.map(({ role, content }) => ({ role, content })),
                tools: undefined,
                role: userRole,
                channel: "whatsapp",
                sessionId: `whatsapp:${jid}`
            });
            const answer = response.content?.trim() || "(tidak ada jawaban)";
            session.push({ role: "assistant", content: answer });
            await manager.remember("whatsapp", jid, { role: "assistant", content: answer }, kind);
            await this.send(jid, answer, msg);
        }
        catch (error) {
            await this.send(jid, `Maaf, ada kendala: ${error.message}`, msg);
        }
    }

    /** Media masuk: gambar/stiker â†’ vision, dokumen teks â†’ baca,
     *  audio (voice note) â†’ STT, video â†’ thumbnail. */
    async handleMedia(jid, msg, kind, caption, userRole = "user") {
        this.currentChatId = jid;
        this.sock?.sendPresenceUpdate?.("composing", jid).catch(() => {});

        const vision = require("./visionService");

        try {
            if (kind === "image" || kind === "sticker") {
                const buffer = await this.download(msg);
                const r = await vision.analyze({
                    imageBase64: buffer.toString("base64"),
                    mimeType: kind === "sticker" ? "image/webp" : "image/jpeg",
                    prompt: caption || undefined
                });
                return this.replyWithMemory(jid, caption, r.text, "gambar", msg, userRole);
            }

            if (kind === "video") {
                // ponytail: pakai thumbnail bawaan pesan (jpegThumbnail);
                // ekstraksi frame penuh butuh ffmpeg â€” tambah nanti bila perlu.
                const thumb = msg.message?.videoMessage?.jpegThumbnail;
                if (thumb?.length) {
                    const r = await vision.analyze({
                        imageBase64: Buffer.from(thumb).toString("base64"),
                        prompt: (caption || "Deskripsikan isi video ini") + " (dari cuplikan)."
                    });
                    return this.send(jid, `ðŸ“¹ (dari cuplikan)\n${r.text}`, msg);
                }
                return this.send(jid, "Video diterima, tapi tak ada cuplikan untuk dianalisis.", msg);
            }

            if (kind === "audio") {
                const buffer = await this.download(msg);
                try {
                    const stt = require("./voiceService");
                    const { text } = await stt.transcribe(buffer, { mimeType: "audio/ogg", language: "id" });
                    if (text?.trim()) {
                        return this.converse(jid, text.trim(), msg, userRole);
                    }
                }
                catch (error) {
                    if (error.code === "STT_NOT_CONFIGURED") {
                        return this.send(jid, "Voice note diterima, tapi STT belum diatur di Settings â†’ Suara.", msg);
                    }
                    throw error;
                }
                return this.send(jid, "Voice note diterima, tapi tak terdengar isinya.", msg);
            }

            if (kind === "document") {
                const doc = msg.message.documentMessage;
                const mime = doc.mimetype ?? "";
                const name = doc.fileName ?? "berkas";
                if (mime.startsWith("image/")) {
                    const buffer = await this.download(msg);
                    const r = await vision.analyze({
                        imageBase64: buffer.toString("base64"), mimeType: mime, prompt: caption || undefined
                    });
                    return this.replyWithMemory(jid, caption, r.text, "gambar", msg, userRole);
                }
                if (mime.startsWith("text/") || /\.(txt|md|csv|json|log)$/i.test(name)) {
                    const buffer = await this.download(msg);
                    const content = buffer.toString("utf8").slice(0, 6000);
                    return this.converse(jid,
                        `${caption || "Tolong ringkas/analisis isi berkas ini"} (${name}):\n\n${content}`, msg, userRole);
                }

                // PDF / DOCX / format teks lain → lewat extractor memori
                // (pdf-parse & mammoth sudah jadi dependensi).
                if (mime === "application/pdf" || /\.(pdf|docx)$/i.test(name) ||
                    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
                    try {
                        const buffer = await this.download(msg);
                        const text = await this.extractDocument(buffer, name);
                        const potong = text.slice(0, 6000);
                        return this.converse(jid,
                            `${caption || "Tolong ringkas/analisis isi dokumen ini"} (${name}):\n\n${potong}` +
                            (text.length > 6000 ? `\n\n…(dipotong, total ${text.length} karakter)` : ""), msg, userRole);
                    }
                    catch (err) {
                        return this.send(jid, `Berkas "${name}" diterima, tapi gagal kubaca: ${err.message}`, msg);
                    }
                }

                return this.send(jid, `Berkas "${name}" (${mime || "tipe tak dikenal"}) diterima, tapi jenis ini belum bisa kuanalisis.`, msg);
            }
        }
        catch (error) {
            if (error.code === "VISION_NOT_CONFIGURED") {
                return this.send(jid, "Aku terima medianya, tapi model vision belum diatur (Console â†’ Vision).", msg);
            }
            return this.send(jid, `Gagal menganalisis media: ${error.message}`, msg);
        }
    }

    async replyWithMemory(jid, caption, seen, jenis, msg, userRole = "user") {
        if (caption) {
            return this.converse(jid, `[Damar melihat ${jenis}: ${seen}]\n\nPertanyaan: ${caption}`, msg, userRole);
        }
        return this.send(jid, seen, msg);
    }

    /** Unduh media pesan â†’ Buffer. */
    async download(msg) {
        const { downloadMediaMessage } = this.lib();
        return downloadMediaMessage(msg, "buffer", {}, {
            logger: silentLogger,
            reuploadRequest: this.sock.updateMediaMessage
        });
    }

    /**
     * Ekstrak teks dari dokumen (PDF/DOCX/dsb) lewat extractor memori.
     * Ditulis ke berkas sementara karena extractor bekerja pada path,
     * lalu dihapus lagi — isi dokumen tidak disimpan Damar.
     */
    async extractDocument(buffer, name) {

        const os = require("node:os");
        const fsp = require("node:fs/promises");

        const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".bin").toLowerCase();
        const tmp = require("node:path").join(
            os.tmpdir(),
            `damar-wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
        );

        await fsp.writeFile(tmp, buffer);

        try {
            const { extract } = require("../memory/ingest/extractors");
            const { content } = await extract(tmp);
            return content ?? "";
        }
        finally {
            await fsp.unlink(tmp).catch(() => {});
        }

    }

    // ---- Kirim ---------------------------------------------------

    /** Kirim teks, quote pesan asal bila ada. Potong >4096 char. */
    /**
     * Kirim teks, dan LAPORKAN hasilnya.
     *
     * Sebelumnya kegagalan kirim hanya dicatat sebagai warning lalu
     * fungsi ini mengembalikan undefined â€” sehingga tool di atasnya
     * melapor "terkirim" walau pesan gagal sampai. Persis kelas
     * kebohongan yang dilarang Konstitusi Pasal 5.
     *
     * Sekarang id pesan dikembalikan sebagai bukti WhatsApp benar-
     * benar menerimanya, dan kegagalan dinyatakan terus terang.
     */
    async send(jid, text, quoted = null) {

        const opts = quoted ? { quoted } : {};
        const ids = [];
        const errors = [];

        for (const chunk of this.splitMessage(String(text ?? ""))) {

            try {
                const res = await this.sock?.sendMessage(jid, { text: chunk }, opts);
                if (res?.key?.id) ids.push(res.key.id);
            }
            catch (err) {
                telemetry.warn(`[whatsapp] gagal kirim: ${err.message}`);
                errors.push(err.message);
            }

        }

        return {
            sent: errors.length === 0 && ids.length > 0,
            messageIds: ids,
            errors,
            jid
        };

    }

    async sendPhoto(jid, url, caption) {
        return this.sock?.sendMessage(jid, { image: { url }, caption: caption || undefined });
    }

    async sendDocument(jid, url, caption, fileName = "berkas") {
        return this.sock?.sendMessage(jid, { document: { url }, fileName, caption: caption || undefined });
    }

    /** Kirim gambar dari Buffer (mis. hasil unduh Immich / berkas lokal). */
    async sendPhotoBuffer(jid, buffer, caption) {
        return this.sock?.sendMessage(jid, { image: buffer, caption: caption || undefined });
    }

    /** Kirim dokumen dari Buffer dengan nama & tipe yang benar. */
    async sendDocumentBuffer(jid, buffer, caption, fileName = "berkas", mimetype = "application/octet-stream") {
        return this.sock?.sendMessage(jid, {
            document: buffer,
            fileName,
            mimetype,
            caption: caption || undefined
        });
    }

    async sendSticker(jid, url) {
        return this.sock?.sendMessage(jid, { sticker: { url } });
    }

    async sendReaction(jid, key, emoji = "ðŸ‘") {
        return this.sock?.sendMessage(jid, { react: { text: emoji, key } });
    }

    async broadcast(text) {
        if (!this.connected || this.allowed.size === 0) return 0;
        for (const num of this.allowed) {
            await this.send(`${num}@s.whatsapp.net`, text);
        }
        return this.allowed.size;
    }

    /**
     * Daftar grup yang nomor Damar SUDAH tergabung â€” supaya di Settings
     * pengguna tinggal memilih grup mana yang diizinkan (tanpa ketik id).
     */
    async listGroups() {
        if (!this.connected || !this.sock) return [];
        try {
            const chats = await this.sock.groupFetchAllParticipating();
            return Object.values(chats || {})
                .map(g => ({
                    id: g.id,
                    subject: g.subject || g.id,
                    size: (g.participants || []).length,
                    allowed: this.groups.has(String(g.id))
                }))
                .sort((a, b) => a.subject.localeCompare(b.subject));
        }
        catch (error) {
            this.lastError = `Gagal ambil daftar grup: ${error.message}`;
            return [];
        }
    }

    splitMessage(text, limit = 4000) {
        if (text.length <= limit) return [text];
        const chunks = [];
        for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
        return chunks;
    }

    // ---- Perintah bawaan ----------------------------------------

    async sendStatus(jid, msg) {
        const s = telemetry.stats();
        let providerLine = "";
        try {
            const aiRuntime = require("./aiRuntimeService");
            const p = await aiRuntime.providers();
            providerLine = `\nAI: ${p.active} Â· model ${aiRuntime.defaultModel ?? "default"}`;
        }
        catch { /* opsional */ }
        await this.send(jid,
            `Damar aktif âœ…\nCPU ${s.cpu.usage}% Â· RAM ${s.memory.usedPercent}%` +
            `\nUptime ${Math.round(s.daemon.uptime / 60)} menit${providerLine}`, msg);
    }

    async sendRecall(jid, query, msg) {
        if (!query) return this.send(jid, "Contoh: /recall ulang tahun", msg);
        const memory = require("../memory/services/MemoryService");
        const result = await memory.recall(query, { limit: 5 });
        if (result.items.length === 0) return this.send(jid, "Tidak ada memori yang cocok.", msg);
        await this.send(jid, "Yang kuingat:\n" + result.items.map(i => `â€¢ ${i.content}`).join("\n"), msg);
    }

    sendId(jid, senderJid, isGroup) {
        const num = (isGroup ? senderJid : jid).split("@")[0];
        const groupId = isGroup ? `\nId grup ini: ${jid}` : "";
        return this.send(jid,
            `Nomor kamu: ${num}${groupId}\n\n` +
            "Untuk mengaktifkan, tambahkan di Console â†’ Settings â†’ WhatsApp " +
            "(nomor izin, atau id grup bila ini grup).", jid.endsWith("@g.us") ? null : undefined);
    }

    status() {
        return {
            available: this.available,
            configured: Boolean(this.number) || this.connected,
            connected: this.connected,
            state: this.state,
            registered: Boolean(this.registered),
            number: this.me?.number ?? null,
            qr: this.qr,
            pairNumber: this.number,
            allowed: [...this.allowed],
            allowedCount: this.allowed.size,
            groups: [...this.groups],
            groupCount: this.groups.size,
            lastError: this.lastError,
            lastDisconnect: this.lastDisconnect
                ? { ...this.lastDisconnect, at: new Date(this.lastDisconnect.at).toISOString() }
                : null,
            reconnectAttempts: this.reconnectAttempts,
            connectedAt: this.lastConnectedAt ? new Date(this.lastConnectedAt).toISOString() : null,
            startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
            waVersion: this.waVersion ? this.waVersion.join(".") : null,
            note: this.available ? null : "Jalankan: npm install @whiskeysockets/baileys"
        };
    }
}

module.exports = new WhatsAppService();


