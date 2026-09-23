const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");
const { executeCanonicalAction } = require("./canonicalActionClient");

/**
 * backupService — salinan terjadwal folder → NAS. NON-DESTRUKTIF:
 * robocopy /E (Windows) / rsync -a tanpa --delete (POSIX) hanya
 * MENAMBAH/menimpa, tak pernah menghapus di tujuan. Job dibuat pengguna
 * (default kosong, jadi tak ada yang jalan tanpa diminta).
 *
 * Jadwal sederhana berbasis interval jam; scheduler ringan mengecek job
 * yang jatuh tempo tiap 15 menit.
 */

const FILE = process.env.DAMAR_BACKUP_FILE
    || path.join(__dirname, "..", "..", "configs", "nas-backup.json");
const store = new JsonStore(FILE, { jobs: [] });

function jobs() { return store.read().jobs || []; }
function save(list) { store.write({ jobs: list }); }

/** Pure: job yang jatuh tempo pada waktu `now`. */
function dueJobs(list, now = Date.now()) {
    return list.filter(j => {
        if (j.paused) return false;
        const every = (Number(j.intervalHours) || 24) * 3600e3;
        return !j.lastRun || (now - new Date(j.lastRun).getTime()) >= every;
    });
}

function add({ name, source, dest, intervalHours = 24 } = {}) {
    if (!source || !dest) throw new Error("Sumber dan tujuan wajib diisi.");
    if (!fs.existsSync(source)) throw new Error(`Folder sumber tak ada: ${source}`);
    const list = jobs();
    const job = {
        id: "bk_" + crypto.randomBytes(4).toString("hex"),
        name: name || path.basename(source),
        source, dest,
        intervalHours: Math.max(1, Number(intervalHours) || 24),
        notify: true,
        paused: false, lastRun: null, lastStatus: null, lastLog: null,
        createdAt: new Date().toISOString()
    };
    save([...list, job]);
    return job;
}

function remove(id) {
    save(jobs().filter(j => j.id !== id));
    return { removed: id };
}

async function copy(source, dest, context = null) {
    return executeCanonicalAction({
        context,
        capabilityId: "damar.backup",
        operation: "copy",
        arguments: { source, dest },
        expectedPostcondition: { expect: { exists: { op: "eq", value: true }, commandOk: { op: "eq", value: true } } }
    });
}

async function run(id, context = null) {
    const list = jobs();
    const job = list.find(j => j.id === id);
    if (!job) throw new Error("Job tak ditemukan.");
    telemetry.info(`[backup] mulai '${job.name}': ${job.source} → ${job.dest}`);
    const r = await copy(job.source, job.dest, context);
    job.lastRun = new Date().toISOString();
    job.lastStatus = r.outcome === "COMPLETED" ? "ok" : "gagal";
    job.lastLog = `${r.outcome ?? "UNKNOWN"} ${r.reason ?? ""}`.slice(-2000);
    save(list);
    telemetry[job.lastStatus === "ok" ? "info" : "warn"](`[backup] '${job.name}' ${job.lastStatus} (${r.outcome ?? "unknown"})`);

    if (job.notify !== false) {
        const emoji = job.lastStatus === "ok" ? "✅" : "⚠️";
        require("./notifyService").send(
            `${emoji} Backup "${job.name}" ${job.lastStatus}.\n` +
            `${job.source} → ${job.dest}\n${new Date().toLocaleString("id-ID")}`
        );
    }
    return { id, status: job.lastStatus, outcome: r.outcome ?? "UNKNOWN", reason: r.reason ?? null };
}

async function tick() {
    for (const j of dueJobs(jobs())) {
        try { await run(j.id); }
        catch (e) { telemetry.warn(`[backup] tick ${j.id}: ${e.message}`); }
    }
}

let timer = null;
function start() {
    if (timer) return;
    timer = setInterval(() => tick().catch(() => {}), 15 * 60 * 1000);
    timer.unref?.();
}
start();   // scheduler ringan mulai saat modul dimuat

module.exports = { list: jobs, add, remove, run, dueJobs, tick, start };
