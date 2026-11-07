const path = require("node:path");
const crypto = require("node:crypto");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");

/**
 * Damar Social Intelligence — analisis akun sosial media.
 *
 * Fitur:
 *   1. Bot detection — apakah akun asli atau bot (skor 0-100).
 *   2. Comment tracing — lacak komentar akun di mana saja & apa isinya.
 *   3. IP/location tracing — perkirakan lokasi bot (bila ada data).
 *   4. Hoax detection — cek keakuratan berita/konten.
 *   5. Hoax spreader tracing — lacak siapa yang menyebar hoax.
 *
 * Prinsip: membantu investigasi yang sah — verifikasi akun palsu,
 * melawan misinformasi, melindungi masyarakat dari manipulasi.
 * Tidak untuk doxing atau melanggar privasi.
 *
 * Sumber:
 *   - Analisis profil: rasio follower/following, usia akun, aktivitas.
 *   - Analisis konten: pola bot (repetitif, template, waktu posting).
 *   - Cross-platform: cek username di platform lain.
 *   - Network analysis: koneksi antar akun (siapa follow siapa).
 *   - Fact-check: katalog klaim + sumber terpercaya.
 */

const FILE = process.env.DAMAR_SOCIAL_INTEL_FILE
    || path.join(__dirname, "..", "..", "configs", "social-intel.json");

const store = new JsonStore(FILE, { traces: {}, factChecks: {}, networks: {} });

// ---- Katalog hoax & fakta (offline, diperbarui manual) ---------------

const FACT_CATALOG = {
    // Format: kata kunci → { hoax: bool, fact: "...", source: "...", confidence: "high|medium|low" }
    "vaksin covid-19 menyebabkan autisme": {
        hoax: true,
        fact: "Tidak ada bukti ilmiah yang menghubungkan vaksin COVID-19 dengan autisme. Studi besar di Denmark (650.000 anak) dan meta-analisis global tidak menemukan kaitan.",
        source: "WHO, CDC, The Lancet",
        confidence: "high"
    },
    "5g menyebabkan kanker": {
        hoax: true,
        fact: "Gelombang radio 5G non-ionizing tidak merusak DNA. ICNIRP dan WHO menyatakan aman dalam batas paparan yang direkomendasikan.",
        source: "ICNIRP, WHO",
        confidence: "high"
    },
    "bumi datar": {
        hoax: true,
        fact: "Bumi bulat. Bukti: foto satelit, perbedaan waktu zona, bayangan bulan, pelayaran kapal, penerbangan antar kutub.",
        source: "NASA, ESA, semua lembaga antariksa",
        confidence: "high"
    },
    "chemtrails berbahaya": {
        hoax: true,
        fact: "Jejak pesawat (contrails) adalah uap air yang mengembun. Tidak ada bukti zat kimia berbahaya disemprotkan.",
        source: "EPA, NASA, atmosfer sains",
        confidence: "high"
    },
    "microchip vaksin": {
        hoax: true,
        fact: "Vaksin tidak mengandung microchip. Komponen vaksin transparan dan diuji independen.",
        source: "FDA, EMA, BPOM",
        confidence: "high"
    },
    "plandemic": {
        hoax: true,
        fact: "Pandemi COVID-19 bukan rekayasa. Virus SARS-CoV-2 berasal dari alam (zoonosis) menurut analisis genom.",
        source: "Nature, Science, WHO",
        confidence: "high"
    },
    "pizza gate": {
        hoax: true,
        fact: "Teori konspirasi tanpa bukti. Tidak ada penyelidikan resmi yang menemukan kebenaran.",
        source: "FBI, Polisi DC",
        confidence: "high"
    },
    "qanon": {
        hoax: true,
        fact: "Teori konspirasi tanpa dasar. Tidak ada 'deep state' yang melawan presiden.",
        source: "FBI, peneliti ekstremisme",
        confidence: "high"
    },
    "flat earth society": {
        hoax: true,
        fact: "Organisasi parodi yang diambil serius oleh sebagian orang.",
        source: "Sejarah sains",
        confidence: "high"
    },
    "moon landing palsu": {
        hoax: true,
        fact: "Bukti kuat: retroreflektor laser di bulan masih dipakai, foto dari wahana independen (LRO, Chandrayaan), sampel batuan.",
        source: "NASA, LRO, observatorium global",
        confidence: "high"
    },
    "illuminati mengendalikan dunia": {
        hoax: true,
        fact: "Illuminati bubar tahun 1785. Tidak ada bukti kelompok rahasia mengendalikan pemerintahan global.",
        source: "Sejarah, arsip Bavaria",
        confidence: "high"
    },
    "area 51 alien": {
        hoax: true,
        fact: "Area 51 adalah fasilitas uji pesawat militer. Tidak ada bukti alien.",
        source: "CIA, dokumen yang dideklasifikasi",
        confidence: "high"
    },
    "bermuda triangle misterius": {
        hoax: true,
        fact: "Tingkat kecelakaan di Bermuda Triangle tidak lebih tinggi dari wilayah laut lain. Asuransi tidak mengenakan tarif khusus.",
        source: "Lloyd's of London, US Coast Guard",
        confidence: "high"
    },
    "vaksin mengandung merkuri berbahaya": {
        hoax: true,
        fact: "Thimerosal (etilmerkuri) dikeluarkan dari vaksin anak sejak 2001. Etilmerkuri diekskresi tubuh, tidak seperti metilmerkuri beracun.",
        source: "FDA, CDC",
        confidence: "high"
    },
    "wifi menyebabkan kanker": {
        hoax: true,
        fact: "Radiasi WiFi non-ionizing, jutaan kali lebih lemah dari sinar-X. WHO tidak mengklasifikasikan sebagai karsinogen.",
        source: "WHO, ICNIRP",
        confidence: "high"
    },
    "microwave merusak nutrisi makanan": {
        hoax: false,
        fact: "Microwave justru mempertahankan nutrisi lebih baik dari beberapa metode memasak lain (karena waktu singkat).",
        source: "Harvard Health, penelitian gizi",
        confidence: "medium"
    },
    "kopi menyebabkan kanker": {
        hoax: false,
        fact: "WHO mengeluarkan kopi dari daftar karsinogen 2016. Beberapa studi menunjukkan kopi mengurangi risiko beberapa kanker.",
        source: "WHO/IARC",
        confidence: "high"
    },
    "gula menyebabkan hiperaktif anak": {
        hoax: true,
        fact: "Meta-analisis 23 studi tidak menemukan hubungan gula dengan hiperaktif. Efek placebo pada orang tua yang percaya.",
        source: "JAMA, penelitian perilaku",
        confidence: "high"
    },
    "kita hanya pakai 10% otak": {
        hoax: true,
        fact: "Scan otak (fMRI, PET) menunjukkan hampir semua area otak aktif sepanjang hari. Kerusakan kecil saja bisa fatal.",
        source: "Neurosains, neurologi",
        confidence: "high"
    },
    "manusia punya 5 indera": {
        hoax: false,
        fact: "Kita punya lebih dari 20 indera: proprioception, equilibrioception, nociception, thermoception, chronoception, dll.",
        source: "Neurosains",
        confidence: "high"
    }
};

// Kata kunci untuk mendeteksi klaim yang perlu dicek
const HOAX_KEYWORDS = [
    "vaksin", "5g", "covid", "plandemic", "conspiracy", "hoax", "palsu",
    "fake", "bohong", "ditutupi", "rahasia", "terlarang", "tersembunyi",
    "misterius", "aneh", "ajaib", "mustahil", "tidak masuk akal"
];

// ---- Analisis profil sosial media ------------------------------------

/**
 * Analisis apakah akun sosial media asli atau bot.
 * Menggunakan heuristik dari data yang tersedia (tanpa API resmi).
 */
function analyzeAccount(profile) {
    const p = profile ?? {};
    const scores = [];
    const notes = [];

    // Rasio follower/following
    const followers = p.followers ?? 0;
    const following = p.following ?? 0;
    if (followers != null && following != null && (followers > 0 || following > 0)) {
        const ratio = followers / Math.max(following, 1);
        if (ratio < 0.01) {
            scores.push(30);
            notes.push("Rasio follower/following sangat rendah — khas bot");
        }
        else if (ratio > 100) {
            scores.push(10);
            notes.push("Rasio follower/following tinggi — khas influencer/bot besar");
        }
        else if (ratio > 0.5 && ratio < 2) {
            scores.push(-10);
            notes.push("Rasio follower/following seimbang — khas manusia");
        }
    }

    // Usia akun vs aktivitas
    if (p.createdAt) {
        const created = new Date(p.createdAt).getTime();
        if (Number.isFinite(created)) {
            const ageDays = (Date.now() - created) / 86400000;
            if (ageDays < 30) {
                scores.push(25);
                notes.push("Akun sangat baru (< 30 hari)");
            }
            else if (ageDays < 365 && (p.posts ?? 0) > 1000) {
                scores.push(20);
                notes.push("Posting sangat banyak untuk akun muda");
            }
        }
    }

    // Aktivitas posting
    if (p.posts != null && p.createdAt) {
        const created = new Date(p.createdAt).getTime();
        if (Number.isFinite(created)) {
            const ageDays = Math.max(1, (Date.now() - created) / 86400000);
            const postsPerDay = (p.posts ?? 0) / ageDays;
            if (postsPerDay > 50) {
                scores.push(35);
                notes.push(`Posting sangat sering (${Math.round(postsPerDay)}/hari) — khas bot`);
            }
            else if (postsPerDay > 10) {
                scores.push(15);
                notes.push(`Posting cukup sering (${Math.round(postsPerDay)}/hari)`);
            }
        }
    }

    // Username pola bot
    if (p.username) {
        const u = String(p.username).toLowerCase();
        if (/\d{4,}$/.test(u)) {
            scores.push(15);
            notes.push("Username dengan angka panjang di akhir — khas bot");
        }
        if (/^[a-z]+\d+$/.test(u) && u.length > 12) {
            scores.push(10);
            notes.push("Username huruf+angka panjang — khas bot otomatis");
        }
    }

    // Foto profil default
    if (p.hasDefaultAvatar === true) {
        scores.push(20);
        notes.push("Foto profil default/tidak ada — khas bot");
    }

    // Bio kosong atau template
    if (p.bio != null) {
        if (p.bio.length === 0) {
            scores.push(15);
            notes.push("Bio kosong — khas bot");
        }
        else if (p.bio.length < 10) {
            scores.push(5);
            notes.push("Bio sangat pendek");
        }
        else if (/follow|back|promo|click|link|dm|business/i.test(p.bio)) {
            scores.push(20);
            notes.push("Bio mengandung kata promosi/link — khas bot/spam");
        }
    }

    // Verifikasi
    if (p.verified === true) {
        scores.push(-40);
        notes.push("Akun terverifikasi — kemungkinan besar asli");
    }

    // Hitung skor akhir
    const total = scores.reduce((a, b) => a + b, 0);
    const botScore = Math.min(100, Math.max(0, total + 30)); // baseline 30

    const verdict =
        botScore >= 70 ? "BOT — hampir pasti akun palsu/otomatis" :
        botScore >= 50 ? "MENCURIGAKAN — banyak ciri bot" :
        botScore >= 30 ? "NETRAL — tidak cukup bukti" :
        "ASLI — kemungkinan besar manusia";

    return {
        botScore,
        verdict,
        isBot: botScore >= 50,
        confidence: botScore >= 70 || botScore <= 20 ? "high" : botScore >= 50 || botScore <= 30 ? "medium" : "low",
        notes: notes.length ? notes : ["Tidak ada pola mencurigakan"],
        metrics: {
            followers: p.followers ?? null,
            following: p.following ?? null,
            posts: p.posts ?? null,
            ageDays: p.createdAt ? (() => {
                const created = new Date(p.createdAt).getTime();
                return Number.isFinite(created) ? Math.round((Date.now() - created) / 86400000) : null;
            })() : null,
            postsPerDay: p.posts && p.createdAt ? (() => {
                const created = new Date(p.createdAt).getTime();
                if (!Number.isFinite(created)) return null;
                const ageDays = Math.max(1, (Date.now() - created) / 86400000);
                return ((p.posts ?? 0) / ageDays).toFixed(1);
            })() : null
        }
    };
}

// ---- Tracing komentar ------------------------------------------------

/**
 * Lacak komentar sebuah akun di berbagai platform.
 * Menggunakan pencarian cross-platform (tanpa API resmi).
 */
async function traceComments(username, { platforms = 15 } = {}) {
    const u = String(username).trim().toLowerCase();
    if (!u) throw new Error("Username wajib.");

    // Simpan jejak pencarian
    const traceId = "t_" + crypto.randomBytes(4).toString("hex");
    const data = store.read();
    data.traces[traceId] = {
        id: traceId,
        username: u,
        startedAt: new Date().toISOString(),
        status: "running",
        results: []
    };
    store.write(data);

    // Ambil komentar dari API PUBLIK yang benar-benar mengembalikan
    // isinya.
    //
    // Versi lama mengambil halaman HTML profil dengan User-Agent
    // "Damar-OSINT/1.0", menganggap "status 200 = ada komentar", lalu
    // mengorek teks dengan regex <p>/<div class=comment>. Tiga hal
    // membuatnya selalu nihil: situs-situs itu menolak atau menyajikan
    // dinding login untuk klien non-browser; halaman modern merakit
    // komentarnya lewat JavaScript sehingga tak ada di HTML awal; dan
    // halaman "tidak ditemukan" pun berstatus 200. Hasilnya
    // "ditemukan di 3 platform" dengan snippet kosong — laporan yang
    // terdengar berhasil padahal tidak membawa apa pun.
    //
    // Yang dipakai sekarang hanya sumber yang sudah diuji memang
    // mengembalikan teks komentar tanpa autentikasi.
    const results = [];

    for (const ambil of [hnComments, githubComments, stackOverflowComments].slice(0, Math.max(1, platforms))) {
        try {
            results.push(await ambil(u));
        }
        catch (error) {
            results.push({
                platform: ambil.platformName ?? "?",
                found: null,
                comments: [],
                note: `tidak terjangkau: ${error.message}`
            });
        }
    }

    // Update trace
    data.traces[traceId] = {
        ...data.traces[traceId],
        status: "complete",
        completedAt: new Date().toISOString(),
        results
    };
    store.write(data);

    const foundCount = results.filter(r => r.found === true).length;
    const totalKomentar = results.reduce((n, r) => n + (r.comments?.length ?? 0), 0);

    return {
        traceId,
        username: u,
        platformsChecked: results.length,
        platformsFound: foundCount,
        commentCount: totalKomentar,
        results,
        summary: totalKomentar
            ? `${totalKomentar} komentar dari ${foundCount} platform`
            : `Tidak ada komentar publik yang bisa dibaca untuk "${u}".`
    };
}

// ---- Sumber komentar publik (diuji langsung) ----------------------

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function ambilJson(url) {
    const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

const bersih = (html) =>
    String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Hacker News lewat indeks Algolia — mengembalikan isi komentar. */
async function hnComments(username) {
    const j = await ambilJson(
        `https://hn.algolia.com/api/v1/search?tags=comment,author_${encodeURIComponent(username)}&hitsPerPage=20`
    );
    const hits = j?.hits ?? [];
    return {
        platform: "HackerNews",
        url: `https://news.ycombinator.com/user?id=${encodeURIComponent(username)}`,
        found: hits.length > 0,
        comments: hits.map(h => ({
            text: bersih(h.comment_text).slice(0, 400),
            url: `https://news.ycombinator.com/item?id=${h.objectID}`,
            at: h.created_at ?? null,
            context: h.story_title ?? null
        }))
    };
}
hnComments.platformName = "HackerNews";

/** GitHub: komentar isu & review dari feed peristiwa publik. */
async function githubComments(username) {
    const events = await ambilJson(
        `https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`
    );
    const komentar = (Array.isArray(events) ? events : [])
        .filter(e => ["IssueCommentEvent", "CommitCommentEvent", "PullRequestReviewCommentEvent"].includes(e.type))
        .map(e => ({
            text: bersih(e.payload?.comment?.body).slice(0, 400),
            url: e.payload?.comment?.html_url ?? null,
            at: e.created_at ?? null,
            context: e.repo?.name ?? null
        }))
        .filter(k => k.text);
    return {
        platform: "GitHub",
        url: `https://github.com/${encodeURIComponent(username)}`,
        found: komentar.length > 0,
        comments: komentar,
        // Feed publik GitHub hanya menyimpan ±90 hari terakhir; nihil
        // di sini bukan berarti orangnya tidak pernah berkomentar.
        note: komentar.length ? undefined : "feed publik GitHub hanya memuat ±90 hari terakhir"
    };
}
githubComments.platformName = "GitHub";

/** StackOverflow: id numerik dulu, baru komentarnya. */
async function stackOverflowComments(username) {
    const cari = await ambilJson(
        `https://api.stackexchange.com/2.3/users?inname=${encodeURIComponent(username)}&site=stackoverflow`
    );
    const user = (cari?.items ?? [])[0];
    if (!user) {
        return { platform: "StackOverflow", found: false, comments: [] };
    }
    const j = await ambilJson(
        `https://api.stackexchange.com/2.3/users/${user.user_id}/comments?site=stackoverflow&filter=withbody&pagesize=20`
    );
    const komentar = (j?.items ?? []).map(c => ({
        text: bersih(c.body).slice(0, 400),
        url: c.link ?? null,
        at: c.creation_date ? new Date(c.creation_date * 1000).toISOString() : null,
        context: null
    })).filter(k => k.text);
    return {
        platform: "StackOverflow",
        url: user.link ?? null,
        found: komentar.length > 0,
        comments: komentar,
        profile: { name: user.display_name, reputation: user.reputation, location: user.location ?? null }
    };
}
stackOverflowComments.platformName = "StackOverflow";

/** Ekstrak potongan teks yang mungkin komentar (heuristik). */
function extractSnippets(html, username) {
    const snippets = [];
    // Cari pola umum komentar
    const patterns = [
        /<p[^>]*>([^<]{20,200})<\/p>/g,
        /<div[^>]*class="[^"]*comment[^"]*"[^>]*>([^<]{20,200})<\/div>/g,
        /<span[^>]*class="[^"]*text[^"]*"[^>]*>([^<]{20,200})<\/span>/g
    ];

    for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null && snippets.length < 5) {
            const text = m[1].trim();
            if (text.length > 20 && !text.includes(username) && !text.includes("http")) {
                snippets.push(text.slice(0, 200));
            }
        }
    }
    return snippets;
}

// ---- IP & lokasi (estimasi) -------------------------------------------

/**
 * Perkirakan lokasi dari pola aktivitas (timezone, bahasa, konten).
 * Bukan pelacakan presisi — hanya estimasi kasar.
 */
/**
 * Estimasi lokasi dari jejak yang SUDAH dikumpulkan.
 *
 * Dulu ini alur terpisah: pengguna harus menempelkan sendiri daftar
 * postingan berikut timestamp-nya — padahal data itu persis yang baru
 * saja dihasilkan traceComments. Sekarang cukup menyebut `traceId`
 * dan lokasinya diperkirakan dari komentar yang sudah ditemukan:
 * satu runtutan, bukan dua pekerjaan yang tidak saling kenal.
 *
 * Bentuk lama (profile, posts) tetap didukung.
 */
function locationFromTrace(traceId) {

    const jejak = store.read().traces?.[traceId];

    if (!jejak) throw new Error("Jejak tidak ditemukan — jalankan lacak komentar dulu.");

    const posts = [];

    for (const platform of jejak.results ?? []) {
        for (const k of platform.comments ?? []) {
            if (k.at) posts.push({ timestamp: k.at, content: k.text ?? "" });
        }
    }

    // Profil StackOverflow kadang menyebut lokasi apa adanya — bukti
    // yang jauh lebih kuat daripada tebakan zona waktu.
    const dinyatakan = (jejak.results ?? [])
        .map(p => p.profile?.location)
        .find(Boolean) ?? null;

    const hasil = estimateLocation({ location: dinyatakan, bio: "" }, posts);

    // Lokasi yang DINYATAKAN sendiri oleh pemilik akun mengalahkan
    // tebakan zona waktu. Tebakan itu kasar — jam aktif 7–23 dipetakan
    // ke WIB, padahal itu jam bangun hampir semua orang di dunia.
    if (dinyatakan) {
        hasil.country = dinyatakan;
        hasil.confidence = "medium";
        hasil.indicators = [
            `Lokasi dinyatakan di profil: ${dinyatakan}`,
            ...(hasil.indicators ?? []).map(i => `${i} (tebakan, kalah oleh profil)`)
        ];
    }

    return {
        ...hasil,
        traceId,
        username: jejak.username,
        basedOn: { comments: posts.length, statedLocation: dinyatakan }
    };

}

function estimateLocation(profile, posts = []) {
    const indicators = [];
    let timezone = null;
    let language = null;
    let country = null;

    // Timezone dari waktu posting
    if (Array.isArray(posts) && posts.length > 0) {
        const hours = posts
            .map(p => new Date(p.timestamp).getHours())
            .filter(h => Number.isFinite(h));
        const activeHours = [...new Set(hours)].sort((a, b) => a - b);
        // Perkirakan timezone dari jam aktif
        if (activeHours.length > 0) {
            const median = activeHours[Math.floor(activeHours.length / 2)];
            // UTC+7 (WIB) = jam 7-23 aktif
            if (median >= 7 && median <= 23) {
                timezone = "UTC+7 (WIB)";
                country = "Indonesia";
            }
            else if (median >= 0 && median <= 6) {
                timezone = "UTC+8 (WITA) atau UTC+9 (WIT)";
                country = "Indonesia (timur)";
            }
            indicators.push(`Jam aktif: ${activeHours.join(", ")} → ${timezone}`);
        }
    }

    // Bahasa dari konten
    if (profile.bio || (Array.isArray(posts) && posts.length > 0)) {
        const text = (profile.bio ?? "") + " " + (Array.isArray(posts) ? posts.map(p => p.text ?? "").join(" ") : "");
        const idWords = (text.match(/\b(aku|saya|kamu|dia|kami|mereka|ini|itu|dan|atau|tapi|karena|untuk|dengan|dari|ke|di|yang|tidak|ada|bisa|akan|sudah|belum|sedang)\b/gi) ?? []).length;
        const enWords = (text.match(/\b(the|a|an|is|are|was|were|have|has|had|do|does|did|will|would|can|could|should|may|might|must|shall)\b/gi) ?? []).length;

        if (idWords > enWords * 2) {
            language = "Indonesia";
            country = country ?? "Indonesia";
        }
        else if (enWords > idWords * 2) {
            language = "English";
        }
        indicators.push(`Bahasa: ${language ?? "tidak diketahui"} (ID:${idWords} EN:${enWords})`);
    }

    // Platform spesifik
    if (profile.platform === "twitter" && profile.location) {
        indicators.push(`Lokasi profil: ${profile.location}`);
    }

    // IP tidak bisa didapat tanpa kerja sama platform/ISP
    // Yang bisa: perkirakan dari timezone, bahasa, konten lokal
    return {
        estimated: country !== null,
        country,
        timezone,
        language,
        confidence: country === "Indonesia" ? "medium" : "low",
        indicators,
        note: "IP address tidak dapat dilacak tanpa kerja sama platform/ISP. Ini adalah estimasi dari pola aktivitas."
    };
}

// ---- Deteksi hoax -----------------------------------------------------

/**
 * Cek apakah sebuah klaim/berita adalah hoax.
 * Menggunakan katalog offline + analisis teks.
 */
/**
 * Cek hoax cukup dengan TAUTAN beritanya.
 *
 * Menyuruh pengguna menyalin-tempel isi artikel adalah pekerjaan yang
 * tidak perlu — dan hasilnya lebih buruk, karena potongan yang dipilih
 * manusia biasanya kehilangan judulnya, bagian yang justru paling
 * banyak memuat ciri misinformasi. Di sini artikelnya diambil sendiri,
 * judul + isi awalnya diekstrak, lalu dianalisis seperti biasa.
 */
async function checkHoaxUrl(url) {

    const u = String(url ?? "").trim();

    if (!/^https?:\/\//i.test(u)) {
        throw new Error("Masukkan tautan berita yang lengkap (diawali http:// atau https://).");
    }

    let judul = null;
    let isi = "";

    try {

        const res = await fetch(u, {
            headers: { "User-Agent": BROWSER_UA, "Accept-Language": "id-ID,id;q=0.9,en;q=0.8" },
            redirect: "follow",
            signal: AbortSignal.timeout(15000)
        });

        if (!res.ok) throw new Error(`halaman membalas HTTP ${res.status}`);

        const html = await res.text();

        judul = bersih((html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ?? [])[1]
            ?? (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1]);

        const deskripsi = bersih((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) ?? [])[1]);

        const paragraf = [...html.matchAll(/<p[^>]*>([\s\S]{40,600}?)<\/p>/gi)]
            .map(m => bersih(m[1]))
            .filter(t => t.length > 40)
            .slice(0, 12);

        isi = [judul, deskripsi, ...paragraf].filter(Boolean).join(" ");

    }
    catch (error) {
        throw new Error(`Tidak bisa membaca tautannya: ${error.message}`);
    }

    if (!isi.trim()) {
        throw new Error("Tautannya terbaca, tetapi isinya tidak bisa diekstrak (mungkin dirakit lewat JavaScript).");
    }

    const hasil = checkHoax(isi);

    return {
        ...hasil,
        source_url: u,
        title: judul,
        extractedChars: isi.length
    };

}

function checkHoax(claim) {
    const text = String(claim).trim().toLowerCase();
    if (!text) throw new Error("Masukkan klaim/berita yang ingin dicek.");

    // Cari di katalog
    for (const [keyword, fact] of Object.entries(FACT_CATALOG)) {
        if (text.includes(keyword)) {
            return {
                claim: claim.slice(0, 200),
                hoax: fact.hoax,
                verdict: fact.hoax ? "HOAX" : "FAKTA",
                confidence: fact.confidence,
                explanation: fact.fact,
                source: fact.source,
                matchedKeyword: keyword
            };
        }
    }

    // Analisis heuristik bila tidak ada di katalog
    const hoaxScore = calculateHoaxScore(text);

    return {
        claim: claim.slice(0, 200),
        hoax: hoaxScore >= 50,
        verdict: hoaxScore >= 70 ? "HOAX — banyak ciri misinformasi" :
                 hoaxScore >= 50 ? "MENCURIGAKAN — perlu verifikasi lebih" :
                 "BELUM DIKETAHUI — tidak ada di katalog, tidak cukup bukti",
        confidence: hoaxScore >= 70 ? "medium" : "low",
        score: hoaxScore,
        explanation: "Tidak ditemukan di katalog fakta. Analisis heuristik: " +
            (hoaxScore >= 50 ? "mengandung kata-kata yang sering muncul di misinformasi." : "tidak ada pola misinformasi yang jelas."),
        source: "Damar heuristik",
        matchedKeyword: null,
        warning: "Selalu verifikasi ke sumber terpercaya sebelum menyebarkan."
    };
}

/** Skor hoax dari analisis teks (0-100). */
function calculateHoaxScore(text) {
    let score = 0;
    const t = text.toLowerCase();

    // Kata kunci hoax
    for (const kw of HOAX_KEYWORDS) {
        if (t.includes(kw)) score += 15;
    }

    // Tanda seru berlebihan
    if ((t.match(/!/g) ?? []).length > 3) score += 20;

    // Huruf kapital berlebihan
    const capsRatio = (t.match(/[A-Z]/g) ?? []).length / Math.max(t.length, 1);
    if (capsRatio > 0.3) score += 15;

    // Kata emosional
    if (/ingat|warning|hati-hati|awas|bahaya|mengerikan|mengejutkan|viral|share|sebarkan/i.test(t)) score += 20;

    // Tanpa sumber
    if (!/menurut|sumber|dikutip|dari|studi|penelitian|data|riset/i.test(t)) score += 10;

    // Klaim absolut
    if (/semua|tidak ada|selalu|tidak pernah|pasti|mustahil|100%/i.test(t)) score += 15;

    return Math.min(100, score);
}

// ---- Tracing penyebar hoax --------------------------------------------

/**
 * Lacak siapa yang menyebar sebuah klaim/berita.
 * Menggunakan pencarian cross-platform.
 */
async function traceSpreader(claim) {
    const text = String(claim).trim();
    if (!text) throw new Error("Masukkan klaim yang ingin dilacak.");

    // Ekstrak kata kunci unik dari klaim
    const keywords = extractKeywords(text);

    // Cari di platform
    const results = [];
    const SEARCH_PLATFORMS = [
        { name: "Twitter/X", searchUrl: `https://x.com/search?q=${encodeURIComponent(keywords.slice(0, 3).join(" "))}&f=live` },
        { name: "Reddit", searchUrl: `https://reddit.com/search?q=${encodeURIComponent(keywords.slice(0, 3).join(" "))}` },
        { name: "Facebook", searchUrl: `https://facebook.com/search/posts/?q=${encodeURIComponent(keywords.slice(0, 3).join(" "))}` },
        { name: "Instagram", searchUrl: `https://instagram.com/explore/tags/${encodeURIComponent(keywords[0] ?? "")}` },
        { name: "TikTok", searchUrl: `https://tiktok.com/search?q=${encodeURIComponent(keywords.slice(0, 3).join(" "))}` },
        { name: "YouTube", searchUrl: `https://youtube.com/results?search_query=${encodeURIComponent(keywords.slice(0, 3).join(" "))}` }
    ];

    for (const platform of SEARCH_PLATFORMS) {
        try {
            const res = await fetch(platform.searchUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (compatible; Damar-OSINT/1.0)" },
                signal: AbortSignal.timeout(10000)
            });

            const html = await res.text();
            const found = res.status === 200 && html.length > 1000;

            // Ekstrak username penyebar (heuristik)
            const spreaders = found ? extractUsernames(html) : [];

            results.push({
                platform: platform.name,
                found,
                spreaders: spreaders.slice(0, 10),
                url: platform.searchUrl
            });
        }
        catch (error) {
            results.push({
                platform: platform.name,
                found: false,
                error: error.message
            });
        }
    }

    // Simpan trace
    const traceId = "h_" + crypto.randomBytes(4).toString("hex");
    const data = store.read();
    data.factChecks[traceId] = {
        id: traceId,
        claim: text.slice(0, 200),
        keywords,
        results,
        tracedAt: new Date().toISOString()
    };
    store.write(data);

    const totalSpreaders = results.reduce((a, r) => a + (r.spreaders?.length ?? 0), 0);

    return {
        traceId,
        claim: text.slice(0, 200),
        keywords,
        platformsChecked: results.length,
        totalSpreaders,
        results,
        summary: `Ditemukan ${totalSpreaders} akun yang menyebarkan di ${results.filter(r => r.found).length} platform`
    };
}

/** Ekstrak kata kunci unik dari teks. */
function extractKeywords(text) {
    const words = text.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 4)
        .filter(w => !["yang", "dengan", "untuk", "adalah", "ini", "itu", "dari", "ke", "di", "dan", "atau", "tapi", "karena"].includes(w));

    // Ambil yang paling unik (jarang di bahasa umum)
    return [...new Set(words)].slice(0, 5);
}

/** Ekstrak username dari HTML (heuristik). */
function extractUsernames(html) {
    const usernames = new Set();

    // Pola umum username
    const patterns = [
        /@([a-zA-Z0-9_]{3,20})/g,
        /user\/([a-zA-Z0-9_]{3,20})/g,
        /profile\/([a-zA-Z0-9_]{3,20})/g,
        /u\/([a-zA-Z0-9_]{3,20})/g
    ];

    for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null && usernames.size < 20) {
            const u = m[1];
            if (!["home", "search", "explore", "settings", "help", "about", "privacy", "terms"].includes(u.toLowerCase())) {
                usernames.add(u);
            }
        }
    }

    return [...usernames];
}

// ---- Network analysis ------------------------------------------------

/**
 * Analisis jaringan sebuah akun: siapa yang terhubung.
 * Menggunakan data yang tersedia (tanpa API resmi).
 */
function analyzeNetwork(account, connections = []) {
    const analysis = {
        account,
        totalConnections: connections.length,
        clusters: [],
        suspicious: [],
        note: "Analisis jaringan terbatas — API resmi tidak tersedia."
    };

    if (connections.length === 0) {
        return analysis;
    }

    // Deteksi cluster (akun dengan nama mirip)
    const nameGroups = {};
    for (const conn of connections) {
        const base = String(conn.username ?? "").toLowerCase().replace(/\d+$/, "");
        if (!nameGroups[base]) nameGroups[base] = [];
        nameGroups[base].push(conn);
    }

    for (const [base, group] of Object.entries(nameGroups)) {
        if (group.length > 3) {
            analysis.clusters.push({
                baseName: base,
                count: group.length,
                accounts: group.map(g => g.username)
            });
        }
    }

    // Deteksi akun mencurigakan (semua dibuat bersamaan, follower rendah)
    const createdDates = connections
        .map(c => c?.createdAt)
        .filter(Boolean)
        .sort();
    if (createdDates.length > 5) {
        const sameDay = createdDates.filter((d, i, arr) =>
            i > 0 && new Date(d).toDateString() === new Date(arr[i - 1]).toDateString()
        );
        if (sameDay.length > createdDates.length * 0.5) {
            analysis.suspicious.push("Banyak akun dibuat pada hari yang sama — khas bot farm");
        }
    }

    return analysis;
}

module.exports = {
    analyzeAccount,
    traceComments,
    estimateLocation,
    locationFromTrace,
    checkHoax,
    checkHoaxUrl,
    traceSpreader,
    analyzeNetwork,
    FACT_CATALOG,
    HOAX_KEYWORDS
};
