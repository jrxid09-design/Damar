const response = require("../utils/response");

const aiRuntime = require("../services/aiRuntimeService");
const providerConfig = require("../services/providerConfigService");

const telemetry = require("../services/telemetryService");

/**
 * Dari pintu mana permintaan ini datang.
 *
 * Console dan CLI sama-sama bicara ke endpoint HTTP yang sama, jadi
 * hanya klien yang tahu bedanya — ia menyebut dirinya lewat body
 * `channel` atau header `x-damar-channel`. Klien lama yang tidak
 * menyebut apa-apa dianggap Console: itu pemakaian terbanyak, dan
 * salah tebak di sini hanya membuat satu kalimat konteks jadi
 * kurang tepat, bukan menggagalkan permintaan.
 */
const KANAL_SAH = new Set(["console", "cli", "whatsapp", "telegram"]);

function channelOf(req) {
    const raw = String(
        req.body?.channel
        ?? req.get?.("x-damar-channel")
        // Ejaan LAMA (pra-rename) tetap dibaca supaya klien lama tidak
        // putus. DEPRECATED — kanonik: x-damar-channel. Header ini
        // hanya memilih KONTEKS kanal; ia tidak pernah memberi otoritas.
        ?? req.get?.("x-aether-channel")
        ?? ""
    ).toLowerCase().trim();
    return KANAL_SAH.has(raw) ? raw : "console";
}

/**
 * Coba daftar model dengan konfigurasi aktif untuk memastikan
 * key valid & baseUrl benar — sekaligus mengingatkan bila model
 * belum dipilih. Tidak melempar; hasilnya untuk ditampilkan.
 */
async function verifyActive(resolved) {

    const active = aiRuntime.activePlatform ?? {};

    if (resolved.kind === "llamacpp" || active.kind === "llamacpp") {
        return { ok: true, note: "Otak lokal (llama.cpp) aktif." };
    }

    const platform = active.id;
    const model = active.model;

    if (!model) {
        return {
            ok: false,
            reason: "no_model",
            note: `Key ${resolved.platform ?? "tersimpan"}, tapi MODEL belum dipilih. ` +
                  "Pilih model di dropdown (yang bertanda free/verified)."
        };
    }

    // Uji model yang DIPILIH dengan generateContent minimal — inilah
    // yang 404 kalau usang. Bila gagal, pindah otomatis ke pengganti.
    const check = await aiRuntime.verifyModel(platform, model);

    if (check.ok) {
        return { ok: true, note: `Terverifikasi — ${model} bisa dipakai.` };
    }

    const next = await aiRuntime.pickWorkingDefault(platform);

    if (next && next !== model) {
        providerConfig.setProvider(platform, { model: next });
        aiRuntime.reconfigure();
        return {
            ok: true,
            switched: true,
            model: next,
            note: `Model "${model}" tak tersedia (${check.reason}). Otomatis pindah ke "${next}".`
        };
    }

    return {
        ok: false,
        reason: check.reason,
        note: `Model "${model}" tak tersedia (${check.reason}) dan tak ada pengganti terverifikasi.`
    };

}

class AIController {

    /** Konfigurasi provider untuk Settings (API key dimasking). */
    config(req, res, next) {

        try {
            return response.success(res, "AI config", providerConfig.describe());
        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Simpan setelan provider dari Settings lalu bangun ulang engine.
     * Body: { active?, provider?:{id,apiKey?,baseUrl?,model?} }
     */
    async saveConfig(req, res, next) {

        try {

            const { active, provider } = req.body ?? {};

            if (provider?.id) {
                providerConfig.setProvider(provider.id, {
                    apiKey: provider.apiKey,
                    baseUrl: provider.baseUrl,
                    model: provider.model
                });
            }

            if (active) {
                providerConfig.setActive(active);
            }

            const result = aiRuntime.reconfigure();

            // Verifikasi langsung: coba daftar model dengan key ini.
            // Beri jawaban jelas — key valid? model sudah dipilih? —
            // ketimbang pengguna menebak kenapa "tidak bekerja".
            const verify = await verifyActive(result);

            return response.success(res, "Konfigurasi disimpan", {
                ...providerConfig.describe(),
                reconfigured: result,
                verify
            });

        }

        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async providers(req, res, next) {

        try {
            return response.success(
                res,
                "AI providers",
                await aiRuntime.providers()
            );
        }
        catch (error) {
            next(error);
        }

    }

    async selectProvider(req, res, next) {

        try {

            const { id } = req.body;

            if (!id) {
                return response.error(res, "Field 'id' is required.", 400);
            }

            return response.success(res, "Provider switched", {
                active: aiRuntime.switchProvider(id)
            });

        }
        catch (error) {
            next(error);
        }

    }

    async models(req, res, next) {

        try {

            const provider = req.query.provider;

            return response.success(res, "Available models", {
                provider: provider ?? aiRuntime.ensure().activeProviderId,
                defaultModel: aiRuntime.defaultModel,
                models: await aiRuntime.models(provider)
            });

        }
        catch (error) {
            next(error);
        }

    }

    /** Verifikasi seluruh kandidat model (OPT-IN — memakai kuota). */
    async verifyModels(req, res, next) {

        try {
            aiRuntime.ensure();
            const platform = aiRuntime.activePlatform?.id ?? "lokal";
            return response.success(res, "Verifikasi model", await aiRuntime.verifyAll(platform));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async selectModel(req, res, next) {

        try {

            const { model } = req.body;

            if (!model) {
                return response.error(res, "Field 'model' is required.", 400);
            }

            return response.success(res, "Default model updated", {
                defaultModel: aiRuntime.setDefaultModel(model)
            });

        }
        catch (error) {
            next(error);
        }

    }

    metrics(req, res, next) {

        try {
            return response.success(res, "AI metrics", aiRuntime.metrics());
        }
        catch (error) {
            next(error);
        }

    }

    usage(req, res, next) {
        try {
            const usage = require("../services/usageService");
            return response.success(res, "Pemakaian AI", {
                today: usage.today(),
                history: usage.history(Math.min(Number(req.query.days ?? 14), 30))
            });
        }
        catch (error) {
            next(error);
        }
    }

    async chat(req, res, next) {

        try {

            const { messages, model, temperature, maxTokens } = req.body;

            if (!Array.isArray(messages) || messages.length === 0) {
                return response.error(res, "Field 'messages' is required.", 400);
            }

            const result = await aiRuntime.chat({
                messages,
                model,
                temperature,
                maxTokens,
                channel: channelOf(req),
                // Identitas BERPROVENANCE dari gerbang token (C2):
                // role hanya superadmin bila kredensial pemilik sah.
                role: req.authIdentity?.role ?? "user",
                sessionId: req.authIdentity?.sessionId ?? `console:${channelOf(req)}`
            });

            return response.success(res, "Chat completed", result);

        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Streaming lewat SSE.
     *
     * Error setelah header terkirim tidak bisa lagi jadi respons
     * HTTP 500, jadi dikirim sebagai event "error" agar klien
     * tetap tahu apa yang gagal alih-alih menggantung.
     */
    async stream(req, res) {

        const { messages, model, temperature, maxTokens } = req.body;

        if (!Array.isArray(messages) || messages.length === 0) {
            return response.error(res, "Field 'messages' is required.", 400);
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });

        const send = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        let aborted = false;

        // Harus `res`, bukan `req`: pada Express 5 event "close"
        // milik req menyala segera setelah body selesai dibaca,
        // sehingga stream akan dikira dibatalkan sebelum token
        // pertama sempat datang.
        res.on("close", () => {
            aborted = true;
        });

        try {

            send("start", {
                provider: aiRuntime.ensure().activeProviderId,
                model: model ?? aiRuntime.defaultModel
            });

            for await (const chunk of aiRuntime.stream({
                messages,
                model,
                temperature,
                maxTokens,
                channel: channelOf(req)
            })) {

                if (aborted) {
                    break;
                }

                // Bidang inti tetap selalu ada; metadata ekstra
                // (reasoning, usage, id/model/provider) hanya bila
                // provider mengirimkannya — konsumen lama yang tak
                // mengenalnya tetap aman.
                const data = {
                    delta: chunk.delta,
                    toolCalls: chunk.toolCalls,
                    done: chunk.done,
                    finishReason: chunk.finishReason
                };

                if (chunk.reasoning != null) {
                    data.reasoning = chunk.reasoning;
                }

                if (chunk.usage) {
                    data.usage = chunk.usage;
                }

                if (chunk.id != null) {
                    data.id = chunk.id;
                }

                if (chunk.model != null) {
                    data.model = chunk.model;
                }

                if (chunk.provider != null) {
                    data.provider = chunk.provider;
                }

                send("chunk", data);

            }

            if (!aborted) {
                send("done", { ok: true });
            }

        }

        catch (error) {

            telemetry.error(`Stream gagal: ${error.message}`);

            if (!aborted) {
                send("error", { message: error.message });
            }

        }

        finally {
            res.end();
        }

    }

}

module.exports = new AIController();
