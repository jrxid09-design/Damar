const fs = require("node:fs");
const path = require("node:path");

const { AITool } = require("../ai/tools");

const pathPolicy = require("../core/safety/pathPolicy");
const telemetry = require("./telemetryService");

const MAX_BYTES = 45 * 1024 * 1024;   // batas aman WA/Telegram

/**
 * Tool kirim media — Aether bisa mengirim foto/video/dokumen dari
 * galeri Immich, berkas lokal (NAS/disk komputer), atau URL ke chat
 * WhatsApp/Telegram yang sedang berlangsung, atau menampilkannya
 * di Console.
 *
 * Sumber di-resolve menjadi Buffer sekali, lalu disalurkan ke kanal
 * yang sedang aktif.
 */

/** Ambil media dari sumber → { buffer, mime, name }. */
async function resolveSource({ assetId, path: filePath, url }) {

    if (assetId) {
        const immich = require("./immichService");
        const { buffer, mime } = await immich.assetBuffer(assetId);
        return { buffer, mime, name: `immich-${assetId.slice(0, 8)}` };
    }

    if (filePath) {

        // Jalan sama dengan filesystem tool: sandbox jalur tetap menjaga.
        pathPolicy.assertPathAllowed(filePath, false);

        const abs = path.resolve(filePath);
        const stat = fs.statSync(abs);

        if (!stat.isFile()) {
            throw new Error(`"${abs}" bukan berkas.`);
        }

        if (stat.size > MAX_BYTES) {
            throw new Error(`Berkas terlalu besar (${Math.round(stat.size / 1048576)} MB > 45 MB).`);
        }

        const buffer = fs.readFileSync(abs);
        const name = path.basename(abs);

        return { buffer, mime: mimeOf(name), name };

    }

    if (url) {

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);

        try {

            const res = await fetch(String(url), { signal: controller.signal });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const buffer = Buffer.from(await res.arrayBuffer());

            if (buffer.length > MAX_BYTES) {
                throw new Error("Berkas dari URL terlalu besar (> 45 MB).");
            }

            const name = path.basename(new URL(String(url)).pathname) || "berkas";

            return {
                buffer,
                mime: res.headers.get("content-type") ?? mimeOf(name),
                name
            };

        }
        finally {
            clearTimeout(timer);
        }

    }

    throw new Error("Sebutkan sumber: asset_id (Immich), path (berkas lokal), atau url.");

}

function mimeOf(name) {

    const ext = path.extname(String(name)).toLowerCase();

    return {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
        ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".zip": "application/zip"
    }[ext] ?? "application/octet-stream";

}

/** Kanal yang sedang aktif: whatsapp | telegram | console. */
function activeChannel() {

    const wa = require("./whatsappService");
    if (wa.running && wa.currentChatId) {
        return { kind: "whatsapp", id: wa.currentChatId };
    }

    const tg = require("./telegramService");
    if (tg.running && tg.currentChatId) {
        return { kind: "telegram", id: tg.currentChatId };
    }

    return { kind: "console", id: null };

}

/**
 * Kirim media yang sudah di-resolve ke kanal tujuan.
 * `kind`: "image" | "video" | "document"
 */
async function deliver(channel, { buffer, mime, name }, kind, caption) {

    if (channel.kind === "whatsapp") {

        const wa = require("./whatsappService");

        if (kind === "image") {
            await wa.sendPhotoBuffer(channel.id, buffer, caption);
        }
        else if (kind === "video") {
            await wa.sock?.sendMessage(channel.id, { video: buffer, caption: caption || undefined });
        }
        else {
            await wa.sendDocumentBuffer(channel.id, buffer, caption, name, mime);
        }

        return { via: "whatsapp", to: channel.id };

    }

    if (channel.kind === "telegram") {

        const tg = require("./telegramService");

        if (kind === "image") {
            await tg.sendPhoto(channel.id, buffer, caption);
        }
        else {
            await tg.sendDocument(channel.id, buffer, caption, name);
        }

        return { via: "telegram", to: channel.id };

    }

    // Console: tampilkan di panel presentasi.
    // Data URI untuk gambar besar bisa membuat browser macet; batasi
    // ke ukuran wajar (2 MB) dan beri tahu bila dipotong.
    const MAX_INLINE = 2 * 1024 * 1024; // 2 MB
    let url;
    let note = null;

    if (buffer.length <= MAX_INLINE) {
        url = `data:${mime};base64,${buffer.toString("base64")}`;
    }
    else {
        // Gambar terlalu besar untuk data URI — simpan sementara
        // dan layani lewat endpoint daemon (di luar jangkauan tool ini).
        // Untuk sekarang: beri tahu ukurannya.
        note = `Gambar ${Math.round(buffer.length / 1048576)} MB terlalu besar untuk ditampilkan inline.`;
        url = null;
    }

    telemetry.publish("aether:present", {
        kind: kind === "image" ? "image" : kind === "video" ? "video" : "document",
        url,
        caption: caption ?? name,
        note
    });

    return { via: "console", note };

}

function mediaShareTools() {

    const kindParam = {
        type: "string",
        enum: ["image", "video", "document"],
        description: "Jenis media. Default: dokumen (atau image bila jelas gambar)."
    };

    return [

        new AITool({
            name: "send_immich_photo",
            description:
                "Kirim foto/video SPESIFIK dari galeri Immich ke chat yang sedang berlangsung " +
                "(WhatsApp/Telegram) atau tampilkan di Console. " +
                "WAJIB: Cari dulu asset_id yang tepat lewat search_photos dengan nama orang " +
                "(mis. search_photos person:'ronny'), lalu pakai id dari hasilnya. " +
                "Jangan menebak asset_id — selalu cari dulu.",
            parameters: {
                type: "object",
                properties: {
                    asset_id: { type: "string", description: "ID aset Immich (dari search_photos)." },
                    caption: { type: "string", description: "Keterangan (opsional)." },
                    kind: kindParam
                },
                required: ["asset_id"]
            },
            execute: async ({ asset_id, caption, kind }) => {

                const media = await resolveSource({ assetId: asset_id });

                const finalKind = kind ?? (media.mime.startsWith("video/") ? "video" : "image");

                const sent = await deliver(activeChannel(), media, finalKind, caption);

                return { ok: true, ...sent, kind: finalKind, bytes: media.buffer.length };

            }
        }),

        new AITool({
            name: "send_file",
            description:
                "Kirim berkas/dokumen/foto dari penyimpanan lokal (NAS, disk komputer) " +
                "ke chat WhatsApp/Telegram yang sedang berlangsung, atau tampilkan di " +
                "Console. Pakai saat pengguna minta dikirimi berkas tertentu.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Path berkas lokal (mis. D:\\\\foto\\\\a.jpg)." },
                    caption: { type: "string", description: "Keterangan (opsional)." },
                    kind: kindParam
                },
                required: ["path"]
            },
            execute: async ({ path: p, caption, kind }) => {

                const media = await resolveSource({ path: p });

                const finalKind = kind ??
                    (media.mime.startsWith("image/") ? "image"
                        : media.mime.startsWith("video/") ? "video" : "document");

                const sent = await deliver(activeChannel(), media, finalKind, caption);

                return { ok: true, ...sent, kind: finalKind, name: media.name, bytes: media.buffer.length };

            }
        }),

        new AITool({
            name: "send_media_url",
            description:
                "Kirim media dari sebuah URL (http/https) ke chat WhatsApp/Telegram " +
                "yang sedang berlangsung, atau tampilkan di Console.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL media." },
                    caption: { type: "string", description: "Keterangan (opsional)." },
                    kind: kindParam
                },
                required: ["url"]
            },
            execute: async ({ url, caption, kind }) => {

                const media = await resolveSource({ url });

                const finalKind = kind ??
                    (media.mime.startsWith("image/") ? "image"
                        : media.mime.startsWith("video/") ? "video" : "document");

                const sent = await deliver(activeChannel(), media, finalKind, caption);

                return { ok: true, ...sent, kind: finalKind, name: media.name, bytes: media.buffer.length };

            }
        })

    ];

}

module.exports = { mediaShareTools };
