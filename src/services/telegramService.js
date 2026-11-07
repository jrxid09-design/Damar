const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");
const totp = require("../core/auth/totp");

/**
 * Jembatan Telegram — remote control Damar lewat Bot API.
 *
 * Long-polling (tanpa webhook): bot menarik pesan baru tiap beberapa
 * detik, meneruskannya ke core Damar yang sama dengan Console &
 * WhatsApp (aiRuntimeService), lalu membalas hasilnya.
 *
 * Keamanan: tanpa allowlist, bot hanya menjawab /id (supaya pemilik
 * tahu chat id-nya). Dengan allowlist, hanya chat id terdaftar yang
 * boleh mengendalikan Damar.
 *
 * MODE PENUH (mirip Console): penghuni allowlist defaultnya berada di
 * mode TERBATAS — chat biasa tanpa tool destruktif. Untuk membuka
 * kemampuan penuh (tool-calling, terminal, file, dll.) ia memasukkan
 * kode dari Google Authenticator lewat /masuk <kode>. Kode diverifikasi
 * TOTP (RFC 6238); mode penuh berlaku beberapa jam lalu otomatis
 * kembali terbatas. /keluar dapat mempercepatnya.
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "telegram.json"),
    { token: null, allowed: [], groups: [] }
);

/** Secret TOTP mode penuh (satu secret global — pemilik satu orang). */
const TOTP_CONFIG_PATH =
    process.env.DAMAR_TOTP_CONFIG ||
    path.join(__dirname, "..", "..", "configs", "totp.json");
const totpStore = new JsonStore(TOTP_CONFIG_PATH, { secret: null, setupAt: null });

/** Berapa lama mode penuh bertahan setelah /masuk berhasil (jam). */
const FULL_MODE_TTL_HOURS = 8;

class TelegramService {

    constructor() {

        this.token = null;
        this.offset = 0;
        this.pollTimer = null;
        this.running = false;
        this.connected = false;
        this.lastError = null;
        this.me = null;
        this.startedAt = null;

        /**
         * Sesi percakapan kini persisten (SQLite, lintas restart) lewat
         * src/channels — bukan lagi Map dalam memori.
         */
        /** Chat terakhir yang aktif — untuk tool kirim media. */
        this.currentChatId = null;

        /**
         * Mode penuh per chat id: { chatId → expiryEpochMs }.
         * Di map (bukan JsonStore) karena sifatnya sementara & tak
         * perlu persisten lintas restart daemon.
         */
        this.fullModeUntil = new Map();

    }

    cfg() {
        return store.read();
    }

    /** Token dari config, fallback ke .env. */
    resolveToken() {
        return (
            this.cfg().token ||
            process.env.DAMAR_TELEGRAM_TOKEN ||
            null
        );
    }

    /** Daftar chat id yang boleh, dari config + .env. */
    allowedIds() {

        const fromCfg = this.cfg().allowed ?? [];

        const fromEnv = String(process.env.DAMAR_TELEGRAM_ALLOWED ?? "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);

        return new Set([...fromCfg, ...fromEnv]);

    }

    get configured() {
        return Boolean(this.resolveToken());
    }

    /** Panggil Bot API. */
    async api(method, body = null, timeout = 30000) {

        const token = this.resolveToken();

        if (!token) {
            const e = new Error("Token Telegram belum diatur (configs/telegram.json atau DAMAR_TELEGRAM_TOKEN).");
            e.code = "TELEGRAM_NOT_CONFIGURED";
            throw e;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {

            const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
                method: body ? "POST" : "GET",
                headers: body ? { "Content-Type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            const data = await res.json().catch(() => null);

            if (!res.ok || data?.ok === false) {
                throw new Error(data?.description ?? `Telegram ${res.status}`);
            }

            return data?.result ?? data;

        }
        finally {
            clearTimeout(timer);
        }

    }

    async start() {

        if (this.running) return this;

        if (!this.configured) {
            telemetry.info("[telegram] belum dikonfigurasi — dilewati");
            return this;
        }

        this.running = true;

        try {
            this.me = await this.api("getMe", null, 12000);
            this.connected = true;
            this.lastError = null;
            this.startedAt = Date.now();
            telemetry.info(`[telegram] bot aktif sebagai @${this.me?.username ?? this.me?.id}`);
        }
        catch (error) {
            this.connected = false;
            this.lastError = error.message;
            telemetry.warn(`[telegram] getMe gagal: ${error.message}`);
        }

        this.poll();

        return this;

    }

    stop() {

        this.running = false;
        this.connected = false;
        clearTimeout(this.pollTimer);
        this.pollTimer = null;

    }

    /** Long-polling getUpdates. */
    async poll() {

        if (!this.running) return;

        try {

            const updates = await this.api("getUpdates", {
                offset: this.offset,
                timeout: 25,
                allowed_updates: ["message"]
            }, 35000);

            for (const u of updates ?? []) {

                this.offset = u.update_id + 1;

                if (u.message) {
                    this.handle(u.message).catch(err =>
                        telemetry.warn(`[telegram] handle gagal: ${err.message}`));
                }

            }

            this.connected = true;

        }
        catch (error) {

            this.connected = false;
            this.lastError = error.message;

            // Jeda lebih panjang saat error jaringan.
            this.pollTimer = setTimeout(() => this.poll(), 5000);
            return;

        }

        if (this.running) {
            this.pollTimer = setTimeout(() => this.poll(), 400);
        }

    }

    isAllowed(chatId) {

        const allowed = this.allowedIds();

        // Tanpa allowlist: hanya /id yang boleh (lihat handle).
        if (allowed.size === 0) return false;

        return allowed.has(String(chatId));

    }

    // ---- Mode penuh (TOTP) -----------------------------------------

    /** Apakah chat ini sedang dalam mode penuh (sudah /masuk). */
    inFullMode(chatId) {
        const until = this.fullModeUntil.get(String(chatId));
        if (!until) return false;
        if (Date.now() >= until) {
            this.fullModeUntil.delete(String(chatId));
            return false;
        }
        return true;
    }

    /** Perintah TOTP & mode penuh; true bila pesan dikonsumsi. */
    async handleFullModeCommand(chatId, text) {

        const m = /^\/(masuk|keluar|totp)\b(?:\s+(\S+))?/i.exec(text);

        if (!m) return false;

        const cmd = m[1].toLowerCase();

        // /totp setup — buat secret baru & tampilkan URL utk QR.
        if (cmd === "totp") {

            if ((m[2] ?? "").toLowerCase() !== "setup") {
                await this.send(chatId,
                    "Pemakaian: /totp setup — membuat secret baru untuk Google Authenticator."
                );
                return true;
            }

            const { secret, otpauthUrl } = totp.generateSecret({
                account: String(chatId),
                issuer: "Damar"
            });

            totpStore.write({ secret, setupAt: new Date().toISOString() });

            await this.send(chatId,
                "Secret TOTP baru dibuat. Scan QR dari URL ini dengan " +
                "Google Authenticator (atau app TOTP lain):\n\n" +
                otpauthUrl + "\n\n" +
                "Secret manual (bila tak bisa scan):\n" + secret + "\n\n" +
                "Setelah terpasang, kirim /masuk <kode 6-digit> untuk " +
                "masuk mode penuh. Secret LAMA otomatis tidak berlaku."
            );
            return true;
        }

        // /keluar — turun dari mode penuh.
        if (cmd === "keluar") {
            const was = this.fullModeUntil.delete(String(chatId));
            await this.send(chatId,
                was ? "Mode penuh ditutup. Kembali ke mode terbatas."
                    : "Kamu memang tidak sedang dalam mode penuh."
            );
            return true;
        }

        // /masuk <kode> — verifikasi TOTP, naik ke mode penuh.
        const kode = (m[2] ?? "").replace(/\D/g, "");

        if (!kode) {
            await this.send(chatId,
                "Kirim /masuk <kode 6-digit dari Google Authenticator> " +
                "untuk membuka mode penuh. Belum punya secret? /totp setup."
            );
            return true;
        }

        const secret = totpStore.read().secret;

        if (!secret) {
            await this.send(chatId,
                "TOTP belum disetup. Jalankan /totp setup dulu, scan " +
                "QR-nya dengan Google Authenticator, lalu /masuk <kode>."
            );
            return true;
        }

        if (!totp.verify(secret, kode)) {
            telemetry.publish("telegram:fullmode:denied", { chatId });
            await this.send(chatId,
                "Kode salah atau kedaluwarsa. Coba kode terbaru dari " +
                "Google Authenticator-mu."
            );
            return true;
        }

        this.fullModeUntil.set(String(chatId), Date.now() + FULL_MODE_TTL_HOURS * 3600_000);
        telemetry.publish("telegram:fullmode:granted", { chatId, hours: FULL_MODE_TTL_HOURS });

        await this.send(chatId,
            `Mode penuh aktif untuk ${FULL_MODE_TTL_HOURS} jam — Damar ` +
            `di sini kini setara dengan Console untuk kognisi; aksi tetap ` +
            `memerlukan jalur Manager. ` +
            `/keluar untuk menutup lebih awal.`
        );
        return true;
    }

    async handle(msg) {

        const chatId = msg?.chat?.id;
        const text = String(msg?.text ?? "").trim();

        if (!chatId || !text) return;

        // Konteks permintaan (AsyncLocalStorage) untuk tool kirim-media.
        const channels = require("../channels");

        return channels.manager.runWithContext(
            { channel: "telegram", chatId: String(chatId) },
            () => this._handle(chatId, text)
        );

    }

    async _handle(chatId, text) {

        // /id & /start selalu boleh — agar pemilik tahu chat id-nya.
        if (/^\/(id|start)\b/i.test(text)) {

            return this.send(chatId,
                `Halo! Chat id kamu: ${chatId}\n` +
                `Tambahkan ke DAMAR_TELEGRAM_ALLOWED atau configs/telegram.json ` +
                `(field "allowed") untuk mengendalikan Damar.`
            );

        }

        if (!this.isAllowed(chatId)) {

            return this.send(chatId,
                `Maaf, kamu belum diizinkan. Chat id ini: ${chatId}. ` +
                `Minta pemilik menambahkannya ke allowlist Telegram.`
            );

        }

        // /reset — kosongkan konteks percakapan (paritas WhatsApp).
        if (/^\/reset\b/i.test(text)) {
            await require("../channels").manager.forget("telegram", chatId, "dm");
            return this.send(chatId, "Oke, konteks percakapan kukosongkan.");
        }

        // Perintah mode penuh (TOTP) — diproses sebelum converse.
        if (await this.handleFullModeCommand(chatId, text)) return;

        telemetry.publish("telegram:message", {
            chatId, preview: text.slice(0, 60)
        });

        return this.converse(chatId, text);

    }

    /** Teruskan ke core Damar yang sama dengan Console & WhatsApp. */
    async converse(chatId, text) {

        const aiRuntime = require("./aiRuntimeService");
        const { manager } = require("../channels");

        this.currentChatId = chatId;

        // Sesi persisten: muat riwayat + catat giliran pengguna.
        const session = await manager.history("telegram", chatId, "dm");
        session.push({ role: "user", content: text });
        await manager.remember("telegram", chatId, { role: "user", content: text }, "dm");

        // Penanda "mengetik…".
        this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

        try {

            // Peran ditentukan oleh MODE PENUH (TOTP), bukan otomatis
            // superadmin. Tanpa /masuk, pemilik yang sudah di-allowlist
            // pun hanya dapat mode "user". External channel chat is
            // cognition-only; any action must enter the Damar Manager.
            const role = this.inFullMode(chatId) ? "superadmin" : "user";

            // The channel supplies context and identity only. The shared
            // external AI boundary strips tools before provider/runtime use.
            const response = await aiRuntime.chat({
                messages: session.map(({ role: r, content }) => ({ role: r, content })),
                tools: undefined,
                role,
                channel: "telegram",
                // Identitas sesi untuk rem kebuntuan & audit scoped.
                sessionId: `telegram:${chatId}`
            });

            const answer = response.content?.trim() || "(tidak ada jawaban)";

            session.push({ role: "assistant", content: answer });
            await manager.remember("telegram", chatId, { role: "assistant", content: answer }, "dm");

            await this.send(chatId, answer);

        }
        catch (error) {
            await this.send(chatId, `Maaf, ada kendala: ${error.message}`);
        }

    }

    /** Kirim teks, dipotong per 4096 karakter (batas Telegram). */
    async send(chatId, text) {

        const chunks = [];
        let rest = String(text ?? "");

        while (rest.length > 0) {
            chunks.push(rest.slice(0, 4096));
            rest = rest.slice(4096);
        }

        if (!chunks.length) chunks.push("(kosong)");

        const ids = [];

        for (const c of chunks) {

            const r = await this.api("sendMessage", {
                chat_id: chatId,
                text: c
            });

            if (r?.message_id) ids.push(r.message_id);

        }

        return { messageIds: ids };

    }

    /** Kirim foto dari Buffer. Di atas batas foto Telegram (10 MB)
     *  otomatis dikirim sebagai dokumen agar tetap sampai. */
    async sendPhoto(chatId, buffer, caption) {

        if (buffer.length > 10 * 1024 * 1024) {
            return this.sendDocument(chatId, buffer, caption, "foto.jpg");
        }

        return this.sendMedia(chatId, "sendPhoto", "photo", buffer, caption, "photo.jpg");
    }

    /** Kirim dokumen/berkas dari Buffer. */
    async sendDocument(chatId, buffer, caption, fileName = "berkas") {
        return this.sendMedia(chatId, "sendDocument", "document", buffer, caption, fileName);
    }

    /**
     * Kirim media via multipart/form-data (Bot API menerima upload
     * langsung). Node 24 punya FormData & Blob bawaan.
     */
    async sendMedia(chatId, method, field, buffer, caption, fileName) {

        const token = this.resolveToken();

        if (!token) {
            const e = new Error("Token Telegram belum diatur.");
            e.code = "TELEGRAM_NOT_CONFIGURED";
            throw e;
        }

        const form = new FormData();
        form.append("chat_id", String(chatId));
        if (caption) form.append("caption", String(caption).slice(0, 1024));
        form.append(field, new Blob([buffer]), fileName);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);

        try {

            const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
                method: "POST",
                body: form,
                signal: controller.signal
            });

            const data = await res.json().catch(() => null);

            if (!res.ok || data?.ok === false) {
                throw new Error(data?.description ?? `Telegram ${res.status}`);
            }

            return { messageId: data?.result?.message_id ?? null };

        }
        finally {
            clearTimeout(timer);
        }

    }

    /** Keadaan untuk panel Settings. */
    status() {

        return {
            configured: this.configured,
            connected: this.connected,
            running: this.running,
            me: this.me ? { id: this.me.id, username: this.me.username } : null,
            allowed: [...this.allowedIds()],
            lastError: this.lastError,
            startedAt: this.startedAt,
            fullMode: {
                totpConfigured: Boolean(totpStore.read().secret),
                activeChats: [...this.fullModeUntil.entries()]
                    .filter(([, until]) => Date.now() < until)
                    .map(([chatId, until]) => ({ chatId, until: new Date(until).toISOString() }))
            }
        };

    }

    /** Simpan konfigurasi dari Settings. */
    setConfig({ token, allowed, groups } = {}) {

        const cur = this.cfg();

        store.write({
            token: token !== undefined ? (token || null) : cur.token,
            allowed: allowed !== undefined
                ? (Array.isArray(allowed) ? allowed.map(String) : String(allowed).split(",").map(s => s.trim()).filter(Boolean))
                : (cur.allowed ?? []),
            groups: groups !== undefined ? groups : (cur.groups ?? [])
        });

        // Token baru → sambung ulang.
        if (token !== undefined) {
            this.stop();
            this.start().catch(() => {});
        }

        return this.status();

    }

}

module.exports = new TelegramService();
