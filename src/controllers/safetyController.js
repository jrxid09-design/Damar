const response = require("../utils/response");
const telemetry = require("../services/telemetryService");
const killSwitch = require("../core/safety/killSwitch");
const riskPolicy = require("../core/safety/riskPolicy");
const { riskOf, summarize } = require("../core/safety/riskCatalog");

/**
 * Kendali kill switch (§37).
 *
 * Membaca keadaan sengaja TIDAK diblokir saat berhenti — pemilik
 * harus tetap bisa melihat apa yang terjadi dan melepaskannya.
 */
/**
 * Seluruh tool yang kini tunduk pada rantai keselamatan.
 *
 * Dua registry, bukan satu: plugin di registry inti, dan tool asli
 * model (memori, rumah, WhatsApp, terminal, coding) di registry AI.
 * Panel yang hanya menghitung registry inti membuat pemilik melihat
 * 80 tool padahal yang diatur jauh lebih banyak — dan tidak
 * menemukan `terminal_run` saat ingin memberi izin.
 *
 * Tool jembatan dilewati karena ia hanya nama lain dari tool inti
 * yang sudah terhitung.
 *
 * Fungsi modul, bukan metode: handler dipasang ke router tanpa
 * terikat instance, sehingga `this` di dalamnya tidak tersedia.
 */
function governedToolIds() {

    const ids = [];

    try {
        const { ToolRegistry } = require("../core/tools");
        for (const t of ToolRegistry.describe() ?? []) {
            if (t.id ?? t.name) ids.push(t.id ?? t.name);
        }
    }
    catch { /* diabaikan */ }

    try {
        const ai = require("../services/aiRuntimeService");
        const registry = ai?.engine?.runtime?.toolRegistry;
        for (const t of registry?.all?.() ?? []) {
            if (t?.name && !t.bridged) ids.push(t.name);
        }
    }
    catch { /* runtime AI mungkin belum disiapkan */ }

    return ids;

}

class SafetyController {

    status(req, res) {

        let risk = null;

        try {
            const ids = governedToolIds();
            const ringkas = summarize(ids);
            risk = { total: ids.length, ...ringkas };
        }
        catch { /* ringkasan risiko tidak boleh menjatuhkan status */ }

        return response.success(res, "Status keselamatan", {
            ...killSwitch.state(),
            engaged: killSwitch.isEngaged(),
            policy: riskPolicy.state(),
            risk
        });

    }

    /**
     * Jejak audit tool (§96).
     *
     * Dibaca dari berkas, bukan dari memori: peristiwa yang hanya
     * hidup di RAM hilang persis saat paling dibutuhkan — setelah
     * proses mati.
     */
    trail(req, res) {

        const auditTrail = require("../core/safety/auditTrail");

        const limit = Math.min(Number(req.query?.limit) || 100, 500);

        return response.success(res, "Jejak audit", {
            entries: auditTrail.recent({
                limit,
                tool: req.query?.tool || null,
                outcome: req.query?.outcome || null
            }),
            summary: auditTrail.summary(),
            retentionDays: auditTrail.RETENTION_DAYS
        });

    }

    /** Apakah satu tool tergolong destruktif — dipakai UI sebelum menawarkan aksi. */
    riskOfTool(req, res) {
        const id = req.params.id;
        return response.success(res, "Risiko tool", { tool: id, destructive: riskOf(id) });
    }

    stop(req, res) {

        const reason = req.body?.reason || "permintaan pengguna";
        const actor = req.body?.actor || "user";

        const result = killSwitch.engage({ reason, actor });

        // Jejak audit (§96): siapa, apa, kenapa, hasil.
        telemetry.publish("safety:stop", { actor, reason, alreadyEngaged: result.alreadyEngaged });
        telemetry.warn(`[safety] STOP ditarik oleh ${actor} — ${reason}`);

        return response.success(res, "Damar dihentikan", result);

    }

    release(req, res) {

        if (req?.canonicalManagerControl !== true) {
            return response.error(res,
                "Safety release requires canonical Manager control.", 503);
        }

        const actor = req.body?.actor || "user";

        const result = killSwitch.release({ actor });

        telemetry.publish("safety:release", { actor, wasEngaged: result.wasEngaged });
        telemetry.info(`[safety] STOP dilepas oleh ${actor}`);

        return response.success(res, "Damar dilanjutkan", result);

    }

}

module.exports = new SafetyController();
