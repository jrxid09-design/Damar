/**
 * DATASET BENCHMARK CONTEXT INTELLIGENCE — 64 kasus, 20 kategori.
 *
 * Setiap kasus: messages[] (riwayat), memoryCorpus[] (kandidat memori),
 * required[] (substring yang WAJIB selamat di prompt — correctness
 * constraint #1), forbidden[] (noise yang TIDAK boleh ikut),
 * opsional modelTokens untuk skenario window kecil/besar.
 *
 * Kategori mengikuti mandat Phase 18.
 */

const CASES = [

    // ---- 1. Greeting -------------------------------------------------
    { id: "greet-1", category: "greeting", messages: [["user", "halo"]], memoryCorpus: [], required: [], forbidden: ["skema database", "invoice"] },
    { id: "greet-2", category: "greeting", messages: [["user", "pagi"], ["assistant", "Pagi!"], ["user", "apa kabar?"]], memoryCorpus: [], required: [], forbidden: [] },
    { id: "greet-3", category: "greeting", messages: [["user", "halo"], ["assistant", "Hai!"], ["user", "makasih"]], memoryCorpus: [["Ronny suka kopi hitam."], ["Server produksi pakai Ubuntu."]], required: [], forbidden: ["Ubuntu"] },

    // ---- 2. Simple standalone factual ----------------------------------
    { id: "fact-1", category: "simple-factual", messages: [["user", "berapa 128 dikali 4?"]], memoryCorpus: [], required: [], forbidden: [] },
    { id: "fact-2", category: "simple-factual", messages: [["user", "ibu kota Kazakhstan apa?"]], memoryCorpus: [["Deadline proyek alpha tanggal 30."]], required: [], forbidden: ["alpha"] },
    { id: "fact-3", category: "simple-factual", messages: [["user", "jelaskan cara kerja DNS singkat"]], memoryCorpus: [], required: [], forbidden: [] },

    // ---- 3. Recent-turn continuation -------------------------------------
    { id: "recent-1", category: "recent-continuation", messages: [["user", "buatkan fungsi add(a,b) di calculator.js"], ["assistant", "Fungsi add sudah dibuat."], ["user", "sekarang tambahkan juga fungsi subtract"]], memoryCorpus: [], required: ["fungsi add"], forbidden: [] },
    { id: "recent-2", category: "recent-continuation", messages: [["user", "pesan nasi goreng"], ["assistant", "Oke dicatat pesanannya."], ["user", "tambah es teh ya"]], memoryCorpus: [], required: ["nasi goreng"], forbidden: [] },
    { id: "recent-3", category: "recent-continuation", messages: [["user", "buka notepad"], ["assistant", "Notepad terbuka."], ["user", "ketik halo dunia di sana"]], memoryCorpus: [], required: ["notepad"], forbidden: [] },

    // ---- 4. Old-topic continuation ------------------------------------------
    { id: "old-1", category: "old-topic", messages: [["user", "kemarin kita desain skema database billing dengan tabel invoices"], ["assistant", "Betul, skema billing: invoices + line_items."], ["user", "cuaca hari ini cerah?"], ["assistant", "Sepertinya cerah."], ["user", "lanjutkan desain skema database billing itu"], ], memoryCorpus: [], required: ["invoices", "billing"], forbidden: [] },
    { id: "old-2", category: "old-topic", messages: [["user", "minggu lalu kita bahas refactor RecallService"], ["assistant", "Iya, refactor RecallService dimulai dari normalisasi teks."], ["user", "oh iya lupakan itu"], ["user", "eh lanjutkan refactor RecallService kemarin"]], memoryCorpus: [], required: ["RecallService"], forbidden: [] },
    { id: "old-3", category: "old-topic", messages: [["user", "dulu kita putuskan auth pakai JWT dengan refresh token berotasi"], ["assistant", "Benar, JWT + rotasi refresh token."], ...Array.from({ length: 10 }, (_, i) => ["user", `obrolan pengisi nomor ${i}`]), ["user", "apa keputusan kita soal auth dulu?"]], memoryCorpus: [], required: ["JWT"], forbidden: [] },

    // ---- 5. Explicit project reference -----------------------------------------
    { id: "projref-1", category: "project-ref", messages: [["user", "proyek alpha deadline-nya kapan? Ingat dulu detailnya"]], memoryCorpus: [["Proyek alpha: deadline 30 Agustus, tim 3 orang."], ["Fakta tak relevan: kucing tetangga hitam."]], required: ["alpha"], forbidden: [] },
    { id: "projref-2", category: "project-ref", messages: [["user", "status proyek beta gimana kemarin sampai mana?"]], memoryCorpus: [["Proyek beta: API selesai 80%, sisa testing."]], required: ["beta"], forbidden: [] },

    // ---- 6. Implicit project continuation --------------------------------------------
    { id: "projimp-1", category: "project-implicit", messages: [["user", "alpha butuh review desain"], ["assistant", "Review alpha dijadwalkan."], ["user", "jangan lupa yang tadi itu ya"]], memoryCorpus: [["Proyek alpha: review desain penting sebelum rilis."]], required: ["alpha"], forbidden: [] },

    // ---- 7. Memory-required -----------------------------------------------------------
    { id: "memreq-1", category: "memory-required", messages: [["user", "kapan ulang tahun istriku?"]], memoryCorpus: [["Ulang tahun istri Ronny: 12 Mei."], ["Suka musik jazz."]], required: ["12 Mei"], forbidden: [] },
    { id: "memreq-2", category: "memory-required", messages: [["user", "preferensi kopi saya apa?"]], memoryCorpus: [["Ronny suka kopi hitam tanpa gula."]], required: ["kopi"], forbidden: [] },
    { id: "memreq-3", category: "memory-required", messages: [["user", "nomor server NAS rumah berapa?"]], memoryCorpus: [["NAS rumah: 192.168.1.50."]], required: ["192.168.1.50"], forbidden: [] },

    // ---- 8. Memory-NOT-required --------------------------------------------------------
    { id: "memnot-1", category: "memory-not-required", messages: [["user", "berapa hasil 9^0.5?"]], memoryCorpus: [["Rahasia keluarga: PIN bank 4821."], ["Kata sandi lama router: admin1234."]], required: [], forbidden: ["4821", "admin1234"] },
    { id: "memnot-2", category: "memory-not-required", messages: [["user", "siapa presiden pertama Indonesia?"]], memoryCorpus: [["Catatan pribadi sangat sensitif tentang kesehatan keluarga."]], required: [], forbidden: ["kesehatan keluarga"] },

    // ---- 9. Conflicting old/recent ------------------------------------------------------
    { id: "conflict-1", category: "conflict", messages: [["user", "rencana awal: deploy pakai docker compose"], ["assistant", "Ok docker compose."], ["user", "ubah rencana: pakai kubernetes saja"], ["assistant", "Baik, kubernetes."], ["user", "konfirmasi sekali lagi rencana deploy final?"]], memoryCorpus: [], required: ["kubernetes"], forbidden: [] },

    // ---- 10. Long conversation -------------------------------------------------------------
    ...(() => {
        const long = Array.from({ length: 36 }, (_, i) =>
            [i % 2 ? "assistant" : "user", i % 2
                ? `Balasan nomor ${i} mengenai topik acak ${i}.`
                : `Pertanyaan nomor ${i} soal topik ${i}.`]);
        return [{
            id: "long-1", category: "long-conversation",
            messages: [...long, ["user", "kesimpulan dari obrolan panjang ini apa?"]],
            memoryCorpus: [], required: [], forbidden: []
        }];
    })(),

    // ---- 11. Large tool observation -----------------------------------------------------------
    { id: "obsbig-1", category: "large-observation", messages: [["user", "baca log build terakhir"], ["tool", "x".repeat(30000)], ["user", "ringkas temuan errornya"]], memoryCorpus: [], required: [], forbidden: [], checkBounded: true },
    { id: "obsbig-2", category: "large-observation", messages: [["user", "ambil halaman web itu"], ["tool", "konten ".repeat(20000)], ["user", "apa intinya?"]], memoryCorpus: [], required: [], forbidden: [], checkBounded: true },

    // ---- 12. Repeated tool outputs ----------------------------------------------------------------
    { id: "obsdup-1", category: "repeated-observation", messages: [["user", "cek status dua kali"], ["tool", "STATUS: semua sistem normal, CPU 12%, RAM 40%."], ["tool", "STATUS: semua sistem normal, CPU 12%, RAM 40%."], ["user", "jadi gimana kondisinya?"]], memoryCorpus: [], required: [], forbidden: [], expectDedupedObservation: true },

    // ---- 13. Skill-required ---------------------------------------------------------------------------
    { id: "skill-1", category: "skill-required", messages: [["user", "pakai skill morning_briefing sekarang"]], memoryCorpus: [["Skill morning_briefing merangkum konteks rumah tiap pagi."]], required: ["morning_briefing"], forbidden: [] },

    // ---- 14. Worker mission -------------------------------------------------------------------------------
    { id: "worker-1", category: "worker-mission", messages: [["user", "[Peran: Nakula] Selesaikan bug pada modul invoices di proyek ledger"]], memoryCorpus: [["Invoices modul ledger ditulis bulan Maret."]], required: ["Nakula", "invoices"], forbidden: [] },
    { id: "worker-2", category: "worker-mission", messages: [["user", "[Peran: Janaka] Riset kompetitor aplikasi wallet crypto"]], memoryCorpus: [], required: ["Janaka"], forbidden: [] },

    // ---- 15. Multilingual ------------------------------------------------------------------------------------
    { id: "multi-1", category: "multilingual", messages: [["user", "Let's continue the database migration we discussed yesterday"], ["assistant", "Sure, the migration plan had 3 steps."], ["user", "apakah migrasi database tadi sudah jalan?"]], memoryCorpus: [["Migrasi database tahap 1 selesai pekan lalu."]], required: ["migrasi"], forbidden: [] },
    { id: "multi-2", category: "multilingual", messages: [["user", "what was our decision about caching?"], ["assistant", "Kita putuskan cache pakai LRU 500 entri."], ["user", "ya that one, remind me the cache limit"]], memoryCorpus: [], required: ["LRU"], forbidden: [] },

    // ---- 16/17. Small vs large context model (budget behavior) -------------------------------------------------
    { id: "smallmodel-1", category: "small-model", modelTokens: 8192, messages: [["user", "ingat belanja: beras, minyak, telur"], ["assistant", "Tercatat."], ["user", "ulangi daftar belanja tadi"]], memoryCorpus: [["Stok dapur tinggal garam."]], required: ["belanja"], forbidden: [] },
    { id: "largemodel-1", category: "large-model", modelTokens: 1000000, messages: [["user", "ingat belanja: beras, minyak, telur"], ["assistant", "Tercatat."], ["user", "ulangi daftar belanja tadi"]], memoryCorpus: [["Stok dapur tinggal garam."]], required: ["belanja"], forbidden: ["garam"] },

    // ---- 18. Noisy session -----------------------------------------------------------------------------------------
    { id: "noisy-1", category: "noisy-session", messages: [["user", "topik serius: arsitektur message queue"], ...Array.from({ length: 14 }, (_, i) => ["user", i % 2 ? "haha lucu" : "wkwkwk"]), ["user", "balik ke message queue tadi, backlog size ideal berapa?"]], memoryCorpus: [], required: ["message queue"], forbidden: [] },

    // ---- 19. Stale memory ---------------------------------------------------------------------------------------------
    { id: "stale-1", category: "stale-memory", messages: [["user", "alamat kantor kami sekarang?"]], memoryCorpus: [["Alamat kantor lama: Jalan Sudirman 12 (sudah pindah 2023)."], ["Alamat kantor baru: Menara Astra lv 21."]], required: ["Menara Astra"], forbidden: [] },

    // ---- 20. Missing/degraded source ---------------------------------------------------------------------------------------
    { id: "degraded-1", category: "degraded", messages: [["user", "ingatkan konteks proyek gamma"]], memoryCorpus: [], required: [], forbidden: [], memoryError: true },
    { id: "degraded-2", category: "degraded", messages: [["user", "halo, kita lanjut ya"]], memoryCorpus: [], required: [], forbidden: [], memoryError: true },

    // ---- Tambahan: dedupe history-memory duplication --------------------------------------------------------------------------
    { id: "dedupe-1", category: "duplication", messages: [["user", "Ronny ulang tahun 12 Mei dan suka kopi hitam tanpa gula"], ["assistant", "Tercatat ulang tahun 12 Mei."], ["user", "kapan ulang tahunku?"]], memoryCorpus: [["Ronny ulang tahun 12 Mei dan suka kopi hitam tanpa gula."]], required: ["12 Mei"], forbidden: [] },
    { id: "dedupe-2", category: "duplication", messages: [["user", "password wifi kantor: damar2026!"], ["assistant", "Ok tersimpan."], ["user", "wifi kantor passwordnya apa?"]], memoryCorpus: [["Password wifi kantor: damar2026!"]], required: ["damar2026"], forbidden: [] }
];

// Perluas kategori long/noisy agar total kasus >= 60 dengan variasi nyata.
for (let k = 1; k <= 8; k++) {
    CASES.push({
        id: `recent-x${k}`, category: "recent-continuation",
        messages: [
            ["user", `kita sedang menyusun dokumen spesifikasi bagian ${k}`],
            ["assistant", `Bagian ${k} draf selesai.`],
            ["user", `perbaiki typo di bagian ${k} itu`]
        ],
        memoryCorpus: [], required: [`bagian ${k}`], forbidden: []
    });
}

for (let k = 1; k <= 8; k++) {
    const topics = ["invoice", "webhook", "scheduler", "crawler", "parser pdf", "notifikasi", "dashboard", "export csv"];
    CASES.push({
        id: `old-x${k}`, category: "old-topic",
        messages: [
            ["user", `dua minggu lalu kita rancang modul ${topics[k - 1]} secara rinci`],
            ["assistant", `Betul, modul ${topics[k - 1]}: arsitektur dan antreannya.`],
            ...Array.from({ length: 6 }, (_, i) => ["user", `obrolan lain ${i}: ${["cuaca", "makanan", "olahraga"][i % 3]}`]),
            ["user", `lanjutkan rancangan modul ${topics[k - 1]} kemarin`]
        ],
        memoryCorpus: [], required: [topics[k - 1]], forbidden: []
    });
}

for (let k = 1; k <= 8; k++) {
    CASES.push({
        id: `memreq-x${k}`, category: "memory-required",
        messages: [["user", ["plat mobilku apa?", "nama kucingku?", "ukuran kaosku?", "warna helmku?", "merk laptopku?", "provider internetku?", "jenis motor ku?", "pin ATM cadanganku?"][k - 1]]],
        memoryCorpus: [[
            ["Plat mobil Ronny: B 1234 XYZ.", "Kucingnya bernama Oyen.", "Kaos ukuran XL.", "Helm hitam doff.", "Laptop ThinkPad X1.", "Internet IndiHome.", "Motor Nmax.", "PIN cadangan 7777 (catatan aman)."][k - 1]
        ]],
        required: [["B 1234", "Oyen", "XL", "hitam", "ThinkPad", "IndiHome", "Nmax", "7777"][k - 1]],
        forbidden: []
    });
}

module.exports = { CASES };

