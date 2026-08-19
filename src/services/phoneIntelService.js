const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");

/**
 * Aether Phone Intelligence — analisis & mitigasi penipuan telepon.
 *
 * Fitur:
 *   1. Lookup nomor: kode negara, carrier, jenis line (mobile/landline/VoIP/toll-free).
 *   2. Skor penipuan: pola nomor yang sering dipakai scammer.
 *   3. Live call assessment: saat panggilan masuk, analisis risiko real-time.
 *   4. Blacklist/whitelist pengguna.
 *
 * Sumber:
 *   - Offline database (kode negara, prefix carrier Indonesia).
 *   - Gratis: numverify (50 req/bln, tanpa key), ipqs (tidak perlu).
 *   - Pattern matching untuk scam umum Indonesia.
 *
 * Prinsip: membantu korban penipuan, bukan melacak orang secara ilegal.
 */

const FILE = process.env.AETHER_PHONE_INTEL_FILE
    || path.join(__dirname, "..", "..", "configs", "phone-intel.json");

const store = new JsonStore(FILE, { blacklist: [], whitelist: [], history: {} });

// ---- Prefix carrier Indonesia (offline database) --------------------

const ID_CARRIERS = {
    // Telkomsel
    "811": "Telkomsel (Halo)", "812": "Telkomsel", "813": "Telkomsel",
    "821": "Telkomsel (simPATI)", "822": "Telkomsel (simPATI)", "823": "Telkomsel (simPATI)",
    "851": "Telkomsel (simPATI)", "852": "Telkomsel (simPATI)", "853": "Telkomsel (simPATI)",
    // Indosat Ooredoo
    "814": "Indosat (IM3)", "815": "Indosat (Mentari)", "816": "Indosat (IM3)",
    "855": "Indosat (IM3)", "856": "Indosat (IM3)", "857": "Indosat (IM3)", "858": "Indosat (IM3)",
    // XL Axiata
    "817": "XL", "818": "XL", "819": "XL", "859": "XL", "877": "XL", "878": "XL",
    // 3 (Tri)
    "895": "3 (Tri)", "896": "3 (Tri)", "897": "3 (Tri)", "898": "3 (Tri)", "899": "3 (Tri)",
    // Smartfren
    "881": "Smartfren", "882": "Smartfren", "883": "Smartfren", "884": "Smartfren",
    "885": "Smartfren", "886": "Smartfren", "887": "Smartfren", "888": "Smartfren", "889": "Smartfren",
    // Axis
    "831": "Axis", "832": "Axis", "833": "Axis", "838": "Axis",
    // Net1 (Sampoerna)
    "827": "Net1", "828": "Net1",
    // By.U (Telkomsel digital)
    "851": "By.U (Telkomsel)",
    // Switch (Smartfren digital)
    "889": "Switch (Smartfren)"
};

// Prefix internasional yang sering dipakai scam ke Indonesia
const SCAM_PREFIXES = new Set([
    "+1", "+44", "+852", "+65", "+60", "+91", "+92", "+93", "+94", "+95",
    "+212", "+213", "+216", "+218", "+234", "+251", "+254", "+256", "+260"
]);

// Pola scam umum
const SCAM_PATTERNS = [
    { pattern: /^\+?62\d{9,}$/, score: 0, note: "Nomor Indonesia normal" },
    { pattern: /^\+?1\d{10}$/, score: 20, note: "Nomor US/Canada — sering dipakai scam" },
    { pattern: /^\+?44\d{10}$/, score: 20, note: "Nomor UK — sering dipakai scam" },
    { pattern: /^\+?\d{13,}$/, score: 30, note: "Panjang tidak wajar" },
    { pattern: /^\+?0{3,}/, score: 40, note: "Prefix tidak valid" },
    { pattern: /(\d)\1{5,}/, score: 35, note: "Digit berulang berlebihan" },
    { pattern: /^\+?800/, score: 15, note: "Toll-free — sering dipakai telemarketing/scam" }
];

// ---- Analisis nomor ------------------------------------------------

function analyze(phone) {
    const raw = String(phone).trim();
    if (!raw) throw new Error("Masukkan nomor telepon.");

    // Normalisasi
    let digits = raw.replace(/\D/g, "");
    let normalized = raw;
    let country = null;
    let countryCode = null;
    let carrier = null;
    let lineType = "unknown";

    // Deteksi kode negara
    if (digits.startsWith("0")) {
        // Lokal Indonesia (0812...)
        normalized = "+62" + digits.slice(1);
        countryCode = "62";
        country = "Indonesia";
        digits = digits.slice(1);
    }
    else if (digits.startsWith("62")) {
        normalized = "+" + digits;
        countryCode = "62";
        country = "Indonesia";
        digits = digits.slice(2);
    }
    else {
        // Cari kode negara internasional (1-3 digit)
        for (let len = Math.min(3, digits.length - 7); len >= 1; len--) {
            const cc = digits.slice(0, len);
            if (COUNTRY_CODES[cc]) {
                countryCode = cc;
                country = COUNTRY_CODES[cc];
                normalized = "+" + digits;
                digits = digits.slice(len);
                break;
            }
        }
    }

    // Deteksi carrier (Indonesia)
    if (countryCode === "62" && digits.length >= 3) {
        const prefix = digits.slice(0, 3);
        carrier = ID_CARRIERS[prefix] ?? null;
        lineType = digits.length >= 9 && digits.length <= 11 ? "mobile" : "unknown";
    }

    // Deteksi jenis line
    if (lineType === "unknown") {
        if (digits.length >= 9 && digits.length <= 12) lineType = "mobile";
        else if (digits.length === 7 || digits.length === 8) lineType = "landline";
        else if (digits.startsWith("800") || digits.startsWith("808")) lineType = "toll-free";
    }

    // Skor penipuan
    let scamScore = 0;
    const scamNotes = [];

    // Blacklist pengguna
    const data = store.read();
    if (data.blacklist.includes(normalized)) {
        scamScore += 100;
        scamNotes.push("Nomor ada di blacklist pengguna");
    }

    // Whitelist pengguna
    if (data.whitelist.includes(normalized)) {
        scamScore = Math.max(0, scamScore - 50);
        scamNotes.push("Nomor ada di whitelist pengguna");
    }

    // Prefix scam internasional
    if (SCAM_PREFIXES.has("+" + countryCode)) {
        scamScore += 25;
        scamNotes.push(`Prefix +${countryCode} sering dipakai scam ke Indonesia`);
    }

    // Pola scam
    for (const { pattern, score, note } of SCAM_PATTERNS) {
        if (pattern.test(normalized)) {
            scamScore += score;
            if (score > 0) scamNotes.push(note);
        }
    }

    // Nomor terlalu pendek/panjang
    if (digits.length < 7) {
        scamScore += 50;
        scamNotes.push("Nomor terlalu pendek — tidak valid");
    }
    if (digits.length > 13) {
        scamScore += 30;
        scamNotes.push("Nomor terlalu panjang — mencurigakan");
    }

    // Nomor Indonesia tanpa prefix yang dikenal
    if (countryCode === "62" && !carrier) {
        scamScore += 10;
        scamNotes.push("Prefix tidak dikenal di database carrier Indonesia");
    }

    // Batasi 0-100
    scamScore = Math.min(100, Math.max(0, scamScore));

    // Level risiko
    const riskLevel =
        scamScore >= 70 ? "TINGGI" :
        scamScore >= 40 ? "SEDANG" :
        scamScore >= 20 ? "RENDAH" : "AMAN";

    return {
        raw,
        normalized,
        masked: maskPhone(normalized),
        country,
        countryCode,
        carrier,
        lineType,
        national: digits,
        length: digits.length,
        scamScore,
        riskLevel,
        scamNotes: scamNotes.length ? scamNotes : ["Tidak ada pola scam yang terdeteksi"],
        timestamp: new Date().toISOString()
    };
}

function maskPhone(phone) {
    const s = String(phone).replace(/\D/g, "");
    if (s.length <= 4) return "••••";
    return s.slice(0, 4) + "•••" + s.slice(-3);
}

// ---- Live call assessment -------------------------------------------

/**
 * Penilaian panggilan masuk secara real-time.
 * Dipanggil saat ponsel berdering (lewat integrasi Tasker/FTS).
 */
function assessCall(phone, { duration = 0, answered = false } = {}) {
    const info = analyze(phone);

    // Faktor tambahan dari panggilan
    let liveScore = info.scamScore;
    const liveNotes = [...info.scamNotes];

    // Durasi sangat pendek (missed call scam)
    if (duration > 0 && duration < 5) {
        liveScore += 20;
        liveNotes.push("Panggilan sangat singkat — mungkin 'missed call scam'");
    }

    // Tidak diangkat (survey/robocall)
    if (!answered && duration > 30) {
        liveScore += 10;
        liveNotes.push("Panggilan tidak diangkat — mungkin robocall");
    }

    liveScore = Math.min(100, liveScore);

    const verdict =
        liveScore >= 70 ? "TOLAK — Kemungkinan besar penipuan" :
        liveScore >= 40 ? "WASPADA — Angkat dengan hati-hati" :
        liveScore >= 20 ? "PERHATIAN — Nomor tidak dikenal" :
        "AMAN — Nomor terverifikasi";

    // Simpan riwayat
    const data = store.read();
    const hist = data.history[info.normalized] ?? { count: 0, firstSeen: info.timestamp };
    hist.count++;
    hist.lastSeen = info.timestamp;
    hist.lastScore = liveScore;
    data.history[info.normalized] = hist;
    store.write(data);

    return {
        ...info,
        liveScore,
        verdict,
        liveNotes,
        callCount: hist.count,
        firstSeen: hist.firstSeen,
        recommendation: liveScore >= 40
            ? "Jangan berikan data pribadi, OTP, atau transfer uang."
            : "Tetap waspada, verifikasi identitas penelepon."
    };
}

// ---- Blacklist & whitelist -------------------------------------------

function blacklistAdd(phone) {
    const normalized = analyze(phone).normalized;
    const data = store.read();
    if (!Array.isArray(data.blacklist)) data.blacklist = [];
    if (!data.blacklist.includes(normalized)) {
        data.blacklist.push(normalized);
        store.write(data);
    }
    return { blacklisted: normalized };
}

function blacklistRemove(phone) {
    const normalized = analyze(phone).normalized;
    const data = store.read();
    if (!Array.isArray(data.blacklist)) data.blacklist = [];
    data.blacklist = data.blacklist.filter(p => p !== normalized);
    store.write(data);
    return { removed: normalized };
}

function whitelistAdd(phone) {
    const normalized = analyze(phone).normalized;
    const data = store.read();
    if (!Array.isArray(data.whitelist)) data.whitelist = [];
    if (!data.whitelist.includes(normalized)) {
        data.whitelist.push(normalized);
        store.write(data);
    }
    return { whitelisted: normalized };
}

function list() {
    const data = store.read();
    const blacklist = Array.isArray(data.blacklist) ? data.blacklist : [];
    const whitelist = Array.isArray(data.whitelist) ? data.whitelist : [];
    const history = data.history && typeof data.history === "object" ? data.history : {};
    return {
        blacklist: blacklist.map(maskPhone),
        whitelist: whitelist.map(maskPhone),
        history: Object.entries(history)
            .map(([phone, h]) => ({ phone: maskPhone(phone), ...h }))
            .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
            .slice(0, 50)
    };
}

// ---- Kode negara (dari osintService) ---------------------------------

const COUNTRY_CODES = require("./osintService").COUNTRY_CODES;

module.exports = {
    analyze,
    assessCall,
    blacklistAdd,
    blacklistRemove,
    whitelistAdd,
    list,
    ID_CARRIERS,
    SCAM_PREFIXES,
    maskPhone
};
