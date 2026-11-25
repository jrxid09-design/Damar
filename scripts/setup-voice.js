#!/usr/bin/env node

/**
 * Unduh model + mesin voice lokal Damar dari sumber resmi, dengan
 * verifikasi SHA-256 untuk setiap berkas. Dipakai oleh alur install
 * (scripts/setup-cli.js) dan berdiri sendiri:
 *
 *   node scripts/setup-voice.js           unduh/lengkapi yang kurang
 *   node scripts/setup-voice.js --check   verifikasi saja, tanpa unduh
 *   npm run setup:voice                   alias perintah di atas
 *
 * Semua berkas mendarat di data/voice/ (gitignored, per-instalasi) —
 * layout yang sama dengan yang diharapkan runtime voice
 * (src/voice/local): bin/, models/, voices/, supertonic3/, pyenv/.
 * Model TIDAK pernah dibundel ke repo atau installer; unduhan gagal
 * tidak menggagalkan install Damar (pemanggil memperlakukan kegagalan
 * skrip ini sebagai peringatan) dan dapat diulang kapan pun — berkas
 * yang sudah lolos hash dilewati, unduhan yang terputus dilanjutkan
 * dari berkas .part, dan berkas yang gagal hash dihapus (tidak pernah
 * dibiarkan tampak valid).
 *
 * Manifest di bawah dipin dari sumber resmi (HuggingFace
 * ggerganov/whisper.cpp, rhasspy/piper-voices, Supertone/supertonic-3,
 * GitHub ggml-org/whisper.cpp + rhasspy/piper) dan diverifikasi
 * terhadap SHA-256 LFS/etag resmi — lihat VOICE-ID.md. Set model =
 * yang dipakai runtime: ggml tiny (parsial streaming) + base (wake
 * word/final cepat) + small (final otoritatif); medium/turbo adalah
 * model evaluasi yang terukur kalah (§6 VOICE-ID.md) dan tidak diunduh.
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BASE = path.join(ROOT, "data", "voice");
const HF_WHISPER = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HF_PIPER = "https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium";
const HF_SUPERTONIC = "https://huggingface.co/Supertone/supertonic-3/resolve/main";

// { url, dest (relatif ke data/voice), size (byte), sha256 }
const FILES = [
    { url: `${HF_WHISPER}/ggml-tiny.bin`, dest: "models/ggml-tiny.bin", size: 77691713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" },
    { url: `${HF_WHISPER}/ggml-base.bin`, dest: "models/ggml-base.bin", size: 147951465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
    { url: `${HF_WHISPER}/ggml-small.bin`, dest: "models/ggml-small.bin", size: 487601967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
    { url: `${HF_PIPER}/id_ID-news_tts-medium.onnx`, dest: "voices/id_ID-news_tts-medium.onnx", size: 62950044, sha256: "ed8f02aa593f7af6b19acbdb8142e0da0dd72f46194eb33d38e0eb10a52597e8" },
    { url: `${HF_PIPER}/id_ID-news_tts-medium.onnx.json`, dest: "voices/id_ID-news_tts-medium.onnx.json", size: 5050, sha256: "1ef677072668a5e172e0759b1d3871f129009d1167f093325a17607f7add5ad7" },
    { url: `${HF_SUPERTONIC}/onnx/duration_predictor.onnx`, dest: "supertonic3/onnx/duration_predictor.onnx", size: 3700147, sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db" },
    { url: `${HF_SUPERTONIC}/onnx/text_encoder.onnx`, dest: "supertonic3/onnx/text_encoder.onnx", size: 36416150, sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
    { url: `${HF_SUPERTONIC}/onnx/vector_estimator.onnx`, dest: "supertonic3/onnx/vector_estimator.onnx", size: 256534781, sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c" },
    { url: `${HF_SUPERTONIC}/onnx/vocoder.onnx`, dest: "supertonic3/onnx/vocoder.onnx", size: 101424195, sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba" },
    { url: `${HF_SUPERTONIC}/onnx/tts.json`, dest: "supertonic3/onnx/tts.json", size: 8253, sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09" },
    { url: `${HF_SUPERTONIC}/onnx/unicode_indexer.json`, dest: "supertonic3/onnx/unicode_indexer.json", size: 277676, sha256: "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f" },
    { url: `${HF_SUPERTONIC}/config.json`, dest: "supertonic3/config.json", size: 174, sha256: "4099082b107a9d4029849ac76b89eca65e03732660969c2babe5bf308c7357f2" },
    ...["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"].map(v => ({
        url: `${HF_SUPERTONIC}/voice_styles/${v}.json`,
        dest: `supertonic3/voice_styles/${v}.json`,
        size: { M1: 291748, M2: 292055, M3: 290198, M4: 291522, M5: 291469, F1: 292046, F2: 292423, F3: 290794, F4: 291808, F5: 291479 }[v],
        sha256: { M1: "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b", M2: "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50", M3: "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b", M4: "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303", M5: "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2", F1: "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2", F2: "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6", F3: "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab", F4: "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b", F5: "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d" }[v],
    })),
];

// Arsip mesin (diunduh ke dl/, diekstrak ke bin/ bila penanda belum ada).
const ARCHIVES = [
    { url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip", dest: "dl/whisper-bin-x64.zip", size: 3675974, sha256: "0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9", extractTo: "bin/whisper", marker: "bin/whisper/Release/whisper-cli.exe" },
    { url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip", dest: "dl/piper_windows_amd64.zip", size: 22477236, sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea", extractTo: "bin/piper", marker: "bin/piper/piper.exe" },
];

const mb = n => (n / 1048576).toFixed(1) + " MB";

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        fs.createReadStream(file).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
    });
}

/** Unduh dengan pengalihan + lanjutan .part; selesai hanya bila utuh. */
function download(asset, destAbs) {
    return new Promise((resolve, reject) => {
        const part = destAbs + ".part";
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (have > asset.size) { fs.rmSync(part); have = 0; }
        const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
        const attempt = (url, redirects) => {
            https.get(url, { headers }, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirects <= 0) return reject(new Error("terlalu banyak pengalihan"));
                    return attempt(new URL(res.headers.location, url).href, redirects - 1);
                }
                let flags = "w";
                if (res.statusCode === 206 && have > 0) flags = "a";
                else if (res.statusCode === 200) have = 0;
                else { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                const out = fs.createWriteStream(part, { flags });
                let got = have, lastPct = -1;
                res.on("data", chunk => {
                    got += chunk.length;
                    const pct = Math.floor((got / asset.size) * 100);
                    if (pct >= lastPct + 10) { lastPct = pct; console.log(`  ${path.basename(asset.dest)}: ${pct}% (${mb(got)} / ${mb(asset.size)})`); }
                });
                res.pipe(out);
                out.on("finish", () => out.close(() => resolve(got)));
                out.on("error", reject);
                res.on("error", reject);
            }).on("error", reject);
        };
        attempt(asset.url, 5);
    });
}

/** Unduh polos tanpa manifest (khusus bootstrap pip resmi). */
function downloadRaw(url, dest) {
    return new Promise((resolve, reject) => {
        const attempt = (u, redirects) => {
            https.get(u, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirects <= 0) return reject(new Error("terlalu banyak pengalihan"));
                    return attempt(new URL(res.headers.location, u).href, redirects - 1);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                const out = fs.createWriteStream(dest);
                res.pipe(out);
                out.on("finish", () => out.close(resolve));
                out.on("error", reject);
            }).on("error", reject);
        };
        attempt(url, 5);
    });
}

async function ensureAsset(asset) {
    const destAbs = path.join(BASE, asset.dest);
    if (fs.existsSync(destAbs)) {
        if ((await sha256File(destAbs)) === asset.sha256) { console.log(`lewati (hash cocok) ${asset.dest}`); return true; }
        console.log(`hash tidak cocok, unduh ulang: ${asset.dest}`);
        fs.rmSync(destAbs);
    }
    console.log(`unduh ${asset.dest} (${mb(asset.size)})`);
    try {
        const got = await download(asset, destAbs);
        if (got !== asset.size) throw new Error(`ukuran tidak utuh: ${got} dari ${asset.size} byte`);
        const hash = await sha256File(destAbs + ".part");
        if (hash !== asset.sha256) {
            fs.rmSync(destAbs + ".part", { force: true });
            throw new Error("SHA-256 tidak cocok dengan manifest — berkas dihapus");
        }
        fs.renameSync(destAbs + ".part", destAbs);
        console.log(`ok ${asset.dest}`);
        return true;
    } catch (e) {
        console.error(`GAGAL ${asset.dest}: ${e.message}`);
        return false;
    }
}

/** Beberapa arsip membungkus isinya dalam satu folder atas (mis. piper_windows_amd64.zip
 * berisi folder piper/ sehingga hasil ekstraknya bin/piper/piper/piper.exe, bukan penanda
 * bin/piper/piper.exe). Ratakan satu tingkat agar penanda berada tepat di extractTo. */
function flattenTopFolder(archive, out) {
    const rel = archive.marker.slice(archive.extractTo.length + 1).split(/[\\/]/);
    if (rel.length !== 1 || !fs.existsSync(out)) return false;
    for (const ent of fs.readdirSync(out, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const inner = path.join(out, ent.name);
        if (!fs.existsSync(path.join(inner, rel[0]))) continue;
        for (const child of fs.readdirSync(inner)) fs.renameSync(path.join(inner, child), path.join(out, child));
        fs.rmdirSync(inner);
        return true;
    }
    return false;
}

function extractArchive(archive) {
    const marker = path.join(BASE, archive.marker);
    if (fs.existsSync(marker)) { console.log(`lewati (sudah diekstrak) ${archive.extractTo}`); return true; }
    if (process.platform !== "win32") { console.error(`ekstraksi otomatis hanya di Windows: ${archive.dest}`); return false; }
    const zip = path.join(BASE, archive.dest), out = path.join(BASE, archive.extractTo);
    fs.mkdirSync(out, { recursive: true });
    if (flattenTopFolder(archive, out) && fs.existsSync(marker)) { console.log(`ok ekstrak (diratakan) ${archive.extractTo}`); return true; }
    const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command",
        `Expand-Archive -LiteralPath $env:DAMAR_ZIP -DestinationPath $env:DAMAR_OUT -Force`],
        { stdio: "inherit", env: { ...process.env, DAMAR_ZIP: zip, DAMAR_OUT: out } });
    let ok = r.status === 0 && fs.existsSync(marker);
    if (!ok && flattenTopFolder(archive, out)) ok = fs.existsSync(marker);
    console.log(ok ? `ok ekstrak ${archive.extractTo}` : `GAGAL ekstrak ${archive.extractTo}`);
    return ok;
}

/** Venv Python + paket supertonic (langkah terbaik-terakhir; gagal = peringatan). */
async function pythonEnvStep() {
    const pyenvPy = path.join(BASE, "pyenv", "Scripts", "python.exe");
    const portablePy = path.join(BASE, "python", "python.exe");
    const run = (exe, args) => spawnSync(exe, args, { stdio: "inherit" }).status === 0;
    let py = null;
    for (const cand of ["python", "py"]) {
        const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
        if (r.status === 0 && /3\.(1[0-9]|[2-9][0-9])/.test(r.stdout + r.stderr)) { py = cand; break; }
    }
    try {
        if (py && !fs.existsSync(pyenvPy)) {
            console.log("setup-voice: membuat venv Python (pyenv)...");
            if (!run(py, ["-m", "venv", "--system-site-packages", path.join(BASE, "pyenv")])) throw new Error("venv gagal");
        }
        if (fs.existsSync(pyenvPy)) {
            console.log("setup-voice: memasang paket supertonic ke pyenv...");
            if (!run(pyenvPy, ["-m", "pip", "install", "--disable-pip-version-check", "supertonic"]))
                console.error("setup-voice: PERINGATAN: pip install supertonic gagal; TTS Supertonic belum siap (Piper tetap jalan). Ulangi: npm run setup:voice");
            return;
        }
        if (fs.existsSync(portablePy)) {
            console.log("setup-voice: Python portable ditemukan; memasang supertonic di sana...");
            let pipOk = spawnSync(portablePy, ["-m", "pip", "--version"], { encoding: "utf8" }).status === 0;
            if (!pipOk) {
                // Embeddable tidak membawa pip: bootstrap resmi dari pypa.
                const gp = path.join(BASE, "dl", "get-pip.py");
                fs.mkdirSync(path.dirname(gp), { recursive: true });
                try {
                    await downloadRaw("https://bootstrap.pypa.io/get-pip.py", gp);
                    pipOk = run(portablePy, [gp, "--disable-pip-version-check"]);
                } catch (e) { console.error(`setup-voice: PERINGATAN: bootstrap pip gagal (${e.message})`); }
            }
            if (!pipOk || !run(portablePy, ["-m", "pip", "install", "--disable-pip-version-check", "supertonic"]))
                console.error("setup-voice: PERINGATAN: pip pada Python portable gagal; TTS Supertonic belum siap. Ulangi: npm run setup:voice");
            return;
        }
        console.error("setup-voice: PERINGATAN: Python >= 3.10 tidak ditemukan; service Supertonic belum bisa jalan (STT + Piper tetap siap). Pasang Python 3.12 lalu ulangi: npm run setup:voice");
    } catch (e) {
        console.error(`setup-voice: PERINGATAN: langkah Python dilewati (${e.message}). Ulangi: npm run setup:voice`);
    }
}

async function main() {
    const checkOnly = process.argv.includes("--check");
    const all = [...FILES, ...ARCHIVES];
    const total = all.reduce((s, a) => s + a.size, 0);
    console.log(`setup-voice: ${all.length} berkas, total ${mb(total)} -> ${BASE}`);
    let failed = 0;
    if (checkOnly) {
        for (const a of all) {
            const p = path.join(BASE, a.dest);
            const ok = fs.existsSync(p) && (await sha256File(p)) === a.sha256;
            console.log(`${ok ? "OK     " : "KURANG "} ${a.dest}`);
            if (!ok) failed++;
        }
        for (const a of ARCHIVES) console.log(`${fs.existsSync(path.join(BASE, a.marker)) ? "OK     " : "KURANG "} ekstrak: ${a.extractTo}`);
        console.log(failed ? `setup-voice: ${failed} berkas belum valid.` : "setup-voice: semua berkas valid.");
        process.exit(failed ? 1 : 0);
    }
    for (const a of all) if (!(await ensureAsset(a))) failed++;
    for (const a of ARCHIVES) if (fs.existsSync(path.join(BASE, a.dest)) && !extractArchive(a)) failed++;
    await pythonEnvStep();
    if (failed) {
        console.error(`setup-voice: ${failed} langkah gagal. Unduhan yang terputus dilanjutkan otomatis saat diulang: npm run setup:voice`);
        process.exit(1);
    }
    console.log("setup-voice: selesai — semua model voice lokal siap.");
}

main().catch(e => { console.error(`setup-voice: ${e.message}`); process.exit(1); });
