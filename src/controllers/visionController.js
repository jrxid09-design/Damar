const response = require("../utils/response");

const vision = require("../services/visionService");
const deviceService = require("../services/deviceService");

function fail(res, error) {
    const code = error.code === "VISION_NOT_CONFIGURED" ? 400 : 502;
    return response.error(res, error.message, code);
}

class VisionController {

    status(req, res, next) {
        try {
            return response.success(res, "Vision status", vision.status());
        }
        catch (error) {
            next(error);
        }
    }

    config(req, res, next) {
        try {
            return response.success(res, "Vision config", vision.configView());
        }
        catch (error) {
            next(error);
        }
    }

    saveConfig(req, res, next) {
        try {
            return response.success(res, "Konfigurasi vision disimpan",
                vision.setConfig(req.body ?? {}));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    /** Analisis gambar yang dikirim renderer (base64) — mis. frame webcam. */
    async analyze(req, res, next) {

        try {

            const { image, mimeType, prompt } = req.body ?? {};

            if (!image) {
                return response.error(res, "Field 'image' (base64) wajib diisi.", 400);
            }

            const result = await vision.analyze({
                imageBase64: image,
                mimeType: mimeType ?? "image/jpeg",
                prompt
            });

            return response.success(res, "Analisis selesai", result);

        }
        catch (error) {
            return fail(res, error);
        }

    }

    // ---- Kamera --------------------------------------------------

    cameras(req, res, next) {
        try {
            return response.success(res, "Cameras", { cameras: deviceService.cameras() });
        }
        catch (error) {
            next(error);
        }
    }

    addCamera(req, res, next) {
        try {
            return response.success(res, "Kamera ditambahkan",
                deviceService.addCamera(req.body ?? {}), 201);
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    removeCamera(req, res, next) {
        try {
            return response.success(res, "Kamera dihapus", {
                removed: deviceService.removeCamera(req.params.id)
            });
        }
        catch (error) {
            next(error);
        }
    }

    /**
     * Proxy snapshot kamera: daemon yang mengambil gambar (dengan
     * header/auth kamera) lalu meneruskan byte-nya ke renderer.
     * Dipakai untuk pratinjau "live" — renderer me-refresh <img> ini
     * berkala, jadi tak perlu akses langsung ke kamera (hindari CORS).
     */
    async snapshot(req, res, next) {

        try {

            const cam = deviceService.getCamera(req.params.id);

            if (!cam) {
                return response.error(res, "Kamera tidak ditemukan.", 404);
            }

            const upstream = await fetch(cam.snapshotUrl, {
                headers: cam.headers ?? {},
                signal: AbortSignal.timeout(8000)
            });

            if (!upstream.ok) {
                return response.error(res, `Kamera balas ${upstream.status}`, 502);
            }

            const buffer = Buffer.from(await upstream.arrayBuffer());

            res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
            res.setHeader("Cache-Control", "no-store");

            return res.end(buffer);

        }
        catch (error) {
            return response.error(res, `Snapshot gagal: ${error.message}`, 502);
        }

    }

    /**
     * Layani berkas media untuk presenter Console.
     *
     * Tool (show_image/send_file) kadang hanya punya PATH LOKAL —
     * renderer Electron tidak bisa memuat path daemon begitu saja,
     * apalagi gambar besar yang melebihi batas data URI (2 MB).
     * Endpoint ini mengalirkan berkasnya langsung; akses dibatasi
     * ke folder yang diizinkan pathPolicy (downloads/, data/, dan
     * sumber media yang sudah lolos pemeriksaan tool).
     */
    async rawFile(req, res, next) {

        try {

            const fs = require("node:fs");
            const path = require("node:path");
            const pathPolicy = require("../../core/safety/pathPolicy");

            const target = path.resolve(String(req.query.path ?? ""));

            if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
                return response.error(res, "Berkas tidak ditemukan.", 404);
            }

            // Jalur yang diizinkan: folder kerja Aether (downloads/,
            // data/) — cukup untuk media yang dihasilkan tool. Path
            // sistem sensitif tetap ditolak oleh pathPolicy.
            const allowedRoots = [
                path.join(process.cwd(), "downloads"),
                path.join(process.cwd(), "data")
            ];

            const ok = allowedRoots.some(root =>
                target.startsWith(root + path.sep) || target === root
            ) || isMediaSourceAllowed(target);

            if (!ok) {
                return response.error(res, "Jalur berkas tidak diizinkan.", 403);
            }

            const ext = path.extname(target).toLowerCase();
            const mime = {
                ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
                ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
                ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8"
            }[ext] ?? "application/octet-stream";

            res.setHeader("Content-Type", mime);
            res.setHeader("Cache-Control", "no-store");
            fs.createReadStream(target).pipe(res);

        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Proksi gambar Immich. Elemen <img> di Console tak bisa mengirim
     * header x-api-key, sehingga URL Immich langsung (mis.
     * http://host:2283/api/assets/ID/thumbnail) selalu 401 dan foto
     * tampil BLANK/hanya judul. Di sini daemon-lah yang mengambilnya
     * dengan API key lalu meneruskan bytenya ke Console.
     *
     * Anti-SSRF: hanya host Immich yang terkonfigurasi yang boleh
     * di-fetch — parameter url tak bisa dipakai menembak host lain.
     */
    async immichProxy(req, res, next) {
        try {
            const immich = require("../services/immichService");
            if (!immich.configured) {
                return response.error(res, "Immich belum dikonfigurasi.", 503);
            }

            // Jalur UTAMA: berdasarkan asset id → assetBuffer memakai
            // endpoint yang benar untuk versi Immich ini. (Di v3.1.0,
            // /api/assets/ID/thumbnail 404; /api/assets/ID/original 200 —
            // assetBuffer menangani fallback thumbnail→original.)
            const id = String(req.query.id ?? "").trim();
            if (id) {
                const kind = req.query.kind === "thumbnail" ? "thumbnail" : "original";
                const { buffer, mime } = await immich.assetBuffer(id, { kind });
                res.setHeader("Content-Type", mime);
                res.setHeader("Content-Length", buffer.length);
                res.setHeader("Cache-Control", "private, max-age=300");
                return res.end(buffer);
            }

            // Jalur cadangan: passthrough URL (mis. /api/people/ID/thumbnail),
            // hanya untuk host Immich terkonfigurasi (anti-SSRF).
            const raw = String(req.query.url ?? "");
            if (!raw) return response.error(res, "Param 'id' atau 'url' wajib.", 400);

            let target;
            try { target = new URL(raw); }
            catch { return response.error(res, "URL tidak valid.", 400); }

            if (target.host !== new URL(immich.url).host) {
                return response.error(res, "Host tidak diizinkan.", 403);
            }

            const upstream = await fetch(target.href, {
                headers: { "x-api-key": immich.key },
                signal: AbortSignal.timeout(30000)
            });
            if (!upstream.ok) return response.error(res, `Immich ${upstream.status}`, 502);

            const buffer = Buffer.from(await upstream.arrayBuffer());
            res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
            res.setHeader("Content-Length", buffer.length);
            res.setHeader("Cache-Control", "private, max-age=300");
            res.end(buffer);

        }
        catch (error) {
            next(error);
        }
    }

    /** Ambil snapshot kamera lalu analisis dengan model vision. */
    async seeCamera(req, res, next) {
        try {

            const cam = deviceService.getCamera(req.params.id);

            if (!cam) {
                return response.error(res, "Kamera tidak ditemukan.", 404);
            }

            const result = await vision.analyzeUrl({
                url: cam.snapshotUrl,
                headers: cam.headers ?? {},
                prompt: req.body?.prompt,
                // N2-FINAL: giliran visi mewarisi identitas pemanggil HTTP.
                exec: req.authIdentity ?? null,
                // D-FINAL: URL dari registry kamera pemilik → trusted-lan.
                policy: "trusted-lan"
            });

            return response.success(res, "Analisis kamera selesai", {
                camera: cam.id,
                ...result
            });

        }
        catch (error) {
            return fail(res, error);
        }

    }

}

/**
 * Sumber media di luar folder kerja yang boleh dilayani presenter:
 * folder capture kamera (data/captures) & salinan sementara tool.
 * Diperluas sewaktu-waktu tanpa membuka seluruh filesystem.
 */
function isMediaSourceAllowed(target) {
    const path = require("node:path");
    const extra = [
        path.join(process.cwd(), "data", "captures"),
        path.join(process.cwd(), "downloads", "chat-uploads")
    ];
    return extra.some(root => target.startsWith(root + path.sep));
}

module.exports = new VisionController();
