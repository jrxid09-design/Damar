const os = require("node:os");
const fsx = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const JsonStore = require("../core/config/JsonStore");

const pexec = promisify(execFile);
const OPTS = { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 };

// Konfigurasi NAS per-mesin (disk pool + rahasia Immich). Gitignored.
const cfgStore = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "nas.json"),
    { pool: null, immich: {} }
);

/** Baca config; buat DB password Immich sekali bila belum ada. */
function config() {
    const c = cfgStore.read();
    if (!c.immich || !c.immich.dbPassword) {
        cfgStore.write({ immich: { ...(c.immich || {}), dbPassword: crypto.randomBytes(12).toString("hex") } });
    }
    return cfgStore.read();
}

/** Set disk pool NAS + ambang kuota peringatan. */
function setConfig({ pool, quotaPercent } = {}) {
    if (pool !== undefined && pool !== null) {
        const p = String(pool);
        if (!fsx.existsSync(p)) {
            try { fsx.mkdirSync(p, { recursive: true }); }
            catch { throw new Error(`Folder pool tak bisa dibuat: ${p}`); }
        }
        cfgStore.write({ pool: p });
    }
    if (quotaPercent !== undefined) {
        const q = Math.max(50, Math.min(99, Number(quotaPercent) || 90));
        const c = cfgStore.read();
        cfgStore.write({ alerts: { ...(c.alerts || {}), quotaPercent: q } });
    }
    return config();
}

/** Ambang kuota peringatan disk (persen), default 90. */
function quotaPercent() { return Number(config().alerts?.quotaPercent) || 90; }

/**
 * nasService — status penyimpanan & host untuk view NAS.
 *
 * Semua data NYATA dari mesin (dev laptop / PC rumah), tanpa angka
 * karangan. Tiap sumber best-effort: kalau tool tak ada (smartctl,
 * docker), bagian itu ditandai unavailable — bukan diisi data palsu.
 */

async function volumes() {
    if (process.platform === "win32") {
        try {
            const { stdout } = await pexec("powershell", [
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-Volume | Where-Object { $_.DriveLetter } | " +
                "Select-Object DriveLetter,FileSystemLabel,FileSystem,Size,SizeRemaining | ConvertTo-Json -Compress"
            ], OPTS);
            let arr = JSON.parse(stdout || "[]");
            if (!Array.isArray(arr)) arr = [arr];
            return arr.map(v => {
                const total = Number(v.Size) || 0;
                const free = Number(v.SizeRemaining) || 0;
                const used = Math.max(0, total - free);
                return {
                    mount: `${v.DriveLetter}:`, label: v.FileSystemLabel || null,
                    fs: v.FileSystem || null, total, free, used,
                    usedPercent: total ? Math.round(used / total * 100) : 0
                };
            });
        }
        catch { return []; }
    }
    // POSIX
    try {
        const { stdout } = await pexec("df", ["-kP"], OPTS);
        return stdout.trim().split("\n").slice(1).map(line => {
            const p = line.split(/\s+/);
            const total = Number(p[1]) * 1024, used = Number(p[2]) * 1024, free = Number(p[3]) * 1024;
            return { mount: p[5], label: p[0], fs: null, total, used, free, usedPercent: total ? Math.round(used / total * 100) : 0 };
        }).filter(v => v.total > 0);
    }
    catch { return []; }
}

// smartctl sering TIDAK ada di PATH (smartmontools memasang ke Program Files).
// Cari di lokasi umum dulu, baru andalkan PATH.
let _smartctl;
function resolveSmartctl() {
    if (_smartctl !== undefined) return _smartctl;
    const known = process.platform === "win32" ? [
        "C:\\Program Files\\smartmontools\\bin\\smartctl.exe",
        "C:\\Program Files (x86)\\smartmontools\\bin\\smartctl.exe",
        "C:\\ProgramData\\chocolatey\\bin\\smartctl.exe"
    ] : ["/usr/sbin/smartctl", "/usr/local/sbin/smartctl", "/opt/homebrew/sbin/smartctl"];
    for (const c of known) { try { if (fsx.existsSync(c)) { _smartctl = c; return c; } } catch { /* lanjut */ } }
    _smartctl = "smartctl";   // fallback: andalkan PATH
    return _smartctl;
}

async function smart() {
    const bin = resolveSmartctl();

    let scan;
    try {
        scan = await pexec(bin, ["--scan", "-j"], OPTS);
    }
    catch (e) {
        return {
            available: false, devices: [],
            reason: e.code === "ENOENT"
                ? "smartctl tak ditemukan. Install smartmontools atau pastikan smartctl.exe ada."
                : "smartctl gagal dijalankan — di Windows pembacaan SMART butuh hak Administrator. Jalankan Damar sebagai Administrator."
        };
    }

    let devices = [];
    try { devices = JSON.parse(scan.stdout).devices || []; } catch { /* output tak terduga */ }

    const out = [];
    for (const d of devices) {
        try {
            const r = await pexec(bin, ["-Hij", d.name], OPTS);
            const j = JSON.parse(r.stdout);
            out.push({
                device: d.name,
                model: j.model_name ?? null,
                health: j.smart_status?.passed === true ? "PASSED" : (j.smart_status ? "FAILED" : "?"),
                tempC: j.temperature?.current ?? null,
                capacity: j.user_capacity?.bytes ?? null
            });
        }
        catch { /* satu disk gagal — lewati */ }
    }

    // Disk terdeteksi tapi atribut tak terbaca = hampir selalu soal hak admin.
    if (devices.length && out.length === 0) {
        return { available: false, devices: [], reason: "Disk terdeteksi tapi SMART tak terbaca — jalankan Damar sebagai Administrator." };
    }
    return { available: true, devices: out, bin };
}

async function docker() {
    try {
        const { stdout } = await pexec("docker", ["ps", "--format", "{{json .}}"], OPTS);
        const containers = stdout.trim().split("\n").filter(Boolean).map(l => {
            const c = JSON.parse(l);
            return { name: c.Names, image: c.Image, status: c.Status, state: c.State ?? null };
        });
        return { available: true, containers };
    }
    catch {
        return { available: false, containers: [], reason: "docker tidak tersedia." };
    }
}

function network() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address, mac: a.mac });
        }
    }
    return out;
}

/** Status share SMB "DamarNAS" (akses file dari iPhone/perangkat lain). */
async function smb() {
    const name = "DamarNAS";
    if (process.platform !== "win32") return { supported: false, shared: false, name };
    try {
        const { stdout } = await pexec("powershell", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Get-SmbShare -Name '${name}' -ErrorAction SilentlyContinue | Select-Object Name,Path | ConvertTo-Json -Compress`
        ], OPTS);
        if (!stdout.trim()) return { supported: true, shared: false, name };
        const j = JSON.parse(stdout);
        return { supported: true, shared: true, name: j.Name, path: j.Path };
    }
    catch { return { supported: true, shared: false, name }; }
}

/** Storage Spaces: virtual disk (pool RAID) yang ada + disk yang bisa di-pool. */
async function storagePools() {
    if (process.platform !== "win32") return { supported: false, pools: [], candidates: [] };
    const pools = [], candidates = [];
    try {
        const { stdout } = await pexec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
            "Get-VirtualDisk -ErrorAction SilentlyContinue | Select-Object FriendlyName,ResiliencySettingName,@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}},HealthStatus | ConvertTo-Json -Compress"], OPTS);
        let a = stdout.trim() ? JSON.parse(stdout) : [];
        if (!Array.isArray(a)) a = [a];
        pools.push(...a.map(v => ({ name: v.FriendlyName, resiliency: v.ResiliencySettingName, sizeGB: v.SizeGB, health: v.HealthStatus })));
    }
    catch { /* Storage Spaces tak ada */ }
    try {
        const { stdout } = await pexec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
            "Get-PhysicalDisk -CanPool $true -ErrorAction SilentlyContinue | Select-Object FriendlyName,@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}},MediaType | ConvertTo-Json -Compress"], OPTS);
        let a = stdout.trim() ? JSON.parse(stdout) : [];
        if (!Array.isArray(a)) a = [a];
        candidates.push(...a.map(d => ({ name: d.FriendlyName, sizeGB: d.SizeGB, media: d.MediaType })));
    }
    catch { /* tak ada disk kandidat */ }
    return { supported: true, pools, candidates };
}

class NasService {
    async status() {
        const [vols, sm, dk, sh] = await Promise.all([volumes(), smart(), docker(), smb()]);
        const cfg = config();
        // Tandai volume mana yang jadi pool NAS.
        const poolMount = cfg.pool ? (vols.find(v => cfg.pool.toUpperCase().startsWith(v.mount.toUpperCase()))?.mount ?? null) : null;
        return {
            host: os.hostname(),
            platform: `${os.platform()} ${os.release()}`,
            pool: cfg.pool,
            poolMount,
            volumes: vols,
            smart: sm,
            docker: dk,
            smb: sh,
            network: network(),
            at: new Date().toISOString()
        };
    }

    config() { return config(); }
    setConfig(patch) { return setConfig(patch); }
    quotaPercent() { return quotaPercent(); }
    pools() { return storagePools(); }
}

module.exports = new NasService();
