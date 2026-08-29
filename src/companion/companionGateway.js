/**
 * CompanionGateway — pintu masuk device tertaut ke Damar Core.
 *
 * Device TIDAK punya otak sendiri: ia meneruskan permintaan ke jalur AI
 * yang SAMA dengan Telegram/WhatsApp/Console/Voice — `aiRuntime.chat()`.
 * Dengan begitu ToolSelector, context budgeting, memory, consciousness,
 * MCP tools, dan audit trail SEMUA otomatis berlaku. Tidak ada AI loop
 * kedua, tidak ada tool system duplikat.
 *
 * Device juga bisa memakai MCP server Damar langsung (POST /mcp) untuk
 * daftar/panggil tool; gateway ini menambah jalur CHAT natural-language.
 */
const { manager: channelManager } = require("../channels");

const PEER = "device";

class CompanionGateway {

    constructor({ registry = null, aiRuntime = null } = {}) {

        this.registry = registry;          // DeviceRegistry (di-set dari index)
        this.aiRuntime = aiRuntime ?? null; // injectable untuk tes

    }

    /** Autentikasi device dari header/token; null bila tak sah. */
    authenticate(token) {
        return this.registry?.authenticate(token) ?? null;
    }

    /** Jalur chat: teks → aiRuntime (channel "device"). */
    async chat(device, text) {

        const aiRuntime = this.aiRuntime ?? require("../services/aiRuntimeService");

        const deviceId = device?.id ?? "device";

        // Konteks sesi per device (persisten, via ChannelManager).
        const history = await channelManager.history("device", deviceId, "dm");

        history.push({ role: "user", content: String(text) });

        const answer = await channelManager.runWithContext(
            { channel: "device", chatId: deviceId },
            async () => {
                const res = await aiRuntime.chat({
                    messages: history.map(({ role, content }) => ({ role, content })),
                    tools: undefined, // → ToolSelector otomatis
                    channel: "device"
                });
                return res.content?.trim() || "(tidak ada jawaban)";
            }
        );

        await channelManager.remember("device", deviceId, { role: "user", content: String(text) }, "dm");
        await channelManager.remember("device", deviceId, { role: "assistant", content: answer }, "dm");

        return { answer, device: deviceId };

    }

    /**
     * Jalur chat STREAMING (SSE): delta dikirim ke onDelta seiring token
     * datang; giliran tetap dipersist utuh di akhir. Jalur AI-nya SAMA
     * (aiRuntime.stream → withMind → ToolSelector), hanya transportnya
     * yang mengalir.
     *
     * @returns {Promise<{answer}>} jawaban lengkap setelah stream selesai
     */
    async chatStream(device, text, onDelta = () => {}) {

        const aiRuntime = this.aiRuntime ?? require("../services/aiRuntimeService");

        const deviceId = device?.id ?? "device";

        const history = await channelManager.history("device", deviceId, "dm");
        history.push({ role: "user", content: String(text) });

        let answer = "";

        await channelManager.runWithContext(
            { channel: "device", chatId: deviceId },
            async () => {
                for await (const chunk of aiRuntime.stream({
                    messages: history.map(({ role, content }) => ({ role, content })),
                    tools: undefined,
                    channel: "device"
                })) {
                    if (chunk?.delta) {
                        answer += chunk.delta;
                        try { onDelta(chunk.delta, chunk); } catch { /* konsumen */ }
                    }
                }
            }
        );

        if (!answer.trim()) answer = "(tidak ada jawaban)";

        await channelManager.remember("device", deviceId, { role: "user", content: String(text) }, "dm");
        await channelManager.remember("device", deviceId, { role: "assistant", content: answer }, "dm");

        return { answer };

    }

    /** Simpan lampiran dari device → data/companion-uploads/. */
    saveUpload({ name, data, mimeType }) {

        const fs = require("node:fs");
        const path = require("node:path");
        const crypto = require("node:crypto");

        const dir = process.env.DAMAR_COMPANION_UPLOAD_DIR
            || path.join(process.cwd(), "data", "companion-uploads");

        fs.mkdirSync(dir, { recursive: true });

        const buffer = Buffer.from(String(data ?? ""), "base64");

        if (!buffer.length) {
            throw new Error("Lampiran kosong.");
        }

        if (buffer.length > 10 * 1024 * 1024) {
            throw new Error("Lampiran terlalu besar (maks 10 MB).");
        }

        // Nama berkas KITA yang generate — jangan percaya nama klien
        // (anti path-traversal).
        const ext = path.extname(String(name ?? "")).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8) || ".bin";
        const file = crypto.randomUUID().slice(0, 12) + ext;

        const full = path.join(dir, file);

        fs.writeFileSync(full, buffer);

        return {
            name: String(name ?? file).slice(0, 120),
            file,
            url: `/api/v1/companion/media/${file}`,
            path: full,
            bytes: buffer.length,
            mimeType: mimeType ?? "application/octet-stream"
        };

    }

    /** Baca berkas lampiran untuk disajikan (null bila tak sah/tak ada). */
    readUpload(file) {

        const fs = require("node:fs");
        const path = require("node:path");

        // Hanya nama berkas polos — anti path-traversal.
        if (!/^[A-Za-z0-9_-]+\.[a-z0-9]{1,6}$/i.test(String(file))) return null;

        const dir = process.env.DAMAR_COMPANION_UPLOAD_DIR
            || path.join(process.cwd(), "data", "companion-uploads");

        const full = path.join(dir, file);

        try {
            return { buffer: fs.readFileSync(full), full };
        }
        catch {
            return null;
        }

    }

    /** Tipe konten untuk berkas lampiran. */
    static contentTypeOf(file) {

        const ext = String(file).split(".").pop().toLowerCase();

        return {
            jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
            gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg",
            wav: "audio/wav", ogg: "audio/ogg", webm: "video/webm",
            mp4: "video/mp4", pdf: "application/pdf", txt: "text/plain"
        }[ext] ?? "application/octet-stream";

    }

    /** Daftar tool/skill yang tersedia (delegasi ke registry Damar). */
    tools() {

        try {
            const { ToolRegistry } = require("../core/tools");
            return ToolRegistry.describe();
        }
        catch {
            return [];
        }

    }

    /** Status gateway (untuk observability). */
    status() {
        return {
            devices: this.registry?.publicList() ?? [],
            deviceCount: this.registry?.all().filter(d => !d.revoked).length ?? 0
        };
    }

}

module.exports = { CompanionGateway };
