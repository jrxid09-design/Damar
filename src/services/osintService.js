const path = require("node:path");
const crypto = require("node:crypto");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");

/**
 * Aether OSINT Engine — detektif & investigator digital.
 *
 * Mengumpulkan, mengorelasikan, dan menganalisis informasi dari
 * sumber terbuka (OSINT) untuk investigasi yang sah. Semua sumber
 * gratis; HIBP dipakai bila pengguna sudah punya key.
 *
 * Prinsip: hanya untuk investigasi yang sah — penelitian keamanan,
 * pemulihan akun, verifikasi identitas, atau kasus hukum yang valid.
 * Tidak untuk doxing, stalking, atau pelanggaran privasi.
 *
 * Sumber yang dipakai:
 *   - Breach check gratis — LeakCheck + ProxyNova + katalog lokal
 *   - Username search — cek ketersediaan username di puluhan platform
 *   - Email analysis — format, disposable, domain, MX records
 *   - Phone analysis — format, kode negara, carrier lookup (dasar)
 *   - Domain/website analysis — DNS, SSL, redirect, teknologi
 *   - Social intelligence — bot detection, hoax check, comment tracing
 *   - Social graph — korelasi antar temuan (username sama, email sama)
 *
 * Case management: setiap investigasi adalah "kasus" dengan temuan,
 * bukti, dan kesimpulan yang bisa diekspor.
 */

const FILE = process.env.AETHER_OSINT_FILE
    || path.join(__dirname, "..", "..", "configs", "osint.json");

const store = new JsonStore(FILE, { cases: {}, reports: {} });

// ---- Utilitas ----------------------------------------------------

function id() {
    return "case_" + crypto.randomBytes(4).toString("hex");
}

function now() {
    return new Date().toISOString();
}

function maskEmail(email) {
    const [local, domain] = String(email).split("@");
    if (!domain) return email;
    const masked = local.length <= 2
        ? local[0] + "•••"
        : local.slice(0, 2) + "•••" + local.slice(-1);
    return `${masked}@${domain}`;
}

function maskPhone(phone) {
    const s = String(phone).replace(/\D/g, "");
    if (s.length <= 4) return "••••";
    return s.slice(0, 3) + "•••" + s.slice(-3);
}

// ---- Analisis email (pure) ----------------------------------------

const DISPOSABLE_DOMAINS = new Set([
    "tempmail.com", "throwaway.com", "mailinator.com", "guerrillamail.com",
    "10minutemail.com", "yopmail.com", "trashmail.com", "fakeinbox.com",
    "sharklasers.com", "getairmail.com", "maildrop.cc", "dispostable.com"
]);

const FREE_EMAIL = new Set([
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
    "icloud.com", "mail.com", "protonmail.com", "zoho.com", "gmx.com"
]);

function analyzeEmail(email) {
    const e = String(email).trim().toLowerCase();
    const at = e.indexOf("@");
    if (at < 1 || at === e.length - 1) {
        return { valid: false, error: "Format email tidak valid." };
    }

    const local = e.slice(0, at);
    const domain = e.slice(at + 1);

    return {
        valid: true,
        email: e,
        masked: maskEmail(e),
        local,
        domain,
        isDisposable: DISPOSABLE_DOMAINS.has(domain),
        isFree: FREE_EMAIL.has(domain),
        isCorporate: !FREE_EMAIL.has(domain) && !DISPOSABLE_DOMAINS.has(domain),
        localLength: local.length,
        hasNumbers: /\d/.test(local),
        hasDots: local.includes("."),
        hasPlus: local.includes("+"),
        domainParts: domain.split(".").length
    };
}

// ---- Analisis telepon (pure) --------------------------------------

const COUNTRY_CODES = {
    "1": "US/Canada", "7": "Russia/Kazakhstan", "20": "Egypt", "27": "South Africa",
    "30": "Greece", "31": "Netherlands", "32": "Belgium", "33": "France", "34": "Spain",
    "36": "Hungary", "39": "Italy", "40": "Romania", "41": "Switzerland", "43": "Austria",
    "44": "UK", "45": "Denmark", "46": "Sweden", "47": "Norway", "48": "Poland",
    "49": "Germany", "51": "Peru", "52": "Mexico", "53": "Cuba", "54": "Argentina",
    "55": "Brazil", "56": "Chile", "57": "Colombia", "58": "Venezuela", "60": "Malaysia",
    "61": "Australia", "62": "Indonesia", "63": "Philippines", "64": "New Zealand",
    "65": "Singapore", "66": "Thailand", "81": "Japan", "82": "South Korea", "84": "Vietnam",
    "86": "China", "90": "Turkey", "91": "India", "92": "Pakistan", "93": "Afghanistan",
    "94": "Sri Lanka", "95": "Myanmar", "98": "Iran", "212": "Morocco", "213": "Algeria",
    "216": "Tunisia", "218": "Libya", "220": "Gambia", "221": "Senegal", "222": "Mauritania",
    "223": "Mali", "224": "Guinea", "225": "Ivory Coast", "226": "Burkina Faso", "227": "Niger",
    "228": "Togo", "229": "Benin", "230": "Mauritius", "231": "Liberia", "232": "Sierra Leone",
    "233": "Ghana", "234": "Nigeria", "235": "Chad", "236": "Central African Republic",
    "237": "Cameroon", "238": "Cape Verde", "239": "Sao Tome", "240": "Equatorial Guinea",
    "241": "Gabon", "242": "Congo", "243": "DR Congo", "244": "Angola", "245": "Guinea-Bissau",
    "246": "Diego Garcia", "247": "Ascension", "248": "Seychelles", "249": "Sudan",
    "250": "Rwanda", "251": "Ethiopia", "252": "Somalia", "253": "Djibouti", "254": "Kenya",
    "255": "Tanzania", "256": "Uganda", "257": "Burundi", "258": "Mozambique", "260": "Zambia",
    "261": "Madagascar", "262": "Reunion", "263": "Zimbabwe", "264": "Namibia", "265": "Malawi",
    "266": "Lesotho", "267": "Botswana", "268": "Swaziland", "269": "Comoros", "290": "Saint Helena",
    "291": "Eritrea", "297": "Aruba", "298": "Faroe Islands", "299": "Greenland",
    "350": "Gibraltar", "351": "Portugal", "352": "Luxembourg", "353": "Ireland",
    "354": "Iceland", "355": "Albania", "356": "Malta", "357": "Cyprus", "358": "Finland",
    "359": "Bulgaria", "370": "Lithuania", "371": "Latvia", "372": "Estonia", "373": "Moldova",
    "374": "Armenia", "375": "Belarus", "376": "Andorra", "377": "Monaco", "378": "San Marino",
    "380": "Ukraine", "381": "Serbia", "382": "Montenegro", "383": "Kosovo", "385": "Croatia",
    "386": "Slovenia", "387": "Bosnia", "389": "North Macedonia", "420": "Czech Republic",
    "421": "Slovakia", "423": "Liechtenstein", "500": "Falkland Islands", "501": "Belize",
    "502": "Guatemala", "503": "El Salvador", "504": "Honduras", "505": "Nicaragua",
    "506": "Costa Rica", "507": "Panama", "508": "Saint Pierre", "509": "Haiti",
    "590": "Guadeloupe", "591": "Bolivia", "592": "Guyana", "593": "Ecuador", "594": "French Guiana",
    "595": "Paraguay", "596": "Martinique", "597": "Suriname", "598": "Uruguay", "599": "Curacao",
    "670": "East Timor", "672": "Norfolk Island", "673": "Brunei", "674": "Nauru",
    "675": "Papua New Guinea", "676": "Tonga", "677": "Solomon Islands", "678": "Vanuatu",
    "679": "Fiji", "680": "Palau", "681": "Wallis", "682": "Cook Islands", "683": "Niue",
    "685": "Samoa", "686": "Kiribati", "687": "New Caledonia", "688": "Tuvalu",
    "689": "French Polynesia", "690": "Tokelau", "691": "Micronesia", "692": "Marshall Islands",
    "850": "North Korea", "852": "Hong Kong", "853": "Macau", "855": "Cambodia", "856": "Laos",
    "880": "Bangladesh", "886": "Taiwan", "960": "Maldives", "961": "Lebanon", "962": "Jordan",
    "963": "Syria", "964": "Iraq", "965": "Kuwait", "966": "Saudi Arabia", "967": "Yemen",
    "968": "Oman", "970": "Palestine", "971": "UAE", "972": "Israel", "973": "Bahrain",
    "974": "Qatar", "975": "Bhutan", "976": "Mongolia", "977": "Nepal", "992": "Tajikistan",
    "993": "Turkmenistan", "994": "Azerbaijan", "995": "Georgia", "996": "Kyrgyzstan", "998": "Uzbekistan"
};

function analyzePhone(phone) {
    const raw = String(phone).trim();
    const digits = raw.replace(/\D/g, "");

    if (digits.length < 7 || digits.length > 15) {
        return { valid: false, error: "Nomor telepon harus 7-15 digit." };
    }

    // Cari kode negara (1-3 digit)
    let countryCode = null;
    let country = null;
    for (let len = Math.min(3, digits.length - 7); len >= 1; len--) {
        const cc = digits.slice(0, len);
        if (COUNTRY_CODES[cc]) {
            countryCode = cc;
            country = COUNTRY_CODES[cc];
            break;
        }
    }

    const national = countryCode ? digits.slice(countryCode.length) : digits;

    return {
        valid: true,
        raw,
        digits,
        masked: maskPhone(raw),
        countryCode,
        country,
        national,
        length: digits.length,
        nationalLength: national.length,
        isMobile: national.length >= 9 && national.length <= 12,
        possibleTypes: national.length >= 9 && national.length <= 12 ? ["mobile"] : ["landline", "voip"]
    };
}

// ---- Username search (gratis) -------------------------------------

/**
 * Katalog platform — hanya yang bisa DIBUKTIKAN.
 *
 * Versi lama memakai HEAD lalu menganggap "200 = akun ada". Itu salah
 * untuk sebagian besar situs modern: Instagram, Pinterest, Steam,
 * Telegram, WordPress, dan 500px membalas 200 untuk nama APA PUN
 * (halaman "tidak ditemukan" tetap berstatus 200), sedangkan GitLab,
 * LinkedIn, Medium, Tumblr, dan StackOverflow membalas 403/405 untuk
 * HEAD dari klien non-browser. Hasilnya: temuan palsu bercampur galat
 * — persis yang membuat panel ini tidak bisa dipakai.
 *
 * Tiap entri kini punya `probe(res, body)` yang mengembalikan:
 *   true  → akun terbukti ada
 *   false → akun terbukti tidak ada
 *   null  → tidak bisa dipastikan (diblokir / situs berubah)
 *
 * Aturannya diverifikasi langsung terhadap situsnya (akun yang pasti
 * ada vs nama acak yang pasti tidak ada). Platform yang TIDAK bisa
 * dibedakan sengaja tidak didaftarkan — lebih baik sedikit sumber
 * yang jujur daripada banyak sumber yang menebak.
 */

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Pola paling umum: 200 ada, 404 tidak ada, sisanya tak pasti. */
const byStatus = (res) => res.status === 200 ? true : res.status === 404 ? false : null;

/** Baca JSON tanpa melempar. */
function asJson(body) {
    try { return JSON.parse(body); }
    catch { return null; }
}

const PLATFORMS = [

    // --- API resmi: paling dapat dipercaya ---
    { name: "GitHub", cat: "kode", profile: "https://github.com/{}",
      url: "https://api.github.com/users/{}", probe: byStatus },

    { name: "GitLab", cat: "kode", profile: "https://gitlab.com/{}",
      url: "https://gitlab.com/api/v4/users?username={}",
      probe: (res, body) => res.status !== 200 ? null : (asJson(body) ?? []).length > 0 },

    { name: "Docker Hub", cat: "kode", profile: "https://hub.docker.com/u/{}",
      url: "https://hub.docker.com/v2/users/{}/", probe: byStatus },

    { name: "StackOverflow", cat: "kode", profile: "https://stackoverflow.com/users",
      url: "https://api.stackexchange.com/2.3/users?inname={}&site=stackoverflow",
      probe: (res, body) => res.status !== 200 ? null : (asJson(body)?.items ?? []).length > 0 },

    { name: "HackerNews", cat: "forum", profile: "https://news.ycombinator.com/user?id={}",
      url: "https://hacker-news.firebaseio.com/v0/user/{}.json",
      probe: (res, body) => res.status !== 200 ? null : body.trim() !== "null" },

    { name: "Wikipedia", cat: "forum", profile: "https://en.wikipedia.org/wiki/User:{}",
      url: "https://en.wikipedia.org/w/api.php?action=query&list=users&ususers={}&format=json",
      probe: (res, body) => {
          const u = asJson(body)?.query?.users?.[0];
          return u ? !("missing" in u) : null;
      } },

    { name: "Keybase", cat: "identitas", profile: "https://keybase.io/{}",
      url: "https://keybase.io/_/api/1.0/user/lookup.json?username={}",
      probe: (res, body) => {
          const status = asJson(body)?.status;
          if (!status) return null;
          if (status.code === 0) return true;
          // 100 = "invalid name", 205 = "user not found" → tidak ada.
          return [100, 205].includes(status.code) ? false : null;
      } },

    { name: "Gravatar", cat: "identitas", profile: "https://gravatar.com/{}",
      url: "https://gravatar.com/{}.json", probe: byStatus },

    { name: "Mastodon", cat: "sosial", profile: "https://mastodon.social/@{}",
      url: "https://mastodon.social/api/v1/accounts/lookup?acct={}", probe: byStatus },

    { name: "Bluesky", cat: "sosial", profile: "https://bsky.app/profile/{}.bsky.social",
      url: "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle={}.bsky.social",
      probe: (res) => res.status === 200 ? true : res.status === 400 ? false : null },

    { name: "Chess.com", cat: "game", profile: "https://chess.com/member/{}",
      url: "https://api.chess.com/pub/player/{}", probe: byStatus },

    // --- Halaman HTML yang statusnya benar-benar membedakan ---
    { name: "YouTube", cat: "sosial", url: "https://www.youtube.com/@{}", probe: byStatus },
    { name: "Snapchat", cat: "sosial", url: "https://www.snapchat.com/add/{}", probe: byStatus },
    { name: "SoundCloud", cat: "musik", url: "https://soundcloud.com/{}", probe: byStatus },
    { name: "DeviantArt", cat: "kreatif", url: "https://www.deviantart.com/{}", probe: byStatus },
    { name: "Flickr", cat: "kreatif", url: "https://www.flickr.com/people/{}", probe: byStatus },

    // --- Penanda isi halaman (statusnya selalu 200) ---
    {
        // TikTok mengirim HTML yang nyaris identik untuk akun yang ada
        // dan yang tidak — termasuk teks "Couldn't find this account"
        // yang ternyata SELALU ada (bagian dari bundel terjemahan).
        // Yang benar-benar membedakan adalah data profilnya sendiri:
        // `followerCount`/`uniqueId` hanya muncul bila akunnya nyata.
        name: "TikTok", cat: "sosial", url: "https://www.tiktok.com/@{}",
        probe: (res, body) => {
            if (res.status === 404) return false;
            if (res.status !== 200) return null;
            if (/"followerCount"|"uniqueId"/.test(body)) return true;
            // Halaman memang tergambar tapi tanpa data profil → tidak ada.
            return /webapp\.user-detail/.test(body) ? false : null;
        }
    },

    {
        // Threads (Meta) — profil di threads.net/@user. 404 = tak ada;
        // halaman profil nyata memuat data user (schema/og profil).
        name: "Threads", cat: "sosial", url: "https://www.threads.net/@{}",
        probe: (res, body) => {
            if (res.status === 404) return false;
            if (res.status !== 200) return null;
            if (/"user":\{|profile_pic_url|"follower_count"|og:title/i.test(body)) return true;
            return null;
        }
    },

    {
        // t.me membalas 200 untuk nama apa pun. Bedanya ada di judul:
        // akun/kanal/grup yang ada → "Telegram: View @nama";
        // yang tidak ada → "Telegram: Contact @nama".
        name: "Telegram", cat: "pesan", url: "https://t.me/{}",
        probe: (res, body) => {
            if (res.status !== 200) return null;
            if (/tgme_page_title/.test(body)) return true;
            return /Telegram:\s*Contact/i.test(body) ? false : null;
        }
    }

];

/**
 * Periksa satu platform.
 *
 * Memakai GET dengan User-Agent browser (bukan HEAD): banyak situs
 * menolak HEAD, dan sebagian hanya bisa dipastikan dari badan
 * jawabannya. Kegagalan jaringan dilaporkan sebagai "tidak pasti",
 * bukan "tidak ada".
 */
async function checkUsername(platform, username, timeout = 10000) {

    const enc = encodeURIComponent(username);
    const url = platform.url.replace("{}", enc);
    const link = (platform.profile ?? platform.url).replace("{}", enc);

    try {

        const res = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(timeout),
            headers: {
                "User-Agent": BROWSER_UA,
                "Accept-Language": "en-US,en;q=0.9"
            }
        });

        const body = await res.text();

        return {
            platform: platform.name,
            category: platform.cat ?? "lain",
            url: link,
            found: platform.probe(res, body),        // true | false | null
            status: res.status
        };

    }
    catch (error) {
        return {
            platform: platform.name,
            category: platform.cat ?? "lain",
            url: link,
            found: null,
            status: null,
            note: `tidak terjangkau: ${error.message}`
        };
    }

}

/**
 * Cari username di seluruh platform terdaftar.
 *
 * Hasilnya memuat KETIGA keadaan. Yang "tidak pasti" tidak dibuang:
 * menyembunyikannya membuat laporan tampak lebih meyakinkan daripada
 * kenyataannya, dan itu jenis kebohongan yang paling berbahaya pada
 * alat investigasi.
 */
async function searchUsername(username, { maxPlatforms = PLATFORMS.length, timeout = 10000 } = {}) {

    const u = String(username).trim().toLowerCase();

    if (!u || u.length < 2 || u.length > 30 || !/^[a-z0-9_.-]+$/.test(u)) {
        throw new Error("Username tidak valid (2-30 karakter, huruf/angka/_.-).");
    }

    const platforms = PLATFORMS.slice(0, maxPlatforms);

    const results = await Promise.allSettled(
        platforms.map(p => checkUsername(p, u, timeout))
    );

    return results.map((r, i) => r.status === "fulfilled"
        ? r.value
        : {
            platform: platforms[i].name,
            category: platforms[i].cat ?? "lain",
            found: null,
            note: r.reason?.message ?? "gagal"
        });

}

// ---- Telegram: akun, kanal, dan GRUP ------------------------------

/**
 * Telusuri satu nama di Telegram.
 *
 * Selain "ada / tidak ada", halaman t.me menyebut jenis entitas dan
 * jumlah anggota — itulah yang membedakan grup ramai dari akun
 * pribadi, dan konteks itu yang paling berguna dalam investigasi.
 */
async function telegramLookup(name) {

    const n = String(name).trim().replace(/^@/, "");

    if (!/^[a-zA-Z0-9_]{4,32}$/.test(n)) {
        throw new Error("Nama Telegram tidak valid (4-32 karakter, huruf/angka/_).");
    }

    const url = `https://t.me/${encodeURIComponent(n)}`;

    const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }
    });

    const body = await res.text();

    if (!/tgme_page_title/.test(body)) {
        return { name: n, url, exists: false, kind: null, members: null, title: null, description: null };
    }

    const pick = (re) => { const m = body.match(re); return m ? m[1].trim() : null; };

    const title = pick(/tgme_page_title["'][^>]*>\s*(?:<span[^>]*>)?([^<]+)/i);
    const extra = pick(/tgme_page_extra["'][^>]*>([^<]+)/i);

    const description = pick(/tgme_page_description["'][^>]*>([\s\S]{0,400}?)<\/div>/i)
        ?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null;

    // "12 345 subscribers" / "678 members, 12 online"
    const membersRaw = extra?.match(/([\d\s.,]+)\s*(?:subscriber|member)/i);
    const members = membersRaw ? Number(membersRaw[1].replace(/\D/g, "")) : null;

    const kind = !extra ? "akun"
        : /member/i.test(extra) ? "grup"
            : /subscriber/i.test(extra) ? "kanal"
                : "akun";

    return { name: n, url, exists: true, kind, members, title, description, extra };

}

// ---- Domain analysis (gratis) -------------------------------------

async function analyzeDomain(domain) {
    const d = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!d || d.length < 3 || !d.includes(".")) {
        throw new Error("Domain tidak valid.");
    }

    const result = { domain: d, timestamp: now() };

    // DNS lookup (via Google DNS-over-HTTPS — gratis)
    try {
        const dns = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=A`);
        const data = await dns.json();
        result.dns = {
            status: data.Status,
            hasA: Boolean(data.Answer?.length),
            ips: (data.Answer ?? []).filter(a => a.type === 1).map(a => a.data),
            ttl: (data.Answer ?? [])[0]?.TTL ?? null
        };
    }
    catch (e) {
        result.dns = { error: e.message };
    }

    // MX records
    try {
        const mx = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=MX`);
        const data = await mx.json();
        result.mx = (data.Answer ?? []).map(a => a.data).filter(Boolean);
    }
    catch { result.mx = []; }

    // TXT records (SPF, DKIM, dll)
    try {
        const txt = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=TXT`);
        const data = await txt.json();
        result.txt = (data.Answer ?? []).map(a => a.data).filter(Boolean).slice(0, 10);
    }
    catch { result.txt = []; }

    // HTTP headers
    try {
        const res = await fetch(`https://${d}`, {
            method: "HEAD",
            redirect: "follow",
            signal: AbortSignal.timeout(8000)
        });
        result.http = {
            status: res.status,
            server: res.headers.get("server"),
            poweredBy: res.headers.get("x-powered-by"),
            contentType: res.headers.get("content-type"),
            finalUrl: res.url
        };
    }
    catch (e) {
        result.http = { error: e.message };
    }

    return result;
}

// ---- Case management ------------------------------------------------

function createCase({ title, description = "", target = {}, tags = [] } = {}) {
    const data = store.read();
    const caseId = id();
    const caseData = {
        id: caseId,
        title: String(title).trim() || "Kasus tanpa judul",
        description: String(description).trim(),
        target: {
            name: target.name ?? null,
            email: target.email ?? null,
            username: target.username ?? null,
            phone: target.phone ?? null,
            domain: target.domain ?? null,
            image: target.image ?? null
        },
        tags: Array.isArray(tags) ? tags.map(String) : [],
        status: "open",
        findings: [],
        evidence: [],
        timeline: [{ at: now(), event: "Kasus dibuat" }],
        createdAt: now(),
        updatedAt: now()
    };
    data.cases[caseId] = caseData;
    store.write(data);
    telemetry.info(`[osint] kasus dibuat: ${caseData.title}`);
    return caseData;
}

function addFinding(caseId, { type, source, data: findingData, confidence = "medium", notes = "" } = {}) {
    const data = store.read();
    const c = data.cases[caseId];
    if (!c) throw new Error("Kasus tidak ditemukan.");

    const finding = {
        id: "f_" + crypto.randomBytes(3).toString("hex"),
        type,
        source,
        data: findingData,
        confidence,
        notes: String(notes).trim(),
        at: now()
    };

    c.findings.push(finding);
    c.updatedAt = now();
    store.write(data);
    return finding;
}

function addEvidence(caseId, { type, description, data: evidenceData, source = "" } = {}) {
    const data = store.read();
    const c = data.cases[caseId];
    if (!c) throw new Error("Kasus tidak ditemukan.");

    const evidence = {
        id: "e_" + crypto.randomBytes(3).toString("hex"),
        type,
        description: String(description).trim(),
        data: evidenceData,
        source: String(source).trim(),
        at: now()
    };

    c.evidence.push(evidence);
    c.updatedAt = now();
    store.write(data);
    return evidence;
}

function closeCase(caseId, { conclusion = "", verdict = "inconclusive" } = {}) {
    const data = store.read();
    const c = data.cases[caseId];
    if (!c) throw new Error("Kasus tidak ditemukan.");

    c.status = "closed";
    c.conclusion = String(conclusion).trim();
    c.verdict = verdict;
    c.closedAt = now();
    c.updatedAt = now();
    c.timeline.push({ at: now(), event: `Kasus ditutup: ${verdict}` });
    store.write(data);
    return c;
}

function getCase(caseId) {
    const data = store.read();
    return data.cases[caseId] ?? null;
}

function listCases({ status = null, tag = null } = {}) {
    const data = store.read();
    let cases = Object.values(data.cases);
    if (status) cases = cases.filter(c => c.status === status);
    if (tag) cases = cases.filter(c => c.tags.includes(tag));
    return cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function deleteCase(caseId) {
    const data = store.read();
    if (!data.cases[caseId]) throw new Error("Kasus tidak ditemukan.");
    delete data.cases[caseId];
    store.write(data);
    return { deleted: caseId };
}

// ---- Investigasi otomatis ------------------------------------------

/**
 * Investigasi target (orang/email/username/domain/telepon).
 * Mengumpulkan semua data yang tersedia, mengorelasikan, dan
 * mengembalikan laporan terstruktur.
 */
async function investigate(target, { caseId = null } = {}) {
    const report = {
        target,
        timestamp: now(),
        sections: {},
        correlations: [],
        riskScore: 0,
        summary: ""
    };

    const findings = [];

    // 1. Email analysis
    if (target.email) {
        const emailInfo = analyzeEmail(target.email);
        report.sections.email = emailInfo;

        if (emailInfo.valid) {
            // Breach check (gratis — LeakCheck + ProxyNova)
            try {
                const breach = require("./breachService");
                const breachResult = await breach.check(target.email);
                report.sections.email.exposure = {
                    breached: breachResult.breached,
                    count: breachResult.sources?.length ?? 0,
                    sources: breachResult.sources?.map(s => s.name) ?? [],
                    fields: breachResult.fields ?? []
                };
                if (breachResult.breached) {
                    report.riskScore += Math.min((breachResult.sources?.length ?? 0) * 10, 40);
                    findings.push({
                        type: "exposure",
                        source: "Breach",
                        severity: "high",
                        data: { sources: breachResult.sources?.length ?? 0, fields: breachResult.fields }
                    });
                }
            }
            catch { /* breach check gagal — lanjut tanpa */ }
        }
    }

    // 2. Username search
    if (target.username) {
        const results = await searchUsername(target.username);
        const found = results.filter(r => r.found === true);
        const unsure = results.filter(r => r.found === null);

        report.sections.username = {
            username: target.username,
            platformsChecked: results.length,
            platformsFound: found.length,
            platformsUnsure: unsure.length,
            results
        };

        if (found.length > 0) {
            report.riskScore += Math.min(found.length * 5, 30);
            findings.push({
                type: "username",
                source: "platforms",
                severity: "medium",
                data: { found: found.length, platforms: found.map(f => f.platform) }
            });
        }

        // Telegram diperiksa terpisah karena ia menyimpan konteks yang
        // tidak dimiliki platform lain: jenis entitas (akun/kanal/grup)
        // dan jumlah anggota.
        try {
            const tg = await telegramLookup(target.username);
            report.sections.telegram = tg;
            if (tg.exists) {
                findings.push({
                    type: "telegram",
                    source: "t.me",
                    severity: tg.kind === "akun" ? "low" : "medium",
                    data: { kind: tg.kind, members: tg.members, title: tg.title }
                });
                report.riskScore += tg.kind === "akun" ? 5 : 10;
            }
        }
        catch (error) {
            report.sections.telegram = { error: error.message };
        }
    }

    // 3. Phone analysis
    if (target.phone) {
        const phoneInfo = analyzePhone(target.phone);
        report.sections.phone = phoneInfo;
    }

    // 4. Domain analysis
    if (target.domain) {
        const domainInfo = await analyzeDomain(target.domain);
        report.sections.domain = domainInfo;

        if (domainInfo.dns?.hasA) {
            report.riskScore += 5;
        }
        if (domainInfo.mx?.length > 0) {
            report.riskScore += 5;
        }
    }

    // 5. Korelasi
    if (target.email && target.username) {
        const emailInfo = analyzeEmail(target.email);
        const emailLocal = emailInfo?.local;
        if (emailLocal && target.username.toLowerCase().includes(emailLocal.toLowerCase())) {
            report.correlations.push({
                type: "email-username-match",
                detail: `Username "${target.username}" mirip dengan bagian email "${emailLocal}"`
            });
            report.riskScore += 15;
        }
    }

    if (target.email && target.domain) {
        const emailInfo = analyzeEmail(target.email);
        const emailDomain = emailInfo?.domain;
        if (emailDomain && emailDomain === target.domain) {
            report.correlations.push({
                type: "email-domain-match",
                detail: `Email menggunakan domain yang sama dengan target`
            });
            report.riskScore += 10;
        }
    }

    // 6. Ringkasan
    const riskLevel = report.riskScore >= 50 ? "TINGGI" : report.riskScore >= 25 ? "SEDANG" : "RENDAH";
    report.riskLevel = riskLevel;
    report.summary = `Investigasi ${target.name ?? target.email ?? target.username ?? target.domain ?? "target"}: ` +
        `${findings.length} temuan, risiko ${riskLevel} (${report.riskScore}/100).`;

    report.findings = findings;

    // Simpan ke kasus bila ada
    if (caseId) {
        for (const f of findings) {
            addFinding(caseId, {
                type: f.type,
                source: f.source,
                data: f.data,
                confidence: f.severity,
                notes: f.severity === "high" ? "Perhatian segera" : ""
            });
        }
        addEvidence(caseId, {
            type: "report",
            description: "Laporan investigasi otomatis",
            data: report
        });
    }

    return report;
}

// ---- Export laporan ------------------------------------------------

function exportCase(caseId) {
    const c = getCase(caseId);
    if (!c) throw new Error("Kasus tidak ditemukan.");

    const report = {
        title: c.title,
        status: c.status,
        created: c.createdAt,
        closed: c.closedAt ?? null,
        target: c.target,
        tags: c.tags,
        findings: c.findings,
        evidence: c.evidence,
        timeline: c.timeline,
        conclusion: c.conclusion ?? null,
        verdict: c.verdict ?? null,
        exportedAt: now()
    };

    return report;
}

module.exports = {
    analyzeEmail,
    analyzePhone,
    searchUsername,
    telegramLookup,
    analyzeDomain,
    investigate,
    createCase,
    getCase,
    listCases,
    addFinding,
    addEvidence,
    closeCase,
    deleteCase,
    exportCase,
    DISPOSABLE_DOMAINS,
    FREE_EMAIL,
    COUNTRY_CODES,
    PLATFORMS
};
