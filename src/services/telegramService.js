const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");

/**
 * Jembatan Telegram — remote control Aether lewat Bot API.
 *
 * Long-polling (tanpa webhook): bot menarik pesan baru tiap beberapa
 * detik, meneruskannya ke core Aether yang sama dengan Console &
 * WhatsApp (aiRuntimeService), lalu membalas hasilnya.
 *
 * Keamanan: tanpa allowlist, bot hanya menjawab /id (supaya pemilik
 * tahu chat id-nya). Dengan allowlist, hanya chat id terdaftar yang
 * boleh mengendalikan Aether.
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "telegram.json"),
    { token: null, allowed: [], groups: [] }
);

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

        /** Sesi percakapan per chat id (20 giliran terakhir). */
        this.sessions = new Map();

        /** Chat terakhir yang aktif — untuk tool kirim media. */
        this.currentChatId = null;

    }

    cfg() {
        return store.read();
    }

    /** Token dari config, fallback ke .env. */
    resolveToken() {
        return (
            this.cfg().token ||
            process.env.AETHER_TELEGRAM_TOKEN ||
            null
        );
    }

    /** Daftar chat id yang boleh, dari config + .env. */
    allowedIds() {

        const fromCfg = this.cfg().allowed ?? [];

        const fromEnv = String(process.env.AETHER_TELEGRAM_ALLOWED ?? "")
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
            const e = new Error("Token Telegram belum diatur (configs/telegram.json atau AETHER_TELEGRAM_TOKEN).");
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

    async handle(msg) {

        const chatId = msg?.chat?.id;
        const text = String(msg?.text ?? "").trim();

        if (!chatId || !text) return;

        // /id & /start selalu boleh — agar pemilik tahu chat id-nya.
        if (/^\/(id|start)\b/i.test(text)) {

            return this.send(chatId,
                `Halo! Chat id kamu: ${chatId}\n` +
                `Tambahkan ke AETHER_TELEGRAM_ALLOWED atau configs/telegram.json ` +
                `(field "allowed") untuk mengendalikan Aether.`
            );

        }

        if (!this.isAllowed(chatId)) {

            return this.send(chatId,
                `Maaf, kamu belum diizinkan. Chat id ini: ${chatId}. ` +
                `Minta pemilik menambahkannya ke allowlist Telegram.`
            );

        }

        telemetry.publish("telegram:message", {
            chatId, preview: text.slice(0, 60)
        });

        return this.converse(chatId, text);

    }

    /** Teruskan ke core Aether yang sama dengan Console & WhatsApp. */
    async converse(chatId, text) {

        const aiRuntime = require("./aiRuntimeService");
        const roleService = require("./roleService");

        this.currentChatId = chatId;

        const session = this.sessions.get(chatId) ?? [];
        session.push({ role: "user", content: text });

        // Penanda "mengetik…".
        this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

        try {

            // Nomor Telegram bukan nomor WA; perlakuan peran memakai
            // id chat. Bila allowlist aktif, pengirim sudah terverifikasi
            // sebagai pemilik → superadmin.
            const role = "superadmin";

            const response = await aiRuntime.chat({
                messages: session.map(({ role: r, content }) => ({ role: r, content })),
                tools: roleService.toolsFor(role, aiRuntime.tools()),
                channel: "telegram"
            });

            const answer = response.content?.trim() || "(tidak ada jawaban)";

            session.push({ role: "assistant", content: answer });
            while (session.length > 20) session.shift();
            this.sessions.set(chatId, session);

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
            startedAt: this.startedAt
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
