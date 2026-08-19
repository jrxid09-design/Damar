const response = require("../utils/response");
const nasService = require("../services/nasService");
const immichDeploy = require("../services/immichDeployService");
const backup = require("../services/backupService");
const notify = require("../services/notifyService");
const nasMonitor = require("../services/nasMonitorService");

class NasController {

    async status(req, res, next) {
        try { return response.success(res, "NAS status", await nasService.status()); }
        catch (error) { next(error); }
    }

    async config(req, res, next) {
        try {
            const c = nasService.config();
            // Jangan bocorkan password DB Immich.
            return response.success(res, "NAS config", { pool: c.pool, quotaPercent: c.alerts?.quotaPercent ?? 90 });
        }
        catch (error) { next(error); }
    }

    async setConfig(req, res, next) {
        try {
            const c = nasService.setConfig(req.body ?? {});
            return response.success(res, "NAS config disimpan", { pool: c.pool, quotaPercent: c.alerts?.quotaPercent ?? 90 });
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    // ---- Notifikasi & pemantau ----------------------------------

    async testNotify(req, res, next) {
        try { return response.success(res, "Uji notifikasi", await notify.send("🔔 Uji notifikasi Aether NAS — kanal WhatsApp aktif.")); }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async monitorCheck(req, res, next) {
        try { return response.success(res, "Pemeriksaan disk", await nasMonitor.check()); }
        catch (error) { next(error); }
    }

    // ---- Immich (app center) -------------------------------------

    async immichStatus(req, res, next) {
        try { return response.success(res, "Immich status", await immichDeploy.status()); }
        catch (error) { next(error); }
    }

    async immichUp(req, res, next) {
        try { return response.success(res, "Immich dinyalakan", immichDeploy.up()); }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async immichDown(req, res, next) {
        try { return response.success(res, "Immich dimatikan", await immichDeploy.down()); }
        catch (error) { return response.error(res, error.message, 400); }
    }

    // ---- Storage Spaces (RAID) — baca saja ----------------------

    async pools(req, res, next) {
        try { return response.success(res, "Storage pools", await nasService.pools()); }
        catch (error) { next(error); }
    }

    // ---- Backup terjadwal ---------------------------------------

    async backups(req, res, next) {
        try { return response.success(res, "Backup jobs", { jobs: backup.list() }); }
        catch (error) { next(error); }
    }

    async addBackup(req, res, next) {
        try { return response.success(res, "Job backup dibuat", backup.add(req.body ?? {}), 201); }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async runBackup(req, res, next) {
        try { return response.success(res, "Backup dijalankan", await backup.run(req.params.id)); }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async removeBackup(req, res, next) {
        try { return response.success(res, "Job backup dihapus", backup.remove(req.params.id)); }
        catch (error) { return response.error(res, error.message, 400); }
    }

}

module.exports = new NasController();
