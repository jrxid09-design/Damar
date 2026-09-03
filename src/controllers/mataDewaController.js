/**
 * Controller Mata Dewa — permukaan Console API (read-only + intent).
 *
 * Semua endpoint read-only boleh diakses Console yang terautentikasi.
 * Setiap aksi yang mengubah state (aktivasi mode, watch, dsb.) melewati
 * `managerOnly` (rejectLegacyActionMiddleware) sehingga tetap di bawah
 * otoritas Manager kanonik — Mata Dewa tidak pernah menjadi bypass aksi.
 */

const response = require("../utils/response");
const mataDewa = require("../mataDewa");

function service() {
    return mataDewa.getService();
}

class MataDewaController {

    status(req, res, next) {
        try {
            return response.success(res, "Mata Dewa status", service().status());
        }
        catch (error) { next(error); }
    }

    health(req, res, next) {
        try {
            return response.success(res, "Mata Dewa health", service().health());
        }
        catch (error) { next(error); }
    }

    mode(req, res, next) {
        try {
            const s = service();
            return response.success(res, "Mata Dewa mode", {
                mode: s.mode, uiMode: s.uiMode, operatingModes: [...s.operatingModes]
            });
        }
        catch (error) { next(error); }
    }

    providers(req, res, next) {
        try {
            return response.success(res, "Mata Dewa providers", service().registry.listProviders());
        }
        catch (error) { next(error); }
    }

    /** Query spasial sesuai permintaan (ASK). Read-only terhadap dunia nyata. */
    async ask(req, res, next) {
        try {
            const types = Array.isArray(req.body?.types) ? req.body.types : [];
            const bounds = req.body?.bounds ?? null;
            const result = await service().ask({ types, bounds });
            return response.success(res, "Mata Dewa ask", result);
        }
        catch (error) { next(error); }
    }

    /** Observasi terkini dekat sebuah titik (read-only, dari indeks). */
    near(req, res, next) {
        try {
            const lat = Number(req.query.lat);
            const lon = Number(req.query.lon);
            const radiusM = Number(req.query.radiusM ?? 25000);
            const hits = service().observationsNear({ lat, lon }, radiusM)
                .map(h => ({
                    distanceM: Math.round(h.distanceM),
                    observation: h.observation
                }));
            return response.success(res, "Mata Dewa near", { center: { lat, lon }, radiusM, hits });
        }
        catch (error) { next(error); }
    }

    /** Snapshot ringkas untuk permukaan renderer (globe/HUD/layers). */
    surface(req, res, next) {
        try {
            const s = service();
            return response.success(res, "Mata Dewa surface", {
                mode: s.mode,
                uiMode: s.uiMode,
                state: s.state,
                providers: s.registry.listProviders(),
                observations: [...s.observations.values()]
            });
        }
        catch (error) { next(error); }
    }

    // ---- Intent di bawah otoritas Manager (digandeng managerOnly) --------

    activate(req, res, next) {
        try {
            const result = service().activateMode();
            if (!result.ok) return response.error(res, result.reason, 400);
            return response.success(res, "Mode Mata Dewa aktif", result);
        }
        catch (error) { next(error); }
    }

    deactivate(req, res, next) {
        try {
            const result = service().deactivateMode();
            if (!result.ok) return response.error(res, result.reason, 400);
            return response.success(res, "Mode Mata Dewa nonaktif", result);
        }
        catch (error) { next(error); }
    }

    // ---- Kredensial provider (vault kanonik; nilai TIDAK pernah kembali) --

    credentials(req, res, next) {
        try {
            const store = service().credentialStore;
            return response.success(res, "Kredensial Mata Dewa", {
                configuredProviders: store.listProviderIds(),
                availabilityMode: store.availabilityMode(service().registry.listProviders())
            });
        }
        catch (error) { next(error); }
    }

    /** Pasang kredensial provider ke vault. Nilai tidak pernah dikembalikan. */
    setCredential(req, res, next) {
        try {
            const { providerId, value } = req.body ?? {};
            const store = service().credentialStore;
            const result = store.setCredential(providerId, value);
            if (!result.ok) return response.error(res, result.reason, 400);
            return response.success(res, "Kredensial tersimpan di vault (SecretRef saja)", {
                providerId, configured: true
            });
        }
        catch (error) { next(error); }
    }

    removeCredential(req, res, next) {
        try {
            const result = service().credentialStore.removeCredential(req.params.providerId);
            if (!result.ok) return response.error(res, result.reason, 404);
            return response.success(res, "Kredensial dihapus", { providerId: req.params.providerId });
        }
        catch (error) { next(error); }
    }
}

module.exports = new MataDewaController();
