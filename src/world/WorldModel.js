const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Model dunia tempat Aether tinggal (Milestone 0.7).
 *
 * Aether sudah bisa MENANYAKAN lingkungannya satu per satu — ada tool
 * untuk disk, untuk Docker, untuk perangkat rumah. Yang belum ada
 * adalah gambaran utuh: apa saja yang ada, sedang bagaimana
 * keadaannya, dan **kapan terakhir itu benar-benar diperiksa**.
 *
 * Perbedaan terakhir itu yang membuatnya model, bukan sekadar
 * kumpulan pembacaan. Fakta tentang dunia menjadi basi: disk terisi,
 * layanan mati, IP berubah. Menyajikannya tanpa waktu pemeriksaan
 * membuat Aether berbicara tentang keadaan tahun lalu dengan nada
 * yang sama percayanya dengan keadaan semenit lalu.
 *
 * Karena itu setiap fakta membawa `checkedAt` dan `source`, dan
 * kegagalan memeriksa dilaporkan sebagai `unknown` — bukan
 * dihilangkan diam-diam sehingga tampak seolah tak ada masalah.
 */

const TTL_MS = 60_000;

let cache = null;
let cacheAt = 0;

/** Satu fakta beserta asal dan waktu pemeriksaannya. */
function fakta(nilai, source, catatan = null) {
    return {
        value: nilai,
        source,
        checkedAt: new Date().toISOString(),
        ...(catatan ? { note: catatan } : {})
    };
}

/** Fakta yang gagal diperiksa — dilaporkan, bukan disembunyikan. */
function tidakDiketahui(source, alasan) {
    return {
        value: null,
        source,
        checkedAt: new Date().toISOString(),
        unknown: true,
        note: alasan
    };
}

/** Nama sistem yang dapat dibaca manusia, bukan kode platform Node. */
function namaSistem() {
    return {
        win32: "Windows",
        darwin: "macOS",
        linux: "Linux"
    }[os.platform()] ?? os.platform();
}

async function mesin() {

    const bebas = os.freemem();
    const total = os.totalmem();

    return {
        host: fakta(os.hostname(), "os.hostname"),

        // `os.platform()` mengembalikan "win32" pada Windows 64-bit
        // juga — itu nama platform Node, bukan arsitektur. Dibiarkan
        // mentah, model membacanya sebagai "32-bit" dan menyampaikan
        // salah itu dengan yakin.
        platform: fakta(
            `${namaSistem()} ${os.release()} (${os.arch()})`,
            "os.platform/os.arch"
        ),
        cpu: fakta(`${os.cpus()?.length ?? 0} inti — ${os.cpus()?.[0]?.model ?? "?"}`, "os.cpus"),
        memori: fakta(
            `${(bebas / 1e9).toFixed(1)} GB bebas dari ${(total / 1e9).toFixed(1)} GB`,
            "os.freemem"
        ),
        uptime: fakta(`${Math.round(os.uptime() / 3600)} jam`, "os.uptime")
    };

}

async function penyimpanan() {

    const out = {};

    // Hanya disk yang benar-benar dipakai Aether, bukan seluruh sistem.
    for (const huruf of ["C", "D", "E"]) {

        const akar = `${huruf}:\\`;

        try {
            fs.accessSync(akar);
            const st = fs.statfsSync(akar);
            const bebas = (st.bavail * st.bsize) / 1e9;
            const total = (st.blocks * st.bsize) / 1e9;
            out[huruf] = fakta(`${bebas.toFixed(0)} GB bebas dari ${total.toFixed(0)} GB`, "statfs");
        }
        catch {
            // Disk tidak ada memang wajar; dicatat sebagai tak
            // terpasang, bukan sebagai kegagalan.
            out[huruf] = tidakDiketahui("statfs", "tidak terpasang");
        }

    }

    return out;

}

/** Layanan yang dijawab lewat HTTP — hidup atau tidak, apa adanya. */
async function layanan() {

    const target = {
        aether: "http://localhost:3000/health",
        immich: "http://localhost:2283/api/server/ping"
    };

    const out = {};

    await Promise.all(Object.entries(target).map(async ([nama, url]) => {

        const mulai = Date.now();

        try {

            const res = await fetch(url, {
                signal: AbortSignal.timeout(3000)
            });

            out[nama] = fakta(
                res.ok ? "hidup" : `menjawab HTTP ${res.status}`,
                url,
                `${Date.now() - mulai} ms`
            );

        }
        catch (error) {
            out[nama] = fakta("tidak menjawab", url, error.name === "TimeoutError" ? "lewat 3 dtk" : error.message);
        }

    }));

    return out;

}

async function kecerdasan() {

    // Otak lokal kini in-process (node-llama-cpp) — statusnya dibaca
    // dari runtime AI, bukan dari server luar.
    try {
        const runtime = require("../services/aiRuntimeService");
        const engine = runtime.engine;
        const loaded = Boolean(engine?.runtime?.currentProviderId);
        return {
            termuat: fakta(
                loaded ? `provider aktif: ${engine.runtime.currentProviderId}` : "belum ada provider lokal aktif",
                "aiRuntimeService"
            )
        };
    }
    catch (error) {
        return { termuat: tidakDiketahui("aiRuntimeService", error.message) };
    }

}

function batas() {

    try {

        const killSwitch = require("../core/safety/killSwitch");

        return {
            berhenti: fakta(killSwitch.isEngaged() ? "DIHENTIKAN" : "berjalan", "killSwitch"),
            gerbangRisiko: fakta("tidak ada — semua eksekusi diizinkan", "riskPolicy")
        };

    }
    catch (error) {
        return { berhenti: tidakDiketahui("killSwitch", error.message) };
    }

}

/**
 * Potret dunia saat ini.
 *
 * Di-cache singkat karena pemeriksaan menyentuh disk dan jaringan;
 * tanpa itu satu percakapan yang menanyakannya berkali-kali akan
 * membebani mesin yang sedang dipakai menjawab.
 */
async function snapshot({ fresh = false } = {}) {

    if (!fresh && cache && Date.now() - cacheAt < TTL_MS) {
        return { ...cache, cached: true };
    }

    const [m, p, l, k] = await Promise.all([
        mesin(), penyimpanan(), layanan(), kecerdasan()
    ]);

    cache = {
        at: new Date().toISOString(),
        mesin: m,
        penyimpanan: p,
        layanan: l,
        kecerdasan: k,
        batas: batas(),
        cached: false
    };

    cacheAt = Date.now();

    return cache;

}

/** Ringkasan sebaris-sebaris untuk dibaca model — hemat token. */
async function describe(opts) {

    const w = await snapshot(opts);

    const baris = [];

    const tulis = (label, f) => {
        if (!f) return;
        baris.push(`${label}: ${f.unknown ? `tidak diketahui (${f.note})` : f.value}`);
    };

    tulis("Mesin", w.mesin.host);
    tulis("Sistem", w.mesin.platform);
    tulis("CPU", w.mesin.cpu);
    tulis("Memori", w.mesin.memori);

    for (const [huruf, f] of Object.entries(w.penyimpanan)) {
        if (!f.unknown) tulis(`Disk ${huruf}:`, f);
    }

    for (const [nama, f] of Object.entries(w.layanan)) {
        tulis(`Layanan ${nama}`, f);
    }

    tulis("Model termuat", w.kecerdasan.termuat);
    tulis("Keadaan", w.batas.berhenti);
    tulis("Gerbang risiko", w.batas.gerbangRisiko);

    return {
        ringkasan: baris.join("\n"),
        diperiksa: w.at,
        cached: w.cached
    };

}

module.exports = { snapshot, describe, TTL_MS };
