#!/usr/bin/env node

/**
 * Bootstrapper pemasangan Damar dari sumber (git clone). Titik masuk
 * utamanya scripts/setup.ps1 (yang bisa jalan sebelum Node ada);
 * `npm run setup:cli` adalah jalan yang sama bagi yang sudah punya
 * Node. Bentuknya BUKAN penyalin berkas buta — empat fase:
 *
 *   1. AUDIT    — membaca PC lokal terhadap manifest kebutuhan nyata
 *                 repo: Windows >= 10.0.17763 (batas installer produk),
 *                 Node.js >= 20 (produk membundel 24.19.0), npm,
 *                 Python >= 3.10 untuk service Supertonic (produk
 *                 membundel 3.12.10), runtime Visual C++ untuk modul
 *                 native, dan ruang disk untuk dependensi + model
 *                 voice (±1,2 GB). Setiap item: OK / MISSING /
 *                 WRONG-VERSION.
 *   2. PROVISION— yang kurang diunduh dari sumber resmi dan dipasang
 *                 SECARA PORTABLE di folder Damar sendiri
 *                 (data/tools/node, data/voice/python), terverifikasi
 *                 SHA-256 yang dipin dari sums resmi. Tidak ada
 *                 perubahan sistem dan tidak butuh admin, kecuali
 *                 satu: folder shim ditambahkan ke PATH *user*
 *                 (HKCU, sama seperti tugas addpath installer produk)
 *                 bila belum terjangkau PATH — dicatat di laporan.
 *                 VC++ runtime hanya diaudit (remedinya manual:
 *                 redistributable resmi Microsoft butuh installer
 *                 sistem tersendiri).
 *   3. APLIKASI — npm install (bila perlu), npm link (mendaftarkan
 *                 perintah global `damar` dari bin package.json),
 *                 model voice (scripts/setup-voice.js; gagalnya TIDAK
 *                 menggagalkan install — ulangi dengan
 *                 `npm run setup:voice`), lalu shortcut desktop +
 *                 Start Menu "Damar".
 *   4. LAPORAN  — ringkasan preflight di terminal + berkas
 *                 data/setup-report.json: yang ditemukan, yang
 *                 dipasang, yang dilewati, yang gagal + remedinya.
 *                 Idempotent: di mesin yang lengkap, menjalankan
 *                 ulang tidak mengubah apa pun dan semua hijau.
 *
 * Lepas perintah lagi dengan: npm uninstall -g damar
 *
 * Isolasi npm: semua pemanggilan npm oleh setup diarahkan ke berkas
 * userconfig kosong yang dikelola setup (data/setup-npmrc). Terukur
 * alasannya: npm >= 12 menolak nilai allow-scripts yang datang dari
 * CLI/env pada install project-scoped (EALLOWSCRIPTS), dan nilai
 * allow-scripts dari ~/.npmrc pengguna terbawa env ke npm nested
 * yang dijalankan preinstall dependensi (rantai `node` ->
 * node-bin-setup memasang node-win-x64 lewat npm kedua) — install
 * bersih gagal di mesin yang ~/.npmrc-nya memasang allow-scripts,
 * sebelum allowScripts package.json sempat dibaca. Dengan isolasi
 * ini kebijakan skrip install Damar datang hanya dari allowScripts
 * package.json repo: deterministik di semua mesin, sejalan dengan
 * FOUNDATION PACKAGING POLICY di .npmrc. Konsekuensinya registry/
 * auth pribadi di ~/.npmrc TIDAK dipakai selama setup; bila
 * dependensi harus lewat registry pribadi, jalankan `npm install`
 * manual lebih dulu (setup melewati langkah itu bila node_modules
 * sudah ada).
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const TOOLS_DIR = path.join(DATA_DIR, "tools");
const PORTABLE_NODE_DIR = path.join(TOOLS_DIR, "node");
const PORTABLE_NODE_EXE = path.join(PORTABLE_NODE_DIR, "node.exe");
const PORTABLE_PY_DIR = path.join(DATA_DIR, "voice", "python");
const NPMRC_ISOLATED = path.join(DATA_DIR, "setup-npmrc");
const SKIP_VOICE = process.argv.includes("--skip-voice");

const NODE_PIN = {
    version: "24.19.0",
    url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip",
    sha256: "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
    zipName: "node-v24.19.0-win-x64.zip",
    folder: "node-v24.19.0-win-x64",
};
const PY_PIN = {
    version: "3.12.10",
    url: "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",
    sha256: "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
    zipName: "python-3.12.10-embed-amd64.zip",
};
const MIN_NODE_MAJOR = 20;
const DISK_OK_GB = 5, DISK_WARN_GB = 2.5;

// ---------- laporan ----------
const report = { startedAt: new Date().toISOString(), audit: [], actions: [], warnings: [], nodeUsed: null };
function audit(item, status, detail) {
    report.audit.push({ item, status, detail });
    console.log(`  [${status}] ${item}: ${detail}`);
}
function action(text) { report.actions.push(text); console.log(`  -> ${text}`); }
function warn(text) { report.warnings.push(text); console.error(`  PERINGATAN: ${text}`); }
function writeReport() {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "setup-report.json"), JSON.stringify(report, null, 2));
}

// ---------- util ----------
function out(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd), ...opts });
    return { status: r.status, text: ((r.stdout || "") + (r.stderr || "")).trim() };
}
function parseVer(text) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || "");
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], raw: m[0] } : null;
}
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        fs.createReadStream(file).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
    });
}
function downloadTo(url, dest) {
    return new Promise((resolve, reject) => {
        const attempt = (u, redirects) => {
            https.get(u, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirects <= 0) return reject(new Error("terlalu banyak pengalihan"));
                    return attempt(new URL(res.headers.location, u).href, redirects - 1);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                const f = fs.createWriteStream(dest);
                res.pipe(f);
                f.on("finish", () => f.close(resolve));
                f.on("error", reject);
            }).on("error", reject);
        };
        attempt(url, 5);
    });
}
function expandZip(zip, destDir) {
    if (process.platform !== "win32") throw new Error("ekstraksi otomatis hanya di Windows");
    fs.mkdirSync(destDir, { recursive: true });
    const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command",
        "Expand-Archive -LiteralPath $env:DAMAR_ZIP -DestinationPath $env:DAMAR_OUT -Force"],
        { stdio: "inherit", env: { ...process.env, DAMAR_ZIP: zip, DAMAR_OUT: destDir } });
    if (r.status !== 0) throw new Error(`Expand-Archive gagal untuk ${zip}`);
}

// ---------- fase 1: audit ----------
function findNode() {
    const found = { system: null, portable: null, chosen: null };
    const sys = out("node", ["--version"]);
    if (sys.status === 0) found.system = parseVer(sys.text);
    if (fs.existsSync(PORTABLE_NODE_EXE)) {
        const p = out(PORTABLE_NODE_EXE, ["--version"]);
        if (p.status === 0) found.portable = parseVer(p.text);
    }
    if (found.system && found.system.major >= MIN_NODE_MAJOR) found.chosen = { kind: "system", exe: "node", npm: "npm", version: found.system };
    else if (found.portable && found.portable.major >= MIN_NODE_MAJOR) found.chosen = { kind: "portable", exe: PORTABLE_NODE_EXE, npm: path.join(PORTABLE_NODE_DIR, "npm.cmd"), version: found.portable };
    return found;
}

function auditAll() {
    console.log("setup: fase 1 — audit PC lokal");
    const rel = os.release().split(".");
    const build = +(rel[2] || 0);
    audit("Windows", process.platform === "win32" && build >= 17763 ? "OK" : "WRONG-VERSION",
        `${os.type()} ${os.release()} (build ${build}; butuh >= 17763)`);

    const nodes = findNode();
    if (nodes.system) audit("Node.js (sistem)", nodes.system.major >= MIN_NODE_MAJOR ? "OK" : "WRONG-VERSION", `v${nodes.system.raw} di PATH (butuh >= ${MIN_NODE_MAJOR})`);
    if (nodes.portable) audit("Node.js (portable Damar)", "OK", `v${nodes.portable.raw} di data/tools/node`);
    if (!nodes.system && !nodes.portable) audit("Node.js", "MISSING", "tidak ada di PATH maupun data/tools/node");

    let pyVer = null, pyWhere = null;
    for (const cand of [["py", ["-3", "--version"]], ["python", ["--version"]], ["python3", ["--version"]]]) {
        const r = out(cand[0], cand[1]);
        if (r.status === 0 && parseVer(r.text)) { pyVer = parseVer(r.text); pyWhere = cand[0]; break; }
    }
    const portablePy = path.join(PORTABLE_PY_DIR, "python.exe");
    if (!pyVer && fs.existsSync(portablePy)) { const r = out(portablePy, ["--version"]); if (r.status === 0) { pyVer = parseVer(r.text); pyWhere = "portable Damar"; } }
    if (pyVer) audit("Python (service Supertonic)", pyVer.major === 3 && pyVer.minor >= 10 ? "OK" : "WRONG-VERSION", `${pyVer.raw} via ${pyWhere} (butuh >= 3.10)`);
    else audit("Python (service Supertonic)", "MISSING", "tidak ditemukan (butuh >= 3.10)");

    const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const vc = fs.existsSync(path.join(sys32, "vcruntime140.dll")) && fs.existsSync(path.join(sys32, "vcruntime140_1.dll"));
    audit("Visual C++ runtime (modul native)", vc ? "OK" : "MISSING",
        vc ? "vcruntime140.dll + vcruntime140_1.dll ada" : "vcruntime140 tidak lengkap — remedy manual: pasang 'Microsoft Visual C++ Redistributable (x64)' resmi; tanpa ini modul native bisa gagal dimuat");

    let freeGB = null;
    try { const s = fs.statfsSync(ROOT); freeGB = (s.bavail * s.bsize) / 1073741824; } catch { /* Node sangat lama */ }
    if (freeGB === null) audit("Ruang disk", "UNKNOWN", "tidak terukur dari proses ini");
    else audit("Ruang disk", freeGB >= DISK_OK_GB ? "OK" : freeGB >= DISK_WARN_GB ? "WRONG-VERSION" : "MISSING",
        `${freeGB.toFixed(1)} GB bebas di drive repo (model voice ±1,2 GB + dependensi)`);

    const git = out("git", ["--version"]);
    audit("Git", git.status === 0 ? "OK" : "MISSING", git.status === 0 ? git.text : "tidak ada di PATH (hanya perlu untuk clone)");
    return { nodes, pyVer, freeGB };
}

// ---------- fase 2: provision ----------
async function provisionNode() {
    console.log("setup: fase 2 — memasang Node.js portable resmi (hash dipin dari SHASUMS256 nodejs.org)");
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    const zip = path.join(TOOLS_DIR, NODE_PIN.zipName);
    await downloadTo(NODE_PIN.url, zip);
    if ((await sha256File(zip)) !== NODE_PIN.sha256) { fs.rmSync(zip); throw new Error("SHA-256 Node.js tidak cocok — unduhan dibuang"); }
    const tmp = path.join(TOOLS_DIR, "_extract");
    fs.rmSync(tmp, { recursive: true, force: true });
    expandZip(zip, tmp);
    fs.rmSync(PORTABLE_NODE_DIR, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, NODE_PIN.folder), PORTABLE_NODE_DIR);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip);
    action(`Node.js portable v${NODE_PIN.version} terpasang di data/tools/node`);
}

async function provisionPython() {
    console.log("setup: fase 2 — memasang Python portable resmi (embeddable, python.org)");
    const zip = path.join(DATA_DIR, "voice", PY_PIN.zipName);
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    await downloadTo(PY_PIN.url, zip);
    if ((await sha256File(zip)) !== PY_PIN.sha256) { fs.rmSync(zip); throw new Error("SHA-256 Python tidak cocok — unduhan dibuang"); }
    expandZip(zip, PORTABLE_PY_DIR);
    // Embeddable: aktifkan site-packages agar pip bisa dipasang oleh setup-voice.
    const pth = fs.readdirSync(PORTABLE_PY_DIR).find(f => /^python3\d+\._pth$/.test(f));
    if (pth) {
        const p = path.join(PORTABLE_PY_DIR, pth);
        const body = fs.readFileSync(p, "utf8");
        if (!/^import site$/m.test(body)) fs.writeFileSync(p, body.trimEnd() + "\nimport site\n");
    }
    fs.rmSync(zip);
    action(`Python portable ${PY_PIN.version} terpasang di data/voice/python`);
}

// ---------- PATH user (satu-satunya perubahan di luar folder Damar) ----------
function ensureOnUserPath(dir) {
    if (process.platform !== "win32") return;
    const ps = [
        "$dir = $env:DAMAR_PATH_DIR",
        "$cur = [Environment]::GetEnvironmentVariable('Path', 'User')",
        "$all = ([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $cur) -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') }",
        "if ($all -contains $dir.TrimEnd('\\')) { 'present' } else {",
        "  $new = if ($cur) { $cur.TrimEnd(';') + ';' + $dir } else { $dir }",
        "  [Environment]::SetEnvironmentVariable('Path', $new, 'User'); 'added' }",
    ].join("; ");
    const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", ps],
        { encoding: "utf8", env: { ...process.env, DAMAR_PATH_DIR: dir } });
    if (r.status === 0 && /added/.test(r.stdout || "")) action(`PATH user: menambahkan ${dir} (buka terminal baru agar berlaku)`);
    else if (r.status === 0) console.log(`  PATH user: ${dir} sudah terjangkau`);
    else warn(`gagal memeriksa PATH user untuk ${dir}: ${(r.stderr || "").trim()}`);
}

// ---------- shortcut ----------
function writeBrandIcon(destPng, destIco) {
    const png = fs.readFileSync(destPng);
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    const head = Buffer.alloc(6 + 16);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(1, 4);
    head[6] = w >= 256 ? 0 : w;
    head[7] = h >= 256 ? 0 : h;
    head.writeUInt16LE(1, 10);
    head.writeUInt16LE(32, 12);
    head.writeUInt32LE(png.length, 14);
    head.writeUInt32LE(head.length, 18);
    fs.mkdirSync(path.dirname(destIco), { recursive: true });
    fs.writeFileSync(destIco, Buffer.concat([head, png]));
}
function createShortcuts(iconPath) {
    const ps = [
        "$ErrorActionPreference = 'Stop'",
        "$ws = New-Object -ComObject WScript.Shell",
        "$cmd = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
        "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {",
        "  $lnk = $ws.CreateShortcut((Join-Path $dir 'Damar.lnk'))",
        "  $lnk.TargetPath = $cmd",
        "  $lnk.Arguments = '/k damar'",
        "  $lnk.WorkingDirectory = $env:USERPROFILE",
        "  $lnk.IconLocation = $env:DAMAR_SHORTCUT_ICON + ',0'",
        "  $lnk.Description = 'DAMAR'",
        "  $lnk.Save()",
        "  Write-Output (Join-Path $dir 'Damar.lnk')",
        "}",
    ].join("; ");
    const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", ps],
        { encoding: "utf8", env: { ...process.env, DAMAR_SHORTCUT_ICON: iconPath } });
    if (r.status !== 0) throw new Error((r.stderr || "powershell gagal").trim());
    return r.stdout.trim().split(/\r?\n/).filter(Boolean);
}

// ---------- fase 3 + 4 ----------
async function main() {
    const { nodes, pyVer, freeGB } = auditAll();
    let node = nodes.chosen;

    if (!node) {
        await provisionNode();
        const p = out(PORTABLE_NODE_EXE, ["--version"]);
        node = { kind: "portable", exe: PORTABLE_NODE_EXE, npm: path.join(PORTABLE_NODE_DIR, "npm.cmd"), version: parseVer(p.text) };
        if (!node.version) throw new Error("Node.js portable tidak menjawab setelah dipasang");
    }
    if (!pyVer) {
        try { await provisionPython(); }
        catch (e) { warn(`Python portable gagal dipasang (${e.message}). Service Supertonic belum siap; STT + Piper tidak terpengaruh. Pasang Python 3.12 manual lalu ulangi: npm run setup:voice`); }
    }
    report.nodeUsed = { kind: node.kind, version: node.version?.raw, exe: node.exe };
    console.log(`setup: memakai Node.js ${node.kind} v${node.version?.raw}`);

    // Isolasi userconfig npm (lihat catatan isolasi di kepala berkas).
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(NPMRC_ISOLATED)) fs.writeFileSync(NPMRC_ISOLATED, "# Dikelola setup Damar: userconfig npm kosong untuk isolasi selama install (lihat scripts/setup-cli.js).\n");
    const npmEnv = { ...process.env, NPM_CONFIG_USERCONFIG: NPMRC_ISOLATED };
    if (node.kind === "portable") npmEnv.PATH = PORTABLE_NODE_DIR + ";" + (process.env.PATH || "");
    console.log("setup: npm diisolasi ke userconfig setup (data/setup-npmrc) — kebijakan skrip hanya dari package.json repo");
    const runNpm = args => {
        const r = spawnSync(node.npm, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", env: npmEnv });
        if (r.error) { const e = new Error(`gagal menjalankan npm: ${r.error.message}`); e.exitCode = 1; throw e; }
        if (r.status !== 0) { const e = new Error(`npm ${args.join(" ")} gagal (exit ${r.status ?? "?"})`); e.exitCode = r.status ?? 1; throw e; }
    };

    console.log("setup: fase 3 — dependensi aplikasi + perintah `damar`");
    if (!fs.existsSync(path.join(ROOT, "node_modules"))) { runNpm(["install"]); action("dependensi aplikasi terpasang (npm install)"); }
    else console.log("  dependensi sudah ada (node_modules) — dilewati");
    runNpm(["link"]);
    action("perintah global `damar` terdaftar (npm link)");

    const prefix = out(node.npm, ["prefix", "-g"], { env: npmEnv }).text.split(/\r?\n/)[0];
    if (prefix && fs.existsSync(prefix)) ensureOnUserPath(prefix);

    if (!SKIP_VOICE) {
        if (freeGB !== null && freeGB < DISK_WARN_GB) {
            warn(`ruang disk ${freeGB.toFixed(1)} GB terlalu sempit untuk model voice — unduhan model dilewati. Bebaskan ruang lalu jalankan: npm run setup:voice`);
        } else {
            console.log("setup: fase 3 — model voice lokal (npm run setup:voice)");
            const v = spawnSync(node.exe, [path.join(__dirname, "setup-voice.js")], { cwd: ROOT, stdio: "inherit" });
            if (v.status !== 0) warn("unduhan model voice belum lengkap — install Damar tetap selesai. Ulangi kapan pun: npm run setup:voice");
            else action("model voice lokal terpasang dan terverifikasi hash");
        }
    } else console.log("  model voice dilewati (--skip-voice); ulangi dengan: npm run setup:voice");

    if (process.platform === "win32") {
        try {
            const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
            const iconPath = path.join(localAppData, "DAMAR", "damar.ico");
            writeBrandIcon(path.join(ROOT, "apps", "desktop", "src", "control", "damaricon-clean.png"), iconPath);
            for (const lnk of createShortcuts(iconPath)) action(`shortcut dibuat: ${lnk}`);
        } catch (e) {
            warn(`shortcut tidak dibuat (${e.message}). Perintah \`damar\` tetap terdaftar.`);
        }
    }

    writeReport();
    console.log("setup: fase 4 — laporan preflight");
    for (const e of report.audit) console.log(`  [${e.status}] ${e.item}: ${e.detail}`);
    for (const a of report.actions) console.log(`  dipasang/diubah: ${a}`);
    for (const w of report.warnings) console.log(`  PERINGATAN: ${w}`);
    console.log(`setup: laporan tertulis di ${path.join(DATA_DIR, "setup-report.json")}`);
    console.log("setup: selesai. Buka terminal baru lalu jalankan `damar` dari folder mana pun.");
    console.log("setup: lepas perintah dengan `npm uninstall -g damar`.");
}

main().catch(e => {
    // Laporan preflight tetap ditulis walau setup berhenti di tengah:
    // kegagalan tanpa laporan membuat diagnosis mesin pengguna buta.
    report.error = e.message;
    try { writeReport(); console.log(`setup: laporan (berakhir gagal) tertulis di ${path.join(DATA_DIR, "setup-report.json")}`); }
    catch { /* laporan tidak tertulis — kegagalan utama tetap dilaporkan di bawah */ }
    console.error(`setup: GAGAL: ${e.message}`);
    process.exit(typeof e.exitCode === "number" ? e.exitCode : 1);
});
