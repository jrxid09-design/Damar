const { AITool } = require("../ai/tools");

const osint = require("./osintService");
const breach = require("./breachService");
const phoneIntel = require("./phoneIntelService");
const personTracking = require("./personTrackingService");
const socialIntel = require("./socialIntelService");

/**
 * Tool AI untuk Damar OSINT — detektif & investigator digital.
 *
 * Damar bisa menganalisis email, username, telepon, domain,
 * mengecek kebocoran data gratis, menilai risiko penipuan telepon,
 * dan melacak lokasi orang yang opt-in.
 *
 * Semua sumber GRATIS. Batasan etika ditegakkan di deskripsi.
 */
function osintTools() {

    return [

        // ---- Investigasi utama -------------------------------------

        new AITool({
            name: "osint_investigate",
            description:
                "Jalankan investigasi OSINT lengkap terhadap target (orang/email/username/domain/telepon). " +
                "Mengumpulkan dari sumber terbuka: kebocoran data gratis, ketersediaan username di 20+ platform, " +
                "analisis email (disposable/corporate), analisis telepon (carrier/risiko scam), dan analisis domain. " +
                "Hasil dikorelasikan otomatis dengan skor risiko. " +
                "Hanya untuk investigasi yang sah: keamanan, verifikasi, pemulihan akun, atau kasus hukum. " +
                "Tidak untuk doxing, stalking, atau pelanggaran privasi.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Nama target (opsional)." },
                    email: { type: "string", description: "Email target (opsional)." },
                    username: { type: "string", description: "Username target (opsional)." },
                    phone: { type: "string", description: "Nomor telepon target (opsional)." },
                    domain: { type: "string", description: "Domain target (opsional)." },
                    case_id: { type: "string", description: "ID kasus untuk menyimpan temuan (opsional)." }
                }
            },
            execute: async ({ name, email, username, phone, domain, case_id }) => {

                const target = {};
                if (name) target.name = name;
                if (email) target.email = email;
                if (username) target.username = username;
                if (phone) target.phone = phone;
                if (domain) target.domain = domain;

                if (Object.keys(target).length === 0) {
                    return { ok: false, error: "Sebutkan minimal satu target: email, username, phone, atau domain." };
                }

                const report = await osint.investigate(target, { caseId: case_id });

                return {
                    ok: true,
                    risk: report.riskLevel,
                    score: report.riskScore,
                    summary: report.summary,
                    sections: Object.keys(report.sections),
                    correlations: report.correlations,
                    findings: report.findings.length
                };

            }
        }),

        // ---- Analisis spesifik -------------------------------------

        new AITool({
            name: "osint_email",
            description:
                "Analisis sebuah alamat email: apakah valid, disposable, korporat, atau gratis. " +
                "Cek juga di kebocoran data gratis (LeakCheck + ProxyNova). " +
                "Pakai untuk verifikasi email mencurigakan atau pemulihan akun.",
            parameters: {
                type: "object",
                properties: {
                    email: { type: "string", description: "Alamat email yang dianalisis." }
                },
                required: ["email"]
            },
            execute: async ({ email }) => {

                const info = osint.analyzeEmail(email);

                if (!info.valid) {
                    return { ok: false, error: info.error };
                }

                // Cek kebocoran gratis
                let exposure = null;
                try {
                    exposure = await breach.check(email);
                }
                catch { /* breach check gagal — lanjut tanpa */ }

                return {
                    ok: true,
                    email: info.masked,
                    valid: true,
                    disposable: info.isDisposable,
                    free: info.isFree,
                    corporate: info.isCorporate,
                    domain: info.domain,
                    exposure: exposure ? {
                        breached: exposure.breached,
                        count: exposure.sources?.length ?? 0,
                        sources: exposure.sources?.map(s => s.name) ?? [],
                        fields: exposure.fields ?? []
                    } : null
                };

            }
        }),

        new AITool({
            name: "osint_username",
            description:
                "Cek ketersediaan sebuah username di 20+ platform (GitHub, Twitter, Instagram, Reddit, dll). " +
                "Pakai untuk menemukan jejak digital seseorang atau verifikasi keaslian akun.",
            parameters: {
                type: "object",
                properties: {
                    username: { type: "string", description: "Username yang dicari (tanpa @)." },
                    limit: { type: "number", description: "Maksimum platform yang dicek (default 15)." }
                },
                required: ["username"]
            },
            execute: async ({ username, limit }) => {

                const results = await osint.searchUsername(username, { maxPlatforms: limit ?? 15 });
                const found = results.filter(r => r.found === true);
                const maybe = results.filter(r => r.found === "maybe");

                return {
                    ok: true,
                    username,
                    checked: results.length,
                    found: found.length,
                    maybe: maybe.length,
                    platforms: found.map(f => ({ name: f.platform, url: f.url })),
                    maybes: maybe.map(m => ({ name: m.platform, url: m.url, note: m.note }))
                };

            }
        }),

        // ---- Kebocoran data (gratis) --------------------------------

        new AITool({
            name: "osint_breach",
            description:
                "Cek apakah email/username bocor di kebocoran data publik — GRATIS, tanpa API key. " +
                "Menunjukkan DI MANA bocor (nama layanan, tahun, kategori) dan APA SAJA yang terekspos " +
                "(email, password, telepon, alamat, GPS, pembayaran). " +
                "Pakai HANYA untuk akun sendiri atau keluarga berizin — ini alat keamanan diri.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Email atau username yang dicek." }
                },
                required: ["query"]
            },
            execute: async ({ query }) => {

                const result = await breach.check(query);

                return {
                    ok: true,
                    query: result.query,
                    breached: result.breached,
                    summary: breach.summarize(result),
                    sources: result.sources.map(s => ({
                        name: s.name,
                        year: s.year,
                        category: s.category,
                        accounts: s.accounts,
                        data: s.dataClasses
                    })),
                    fields: result.fields,
                    combos: result.combos,
                    advice: result.advice
                };

            }
        }),

        // ---- Telepon intelijen ---------------------------------------

        new AITool({
            name: "osint_phone",
            description:
                "Analisis nomor telepon: kode negara, carrier (Indonesia), jenis line (mobile/landline/VoIP), " +
                "dan skor risiko penipuan. Deteksi pola scam umum (missed call, prefix internasional mencurigakan). " +
                "Pakai untuk mitigasi penipuan telepon yang meresahkan.",
            parameters: {
                type: "object",
                properties: {
                    phone: { type: "string", description: "Nomor telepon (dengan atau tanpa kode negara)." }
                },
                required: ["phone"]
            },
            execute: async ({ phone }) => {

                const info = phoneIntel.analyze(phone);

                return {
                    ok: true,
                    phone: info.masked,
                    country: info.country,
                    carrier: info.carrier,
                    lineType: info.lineType,
                    scamScore: info.scamScore,
                    riskLevel: info.riskLevel,
                    notes: info.scamNotes
                };

            }
        }),

        new AITool({
            name: "osint_phone_assess",
            description:
                "Penilaian panggilan masuk secara real-time. Dipakai saat ponsel berdering " +
                "(lewat integrasi Tasker/FTS) untuk menilai risiko sebelum diangkat. " +
                "Menggabungkan analisis nomor + durasi + apakah diangkat.",
            parameters: {
                type: "object",
                properties: {
                    phone: { type: "string", description: "Nomor penelepon." },
                    duration: { type: "number", description: "Durasi panggilan detik (0 bila missed call)." },
                    answered: { type: "boolean", description: "Apakah panggilan diangkat." }
                },
                required: ["phone"]
            },
            execute: async ({ phone, duration, answered }) => {

                const a = phoneIntel.assessCall(phone, { duration, answered });

                return {
                    ok: true,
                    phone: a.masked,
                    verdict: a.verdict,
                    liveScore: a.liveScore,
                    recommendation: a.recommendation,
                    callCount: a.callCount,
                    notes: a.liveNotes
                };

            }
        }),

        new AITool({
            name: "osint_phone_blacklist",
            description:
                "Tambahkan nomor ke blacklist pribadi. Nomor di blacklist otomatis dapat skor risiko 100.",
            parameters: {
                type: "object",
                properties: {
                    phone: { type: "string", description: "Nomor yang diblacklist." }
                },
                required: ["phone"]
            },
            execute: async ({ phone }) => {
                const r = phoneIntel.blacklistAdd(phone);
                return { ok: true, blacklisted: r.blacklisted };
            }
        }),

        // ---- Pelacakan orang -----------------------------------------

        new AITool({
            name: "osint_track_register",
            description:
                "Daftarkan orang untuk dilacak lokasinya (opt-in). Menghasilkan link/token unik " +
                "yang dipasang di perangkat orang tersebut. Token bisa dicabut kapan saja. " +
                "Bukan pelacakan ilegal — hanya untuk yang menyetujui.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Nama orang." },
                    label: { type: "string", description: "Label (mis. 'Istri', 'Anak', 'Karyawan')." },
                    group: { type: "string", description: "Grup (mis. 'Keluarga', 'Tim')." }
                },
                required: ["name"]
            },
            execute: async ({ name, label, group }) => {

                const r = personTracking.register({ name, label, group });

                return {
                    ok: true,
                    person_id: r.id,
                    name: r.name,
                    share_url: r.shareUrl,
                    token: r.token,
                    note: "Bagikan link/token ini ke perangkat orang tersebut. Token hanya muncul SEKALI."
                };

            }
        }),

        new AITool({
            name: "osint_track_list",
            description:
                "Lihat daftar orang yang sedang dilacak (yang opt-in). " +
                "Menampilkan lokasi terkini, baterai, dan waktu update terakhir.",
            parameters: {
                type: "object",
                properties: {
                    group: { type: "string", description: "Saring per grup (opsional)." }
                }
            },
            execute: async ({ group }) => {

                const r = personTracking.list({ group });

                return {
                    ok: true,
                    count: r.persons.length,
                    persons: r.persons.map(p => ({
                        id: p.id,
                        name: p.name,
                        label: p.label,
                        group: p.group,
                        sharing: p.sharing,
                        location: p.location,
                        updated: p.updatedAt
                    }))
                };

            }
        }),

        new AITool({
            name: "osint_track_detail",
            description:
                "Lihat detail satu orang yang dilacak: lokasi terkini + riwayat 20 titik terakhir.",
            parameters: {
                type: "object",
                properties: {
                    person_id: { type: "string", description: "ID orang." }
                },
                required: ["person_id"]
            },
            execute: async ({ person_id }) => {

                const p = personTracking.get(person_id);

                return {
                    ok: true,
                    person: {
                        id: p.id,
                        name: p.name,
                        label: p.label,
                        group: p.group,
                        location: p.location,
                        updated: p.updatedAt,
                        history: p.history
                    }
                };

            }
        }),

        new AITool({
            name: "osint_track_nearby",
            description:
                "Cek siapa yang berdekatan satu sama lain (radius 1 km). " +
                "Pakai untuk mengetahui apakah dua orang sedang bersama.",
            parameters: {
                type: "object",
                properties: {
                    radius: { type: "number", description: "Radius meter (default 1000)." }
                }
            },
            execute: async ({ radius }) => {

                const r = personTracking.nearby({ radiusM: radius ?? 1000 });

                return {
                    ok: true,
                    radius: r.radiusM,
                    pairs: r.pairs.map(p => ({
                        a: p.a.name,
                        b: p.b.name,
                        distance: `${p.distanceM} m`
                    }))
                };

            }
        }),

        // ---- Domain & kasus (tetap) ----------------------------------

        new AITool({
            name: "osint_domain",
            description:
                "Analisis sebuah domain: DNS (A/MX/TXT records), HTTP headers, server, redirect. " +
                "Pakai untuk verifikasi website mencurigakan atau penelitian infrastruktur.",
            parameters: {
                type: "object",
                properties: {
                    domain: { type: "string", description: "Domain yang dianalisis (mis. example.com)." }
                },
                required: ["domain"]
            },
            execute: async ({ domain }) => {
                const info = await osint.analyzeDomain(domain);
                return {
                    ok: true,
                    domain: info.domain,
                    dns: info.dns,
                    mx: info.mx,
                    txt: info.txt?.slice(0, 5),
                    http: info.http
                };
            }
        }),

        new AITool({
            name: "osint_case_create",
            description:
                "Buat kasus investigasi baru. Setiap kasus punya target, temuan, bukti, dan timeline. " +
                "Pakai untuk mengorganisir investigasi yang kompleks.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Judul kasus." },
                    description: { type: "string", description: "Deskripsi singkat." },
                    target_name: { type: "string", description: "Nama target (opsional)." },
                    target_email: { type: "string", description: "Email target (opsional)." },
                    target_username: { type: "string", description: "Username target (opsional)." },
                    target_phone: { type: "string", description: "Telepon target (opsional)." },
                    target_domain: { type: "string", description: "Domain target (opsional)." },
                    tags: { type: "string", description: "Tag dipisah koma (mis. 'phishing,verifikasi')." }
                },
                required: ["title"]
            },
            execute: async ({ title, description, target_name, target_email, target_username, target_phone, target_domain, tags }) => {

                const target = {};
                if (target_name) target.name = target_name;
                if (target_email) target.email = target_email;
                if (target_username) target.username = target_username;
                if (target_phone) target.phone = target_phone;
                if (target_domain) target.domain = target_domain;

                const c = osint.createCase({
                    title,
                    description,
                    target,
                    tags: tags ? tags.split(",").map(s => s.trim()).filter(Boolean) : []
                });

                return {
                    ok: true,
                    case_id: c.id,
                    title: c.title,
                    status: c.status,
                    created: c.createdAt
                };

            }
        }),

        new AITool({
            name: "osint_case_list",
            description:
                "Lihat daftar kasus investigasi. Bisa disaring per status (open/closed) atau tag.",
            parameters: {
                type: "object",
                properties: {
                    status: { type: "string", description: "Saring per status: open/closed (opsional)." },
                    tag: { type: "string", description: "Saring per tag (opsional)." }
                }
            },
            execute: async ({ status, tag }) => {

                const cases = osint.listCases({ status, tag });

                return {
                    ok: true,
                    count: cases.length,
                    cases: cases.map(c => ({
                        id: c.id,
                        title: c.title,
                        status: c.status,
                        target: c.target,
                        tags: c.tags,
                        findings: c.findings.length,
                        updated: c.updatedAt
                    }))
                };

            }
        }),

        new AITool({
            name: "osint_case_detail",
            description:
                "Lihat detail lengkap sebuah kasus: temuan, bukti, timeline, dan kesimpulan.",
            parameters: {
                type: "object",
                properties: {
                    case_id: { type: "string", description: "ID kasus." }
                },
                required: ["case_id"]
            },
            execute: async ({ case_id }) => {

                const c = osint.getCase(case_id);

                if (!c) {
                    return { ok: false, error: "Kasus tidak ditemukan." };
                }

                return {
                    ok: true,
                    case: {
                        id: c.id,
                        title: c.title,
                        description: c.description,
                        status: c.status,
                        target: c.target,
                        tags: c.tags,
                        findings: c.findings,
                        evidence: c.evidence,
                        timeline: c.timeline,
                        conclusion: c.conclusion,
                        verdict: c.verdict,
                        created: c.createdAt,
                        updated: c.updatedAt,
                        closed: c.closedAt
                    }
                };

            }
        }),

        new AITool({
            name: "osint_case_add_finding",
            description:
                "Tambahkan temuan ke kasus. Temuan bisa berupa hasil analisis, bukti, atau catatan investigasi.",
            parameters: {
                type: "object",
                properties: {
                    case_id: { type: "string", description: "ID kasus." },
                    type: { type: "string", description: "Jenis temuan (exposure/username/email/phone/domain/lainnya)." },
                    source: { type: "string", description: "Sumber temuan (LeakCheck/GitHub/dll)." },
                    data: { type: "string", description: "Data temuan (JSON atau teks)." },
                    confidence: { type: "string", description: "Tingkat keyakinan: low/medium/high/critical." },
                    notes: { type: "string", description: "Catatan tambahan (opsional)." }
                },
                required: ["case_id", "type", "source", "data"]
            },
            execute: async ({ case_id, type, source, data, confidence, notes }) => {

                let parsed;
                try { parsed = JSON.parse(data); }
                catch { parsed = data; }

                const f = osint.addFinding(case_id, {
                    type,
                    source,
                    data: parsed,
                    confidence: confidence ?? "medium",
                    notes
                });

                return { ok: true, finding_id: f.id, added: f.at };

            }
        }),

        new AITool({
            name: "osint_case_close",
            description:
                "Tutup sebuah kasus investigasi dengan kesimpulan dan verdict.",
            parameters: {
                type: "object",
                properties: {
                    case_id: { type: "string", description: "ID kasus." },
                    conclusion: { type: "string", description: "Kesimpulan investigasi." },
                    verdict: { type: "string", description: "Verdict: confirmed/inconclusive/false-positive." }
                },
                required: ["case_id", "conclusion", "verdict"]
            },
            execute: async ({ case_id, conclusion, verdict }) => {

                const c = osint.closeCase(case_id, { conclusion, verdict });

                return {
                    ok: true,
                    case_id: c.id,
                    status: c.status,
                    verdict: c.verdict,
                    closed: c.closedAt
                };

            }
        }),

        // ---- Social Intelligence -----------------------------------

        new AITool({
            name: "osint_social_bot",
            description:
                "Analisis apakah akun sosial media asli atau bot. " +
                "Menggunakan heuristik: rasio follower/following, usia akun, aktivitas posting, " +
                "pola username, foto profil, bio, verifikasi. Skor 0-100. " +
                "Pakai untuk verifikasi akun mencurigakan sebelum berinteraksi.",
            parameters: {
                type: "object",
                properties: {
                    username: { type: "string", description: "Username akun (tanpa @)." },
                    platform: { type: "string", description: "Platform (twitter/instagram/reddit/dll)." },
                    followers: { type: "number", description: "Jumlah follower (opsional)." },
                    following: { type: "number", description: "Jumlah following (opsional)." },
                    posts: { type: "number", description: "Jumlah posting (opsional)." },
                    created_at: { type: "string", description: "Tanggal dibuat (ISO, opsional)." },
                    bio: { type: "string", description: "Bio akun (opsional)." },
                    verified: { type: "boolean", description: "Apakah terverifikasi (opsional)." },
                    has_avatar: { type: "boolean", description: "Apakah punya foto profil (opsional)." }
                },
                required: ["username"]
            },
            execute: async ({ username, platform, followers, following, posts, created_at, bio, verified, has_avatar }) => {

                const profile = {
                    username,
                    platform,
                    followers,
                    following,
                    posts,
                    createdAt: created_at,
                    bio,
                    verified,
                    hasDefaultAvatar: has_avatar === false
                };

                const result = socialIntel.analyzeAccount(profile);

                return {
                    ok: true,
                    username,
                    platform: platform ?? "unknown",
                    bot_score: result.botScore,
                    verdict: result.verdict,
                    is_bot: result.isBot,
                    confidence: result.confidence,
                    notes: result.notes,
                    metrics: result.metrics
                };

            }
        }),

        new AITool({
            name: "osint_social_comments",
            description:
                "Lacak komentar sebuah akun di berbagai platform (Reddit, YouTube, HackerNews, StackOverflow, GitHub, Medium, dll). " +
                "Menunjukkan di mana akun aktif dan potongan komentarnya. " +
                "Pakai untuk memetakan aktivitas digital seseorang.",
            parameters: {
                type: "object",
                properties: {
                    username: { type: "string", description: "Username yang dilacak." },
                    platforms: { type: "number", description: "Maksimum platform dicek (default 15)." }
                },
                required: ["username"]
            },
            execute: async ({ username, platforms }) => {

                const result = await socialIntel.traceComments(username, { platforms: platforms ?? 15 });

                return {
                    ok: true,
                    trace_id: result.traceId,
                    username: result.username,
                    checked: result.platformsChecked,
                    found: result.platformsFound,
                    summary: result.summary,
                    platforms: result.results.map(r => ({
                        name: r.platform,
                        found: r.found,
                        url: r.url,
                        snippets: r.snippets?.slice(0, 3) ?? []
                    }))
                };

            }
        }),

        new AITool({
            name: "osint_social_location",
            description:
                "Perkirakan lokasi sebuah akun dari pola aktivitas (timezone, bahasa, konten lokal). " +
                "Bukan pelacakan presisi — hanya estimasi kasar dari data publik. " +
                "IP address tidak bisa dilacak tanpa kerja sama platform/ISP.",
            parameters: {
                type: "object",
                properties: {
                    username: { type: "string", description: "Username akun." },
                    platform: { type: "string", description: "Platform (opsional)." },
                    bio: { type: "string", description: "Bio akun (opsional)." },
                    location: { type: "string", description: "Lokasi di profil (opsional)." },
                    posts: { type: "string", description: "JSON array posting dengan timestamp dan text (opsional)." }
                },
                required: ["username"]
            },
            execute: async ({ username, platform, bio, location, posts }) => {

                let postList = [];
                try { postList = posts ? JSON.parse(posts) : []; }
                catch { /* abaikan */ }

                const profile = { username, platform, bio, location };
                const result = socialIntel.estimateLocation(profile, postList);

                return {
                    ok: true,
                    username,
                    estimated: result.estimated,
                    country: result.country,
                    timezone: result.timezone,
                    language: result.language,
                    confidence: result.confidence,
                    indicators: result.indicators,
                    note: result.note
                };

            }
        }),

        new AITool({
            name: "osint_hoax_check",
            description:
                "Cek apakah sebuah klaim/berita adalah hoax atau fakta. " +
                "Menggunakan katalog fakta offline + analisis teks heuristik. " +
                "Pakai untuk melawan misinformasi — verifikasi sebelum menyebarkan.",
            parameters: {
                type: "object",
                properties: {
                    claim: { type: "string", description: "Klaim/berita yang dicek." }
                },
                required: ["claim"]
            },
            execute: async ({ claim }) => {

                const result = socialIntel.checkHoax(claim);

                return {
                    ok: true,
                    claim: result.claim,
                    hoax: result.hoax,
                    verdict: result.verdict,
                    confidence: result.confidence,
                    explanation: result.explanation,
                    source: result.source,
                    warning: result.warning
                };

            }
        }),

        new AITool({
            name: "osint_hoax_trace",
            description:
                "Lacak siapa yang menyebar sebuah klaim/berita di berbagai platform. " +
                "Menemukan akun-akun yang menyebarkan konten yang sama. " +
                "Pakai untuk investigasi penyebaran misinformasi.",
            parameters: {
                type: "object",
                properties: {
                    claim: { type: "string", description: "Klaim/berita yang dilacak." }
                },
                required: ["claim"]
            },
            execute: async ({ claim }) => {

                const result = await socialIntel.traceSpreader(claim);

                return {
                    ok: true,
                    trace_id: result.traceId,
                    claim: result.claim,
                    keywords: result.keywords,
                    platforms_checked: result.platformsChecked,
                    total_spreaders: result.totalSpreaders,
                    summary: result.summary,
                    platforms: result.results.map(r => ({
                        name: r.platform,
                        found: r.found,
                        spreaders: r.spreaders ?? []
                    }))
                };

            }
        }),

        new AITool({
            name: "osint_social_network",
            description:
                "Analisis jaringan sebuah akun: cluster akun terhubung, deteksi bot farm. " +
                "Menemukan pola akun-akun yang dibuat bersamaan atau saling terkait.",
            parameters: {
                type: "object",
                properties: {
                    username: { type: "string", description: "Username akun utama." },
                    connections: { type: "string", description: "JSON array akun terhubung (username, created_at)." }
                },
                required: ["username"]
            },
            execute: async ({ username, connections }) => {

                let connList = [];
                try { connList = connections ? JSON.parse(connections) : []; }
                catch { /* abaikan */ }

                const result = socialIntel.analyzeNetwork(username, connList);

                return {
                    ok: true,
                    account: result.account,
                    total_connections: result.totalConnections,
                    clusters: result.clusters,
                    suspicious: result.suspicious,
                    note: result.note
                };

            }
        })

    ];

}

module.exports = { osintTools };
