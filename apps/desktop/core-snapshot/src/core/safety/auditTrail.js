const fs = require("node:fs");
const path = require("node:path");

/**
 * Jejak audit tool yang bertahan (§96, Konstitusi Pasal 5).
 *
 * `telemetry.publish()` hanya memancarkan event — tidak menyimpannya.
 * Selama ini setiap `tool:execute` dan `tool:verify` lenyap kecuali
 * ada klien SSE yang kebetulan sedang tersambung. Artinya kalau
 * Console tidak terbuka, tidak ada catatan bahwa Damar menulis
 * berkas, mengirim pesan WhatsApp, atau bahwa sebuah verifikasi
 * gagal. Jejak audit yang hilang saat tak ada yang menonton bukan
 * jejak audit.
 *
 * JSONL satu berkas per hari: dapat dibaca manusia saat menelusuri
 * masalah, dapat dipotong per tanggal, dan tidak menuntut basis data
 * yang belum terbukti dibutuhkan (gerbang Ponytail §56).
 *
 * Kegagalan mencatat TIDAK pernah menjatuhkan eksekusi. Audit yang
 * membuat Damar berhenti bekerja akan dimatikan orang, dan audit
 * yang dimatikan tidak melindungi siapa pun.
 */

/**
 * Lokasi jejak. Dapat dialihkan lewat `DAMAR_AUDIT_DIR`.
 *
 * Bukan kenyamanan: tes menulis peristiwa palsu, dan jejak audit
 * yang tercampur data tes tidak dapat dipercaya justru saat
 * dibutuhkan untuk menelusuri kejadian sungguhan.
 */
const DIR = process.env.DAMAR_AUDIT_DIR
    || path.join(__dirname, "..", "..", "..", "data", "audit");

/** Simpan 14 hari. Cukup untuk menelusuri, tidak tumbuh selamanya. */
const RETENTION_DAYS = 14;

/**
 * Argumen TIDAK disimpan apa adanya.
 *
 * Argumen tool memuat isi berkas, teks pesan, dan jalur pribadi.
 * Menyalinnya ke berkas audit memindahkan data sensitif ke tempat
 * baru yang lebih mudah terbaca — melindungi lewat pencatatan tidak
 * boleh menciptakan kebocorannya sendiri. Yang disimpan hanya bentuk
 * argumennya: nama kunci, dan nilai pendek yang dipotong.
 */
const MAX_VALUE = 80;

function redact(args) {

    if (!args || typeof args !== "object") return {};

    const out = {};

    for (const [key, value] of Object.entries(args)) {

        if (value == null) {
            out[key] = null;
        }
        else if (typeof value === "string") {
            out[key] = value.length > MAX_VALUE
                ? `${value.slice(0, MAX_VALUE)}… (${value.length} kar.)`
                : value;
        }
        else if (typeof value === "number" || typeof value === "boolean") {
            out[key] = value;
        }
        else if (Array.isArray(value)) {
            out[key] = `[${value.length} item]`;
        }
        else {
            out[key] = `{${Object.keys(value).slice(0, 6).join(",")}}`;
        }

    }

    return out;

}

const fileFor = (date = new Date()) =>
    path.join(DIR, `${date.toISOString().slice(0, 10)}.jsonl`);

/**
 * Catat satu peristiwa tool.
 *
 * @param {object} entry
 * @param {string} entry.tool
 * @param {string} entry.risk
 * @param {"allowed"|"denied"|"ok"|"error"} entry.outcome
 */
function record(entry) {

    try {

        fs.mkdirSync(DIR, { recursive: true });

        const baris = JSON.stringify({
            at: new Date().toISOString(),
            ...entry,
            args: entry.args ? redact(entry.args) : undefined
        });

        fs.appendFileSync(fileFor(), `${baris}\n`, "utf8");

    }
    catch { /* audit tidak boleh menjatuhkan eksekusi */ }

}

/**
 * Peristiwa terbaru, terbaru dulu.
 *
 * Membaca mundur dari berkas hari ini ke hari-hari sebelumnya, dan
 * berhenti begitu cukup — supaya menelusuri hari ini tidak memaksa
 * membaca dua minggu.
 */
function recent({ limit = 100, tool = null, outcome = null } = {}) {

    const out = [];

    try {

        if (!fs.existsSync(DIR)) return out;

        const berkas = fs.readdirSync(DIR)
            .filter(f => f.endsWith(".jsonl"))
            .sort()
            .reverse();

        for (const f of berkas) {

            if (out.length >= limit) break;

            const baris = fs.readFileSync(path.join(DIR, f), "utf8")
                .split("\n")
                .filter(Boolean)
                .reverse();

            for (const b of baris) {

                if (out.length >= limit) break;

                let entry;
                try { entry = JSON.parse(b); }
                catch { continue; }   // baris rusak dilewati, bukan menggagalkan semua

                if (tool && entry.tool !== tool) continue;
                if (outcome && entry.outcome !== outcome) continue;

                out.push(entry);

            }

        }

    }
    catch { /* jejak yang tak terbaca bukan alasan menggagalkan status */ }

    return out;

}

/** Ringkasan untuk panel: berapa banyak, berapa yang bermasalah. */
function summary({ limit = 500 } = {}) {

    const entries = recent({ limit });

    const out = {
        total: entries.length,
        denied: 0,
        error: 0,
        verifiedFailed: 0,
        since: entries.length ? entries[entries.length - 1].at : null
    };

    for (const e of entries) {
        if (e.outcome === "denied") out.denied += 1;
        if (e.outcome === "error") out.error += 1;
        if (e.verification === "failed") out.verifiedFailed += 1;
    }

    return out;

}

/** Buang berkas yang lebih tua dari masa simpan. */
function prune(days = RETENTION_DAYS) {

    try {

        if (!fs.existsSync(DIR)) return 0;

        const batas = new Date(Date.now() - days * 86400000)
            .toISOString()
            .slice(0, 10);

        let dibuang = 0;

        for (const f of fs.readdirSync(DIR)) {

            if (!f.endsWith(".jsonl")) continue;

            if (f.slice(0, 10) < batas) {
                fs.unlinkSync(path.join(DIR, f));
                dibuang += 1;
            }

        }

        return dibuang;

    }
    catch {
        return 0;
    }

}

module.exports = { record, recent, summary, prune, redact, DIR, RETENTION_DAYS };
