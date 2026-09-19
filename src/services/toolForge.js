const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const pluginLoader = require("../plugins/pluginLoader");
const telemetry = require("./telemetryService");

/**
 * Penanda asal-usul artefak generate. pluginLoader menolak memuat direktori
 * plugin yang memuat penanda ini (lihat pluginLoader.loadTools): kode yang
 * dihasilkan forge bukan kapabilitas kanonik, dan `require()` atas modulnya
 * menjalankan body modul = eksekusi kode arbitrer di luar kepemilikan kanonik.
 */
const FORGE_GENERATED_MARKER = ".forge-generated";

/**
 * Penanda STATUS persetujuan (bukan izin eksekusi). Sejak W8, menyetujui draft
 * tidak memindahkannya ke root plugin yang bisa dimuat: artefak forge tetap di
 * karantina, dan aktivasi menunggu registrasi kanonik.
 */
const APPROVED_MARKER = ".forge-approved";

/**
 * ToolForge — tempat Damar (dan pengguna) membuat tool baru.
 *
 * Sebuah "tool spec" diubah menjadi folder plugin nyata
 * (manifest.json + tool.js), lalu di-load tanpa merestart daemon.
 *
 * Keamanan: kode buatan model TIDAK langsung jalan. Ia disimpan
 * sebagai DRAFT (di .drafts/, tidak di-scan loader) sampai
 * disetujui pengguna — kecuali DAMAR_TOOL_AUTOAPPROVE=1.
 * Penghapusan hanya menyentuh plugin di userPlugins (buatan
 * pengguna), tidak pernah plugin bawaan.
 */
class ToolForge {

    constructor() {

        this.userRoot = pluginLoader.userRoot;

        this.draftsRoot = path.join(this.userRoot, ".drafts");

        // Id ini milik plugin bawaan — tidak boleh ditimpa/dibuat
        // ulang oleh forge agar tidak membayangi kode inti.
        this.reserved = new Set([
            "calculator", "crypto", "docker", "filesystem",
            "http", "system.time", "weather"
        ]);

        this.autoApprove = process.env.DAMAR_TOOL_AUTOAPPROVE === "1";

    }

    ensureDirs() {
        fs.mkdirSync(this.userRoot, { recursive: true });
        fs.mkdirSync(this.draftsRoot, { recursive: true });
    }

    // ---- Validasi ------------------------------------------------

    /**
     * Periksa spec sebelum ditulis. Melempar Error dengan pesan
     * jelas bila tidak valid.
     */
    validate(spec) {

        if (!spec || typeof spec !== "object") {
            throw new Error("Spec tool kosong.");
        }

        const id = String(spec.id ?? "").trim().toLowerCase();

        if (!/^[a-z][a-z0-9._-]{1,40}$/.test(id)) {
            throw new Error(
                "Id tidak valid. Pakai huruf kecil, angka, titik, atau strip (mis. 'ping-host')."
            );
        }

        // Cegah path traversal lewat id.
        if (id.includes("..") || id.includes("/") || id.includes("\\")) {
            throw new Error("Id mengandung karakter terlarang.");
        }

        if (this.reserved.has(id)) {
            throw new Error(`Id '${id}' dipakai plugin bawaan. Pilih nama lain.`);
        }

        const tool = spec.tool ?? {};

        // Mode KODE PENUH: pengguna/Damar menulis seluruh tool.js
        // sendiri (boleh banyak tool, import, helper). Hanya perlu
        // id + isi berkas; nama/parameter tidak wajib.
        if (spec.raw || tool.raw) {

            if (!String(spec.raw ?? tool.raw).trim()) {
                throw new Error("Kode tool (mode penuh) kosong.");
            }

            return { id, tool, raw: String(spec.raw ?? tool.raw) };

        }

        // Mode FORMULIR:
        if (!/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(tool.name ?? "")) {
            throw new Error(
                "Nama tool tidak valid. Pakai huruf/angka/underscore, diawali huruf (mis. 'pingHost')."
            );
        }

        if (!tool.code || !String(tool.code).trim()) {
            throw new Error("Kode execute() tool kosong.");
        }

        // parameters opsional (tool boleh tanpa skema/argumen bebas).
        if (tool.parameters && typeof tool.parameters !== "object") {
            throw new Error("parameters harus objek.");
        }

        return { id, tool };

    }

    /**
     * Cari pola berisiko dalam kode. TIDAK memblokir — hanya
     * memberi tahu pengguna apa yang akan dilakukan tool sebelum
     * ia menyetujuinya.
     */
    analyzeRisk(code) {

        const text = String(code ?? "");

        const checks = [
            [/child_process|execSync|\bexec\(|spawn\(/,     "Menjalankan perintah sistem (child_process)"],
            [/require\(\s*['"]fs['"]|fs\.(unlink|rm|rmdir|writeFile|rename)/, "Mengakses/menulis berkas (fs)"],
            [/process\.(exit|kill|env)/,                    "Menyentuh proses/environment"],
            [/\beval\(|new Function\(/,                     "Mengeksekusi kode dinamis (eval)"],
            [/fetch\(|http[s]?:\/\/|require\(\s*['"]https?['"]\)|axios/, "Mengakses jaringan / URL"],
            [/require\(\s*['"]\.\.?\//,                     "Meng-import berkas proyek lain"]
        ];

        const findings = [];

        for (const [pattern, label] of checks) {
            if (pattern.test(text)) {
                findings.push(label);
            }
        }

        return findings;

    }

    // ---- Pembuatan berkas ----------------------------------------

    manifestFor(id, spec) {

        return {
            id,
            name: spec.name ?? id,
            version: spec.version ?? "1.0.0",
            entry: "index.js",
            category: spec.category ?? "user",
            description: spec.description ?? "",
            // Provenance mesin: artefak ini dihasilkan ToolForge dan karena itu
            // TIDAK boleh dimuat langsung oleh pluginLoader.
            forgeGenerated: true,
            // Provenance untuk tool BARU. Manifest lama yang sudah
            // tercatat "aether-forge" DIBIARKAN apa adanya — itu
            // catatan sejarah siapa pembuatnya, bukan branding aktif.
            author: spec.author ?? "damar-forge",
            permissions: spec.permissions ?? [],
            tags: spec.tags ?? ["user"],
            // Jejak untuk membedakan karya Damar vs tulisan manual,
            // plus spec asli agar tool bisa diedit ulang dari Console
            // tanpa harus mengurai tool.js.
            forge: {
                origin: spec.origin ?? "manual",
                createdAt: new Date().toISOString(),
                // Simpan spec asli agar bisa diedit ulang. Untuk mode
                // kode penuh, cukup simpan flag + sumbernya.
                spec: (spec.raw || spec.tool?.raw)
                    ? { raw: String(spec.raw ?? spec.tool.raw) }
                    : {
                        toolName: spec.tool?.name,
                        description: spec.tool?.description ?? "",
                        parameters: spec.tool?.parameters ?? {},
                        code: spec.tool?.code
                    }
            }
        };

    }

    /** Rakit isi tool.js dari spec. */
    toolSource(spec) {

        const tool = spec.tool;

        const className =
            tool.name.charAt(0).toUpperCase() +
            tool.name.slice(1).replace(/[^a-zA-Z0-9]/g, "") +
            "Tool";

        const params = JSON.stringify(tool.parameters ?? {}, null, 8)
            .replace(/\n/g, "\n        ");

        // Kode execute dari model dimasukkan apa adanya sebagai
        // badan method. Diindentasi sekadar agar rapi dibaca.
        const body = String(tool.code)
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map(line => (line ? `        ${line}` : ""))
            .join("\n");

        return `// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ${className} {

    constructor() {
        this.name = ${JSON.stringify(tool.name)};
        this.description = ${JSON.stringify(tool.description ?? "")};
        this.parameters = ${params};
    }

    async execute(context, args = {}) {
${body}
    }

}

module.exports = [ new ${className}() ];
`;

    }

    /**
     * Tulis folder plugin (manifest + index + tool.js) ke `root`.
     * index.js hanya meneruskan tool.js agar cocok dengan loader.
     */
    writePlugin(root, id, spec) {

        const dir = path.join(root, id);

        fs.mkdirSync(dir, { recursive: true });

        // Jejak asal-usul: artefak hasil generate TIDAK boleh dimuat langsung
        // oleh pluginLoader (W8 legacy second-path remediation). Penanda ini
        // yang membuat load-time tetap fail-closed meski berkasnya ada.
        fs.writeFileSync(path.join(dir, FORGE_GENERATED_MARKER), "1\n", "utf8");

        fs.writeFileSync(
            path.join(dir, "manifest.json"),
            JSON.stringify(this.manifestFor(id, spec), null, 4),
            "utf8"
        );

        // Mode kode penuh: tulis apa adanya. Mode formulir: templat.
        const raw = spec.raw ?? spec.tool?.raw;

        fs.writeFileSync(
            path.join(dir, "tool.js"),
            raw ? String(raw) : this.toolSource(spec),
            "utf8"
        );

        fs.writeFileSync(
            path.join(dir, "index.js"),
            "const tools = require('./tool');\n" +
            "module.exports = { tools, skills: [], events: [], scheduler: [] };\n",
            "utf8"
        );

        return dir;

    }

    /**
     * Uji STRUKTUR tool.js TANPA menjalankannya.
     *
     * W8 legacy second-path remediation: versi lama `require()` berkas draf,
     * yang berarti BODY modul hasil generate ikut berjalan di proses ini —
     * kode arbitrer di luar kepemilikan kanonik. Kini hanya dilakukan
     * kompilasi sintaks (`node:vm` Script = compile, bukan run), jadi kode
     * yang tidak valid ditolak tanpa satu pun baris dieksekusi.
     *
     * @returns {null} jumlah tool tidak bisa diketahui tanpa menjalankan kode.
     */
    verifyLoads(dir) {

        const toolPath = path.join(dir, "tool.js");

        if (!fs.existsSync(toolPath)) {
            throw new Error("tool.js tidak ditemukan.");
        }

        const source = fs.readFileSync(toolPath, "utf8");

        if (!source.trim()) {
            throw new Error("tool.js kosong.");
        }

        // Compile-only: body modul TIDAK dijalankan.
        new (require("node:vm").Script)(source, { filename: toolPath });

        return null;

    }

    // ---- API tingkat tinggi --------------------------------------

    /**
     * Buat tool. Default masuk sebagai draft (perlu persetujuan);
     * `activate: true` (atau DAMAR_TOOL_AUTOAPPROVE) langsung
     * mengaktifkannya.
     */
    create(spec, { activate = false } = {}) {

        this.ensureDirs();

        const { id } = this.validate(spec);

        // Bentuk kode berbeda antara mode formulir vs kode penuh.
        const risks = this.analyzeRisk(
            spec.raw ?? spec.tool?.raw ?? spec.tool?.code
        );

        // W8 legacy second-path remediation: `activate`/auto-approve TIDAK
        // lagi memuat & menjalankan kode hasil generate. Artefak forge selalu
        // tersimpan sebagai DRAFT; aktivasi menunggu registrasi kanonik
        // (Manager -> ActionIntent -> Authority -> Capability -> actuation).
        const requestedActivation = activate === true || this.autoApprove;

        // Tulis dulu ke lokasi sementara untuk verifikasi muat,
        // supaya draft/plugin rusak tidak pernah tersimpan.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "damar-forge-"));

        try {

            const tmpDir = this.writePlugin(tmp, id, spec);
            const toolCount = this.verifyLoads(tmpDir);

            const targetRoot = this.draftsRoot;

            // Bersihkan versi lama di target bila ada.
            this.removeDir(path.join(targetRoot, id));

            const dir = this.writePlugin(targetRoot, id, spec);

            // Provenance berbasis ISI dicatat di buku milik forge (di luar
            // artefak), supaya penanda yang dihapus tidak membuka jalur muat.
            this.recordProvenance(dir, id);

            telemetry.publish("forge:created", {
                id,
                origin: spec.origin ?? "manual",
                draft: true,
                requestedActivation,
                risks
            });

            telemetry.info(
                `[forge] tool '${id}' disimpan sebagai draft (aktivasi menunggu jalur kanonik)`
            );

            return {
                id,
                status: "draft",
                activated: false,
                canonicalRequired: true,
                requestedActivation,
                tools: toolCount,
                risks,
                loaded: false,
                dir
            };

        }

        finally {
            this.removeDir(tmp);
        }

    }

    /**
     * Setujui draft: catat STATUS persetujuan. TIDAK memindahkan artefak ke
     * root plugin dan TIDAK memuat/menjalankan kode.
     *
     * Sebelum W8, approve() me-rename draft ke userRoot lalu memuatnya. Itu
     * membuat persetujuan sama dengan aktivasi, dan membuat artefak forge
     * berada di root yang dimuat — sehingga menghapus penanda provenance saja
     * sudah cukup untuk membuka eksekusi kode hasil generate.
     */
    approve(id) {

        const draftDir = path.join(this.draftsRoot, id);

        if (!fs.existsSync(draftDir)) {
            throw new Error(`Draft '${id}' tidak ditemukan.`);
        }

        fs.writeFileSync(path.join(draftDir, APPROVED_MARKER), new Date().toISOString() + "\n", "utf8");

        telemetry.publish("forge:changed", { id, action: "approved" });

        telemetry.info(`[forge] draft '${id}' disetujui (status); aktivasi menunggu jalur kanonik`);

        return { id, status: "approved", activated: false, canonicalRequired: true, tools: null, dir: draftDir };

    }

    reject(id) {

        const draftDir = path.join(this.draftsRoot, id);

        if (!fs.existsSync(draftDir)) {
            return false;
        }

        this.removeDir(draftDir);

        telemetry.info(`[forge] draft '${id}' ditolak`);

        return true;

    }

    /** Hapus plugin buatan pengguna (bukan bawaan). */
    remove(id) {

        if (this.reserved.has(id)) {
            throw new Error("Plugin bawaan tidak bisa dihapus dari sini.");
        }

        const dir = path.join(this.userRoot, id);

        if (!fs.existsSync(dir)) {
            // Mungkin masih berupa draft.
            return this.reject(id);
        }

        pluginLoader.unloadPlugin(id);

        this.removeDir(dir);

        telemetry.publish("forge:changed", { id, action: "removed" });

        telemetry.info(`[forge] plugin '${id}' dihapus`);

        return true;

    }

    /**
     * Buku provenance milik forge: hash isi setiap berkas yang dihasilkan.
     *
     * Letaknya DI LUAR direktori artefak, jadi menghapus penanda di dalam
     * artefak tidak menghapus catatannya. Ini yang menutup jalur "salin artefak
     * keluar karantina lalu hapus penanda": isinya tidak berubah, jadi hash-nya
     * masih cocok dan pluginLoader tetap menolak memuatnya.
     */
    get ledgerPath() {
        return path.join(this.userRoot, ".forge-provenance.json");
    }

    codeHash(file) {
        try {
            return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        }
        catch {
            return null;
        }
    }

    readProvenanceLedger() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8"));
            if (parsed && typeof parsed === "object" &&
                parsed.hashes && typeof parsed.hashes === "object") {
                return parsed;
            }
        }
        catch { /* belum ada / rusak: dibangun ulang di bawah */ }
        return { version: 1, hashes: {} };
    }

    recordProvenance(dir, id) {
        try {
            const hashes = ["tool.js", "index.js"]
                .map(name => this.codeHash(path.join(dir, name)))
                .filter(Boolean);
            if (hashes.length === 0) return;
            const ledger = this.readProvenanceLedger();
            for (const hash of hashes) {
                ledger.hashes[hash] = { id, at: new Date().toISOString() };
            }
            // Tulis atomik supaya buku tidak pernah setengah jadi.
            const tmp = this.ledgerPath + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
            fs.renameSync(tmp, this.ledgerPath);
        }
        catch { /* kegagalan buku tidak boleh membuat jalur eksekusi terbuka */ }
    }

    /**
     * Apakah direktori ini artefak hasil generate forge? Artefak seperti itu
     * TIDAK pernah dimuat (lihat pluginLoader), jadi statusnya tidak boleh
     * dilaporkan sebagai "active".
     */
    isForgeGeneratedDir(dir) {
        try {
            if (fs.existsSync(path.join(dir, FORGE_GENERATED_MARKER))) return true;
            const manifestPath = path.join(dir, "manifest.json");
            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                if (manifest?.forgeGenerated === true) return true;
                if (manifest?.forge?.generated === true) return true;
            }
        }
        catch { /* manifest rusak bukan bukti provenance */ }

        return false;

    }

    /**
     * Status jujur sebuah artefak.
     *
     * "active" HANYA bila pluginLoader benar-benar memuatnya (bukan disimpulkan
     * dari lokasi direktori). "approved" = disetujui/diinstal tetapi belum
     * dimuat. "draft" = belum disetujui. Status tidak pernah menyamar sebagai
     * aktivasi, dan persetujuan tidak pernah berarti bisa dipanggil.
     */
    statusFor(dir, id, manifest, installed) {

        const loaded = pluginLoader?.loaded;
        const isLoaded = typeof loaded?.has === "function" &&
            (loaded.has(id) === true ||
                (manifest?.id !== undefined && loaded.has(manifest.id) === true));

        if (isLoaded) return { status: "active", activated: true };

        if (installed || fs.existsSync(path.join(dir, APPROVED_MARKER))) {
            return { status: "approved", activated: false };
        }

        return { status: "draft", activated: false };

    }

    /** Baca kembali spec sebuah plugin/draft untuk diedit. */
    read(id) {

        for (const root of [this.userRoot, this.draftsRoot]) {

            const dir = path.join(root, id);

            if (!fs.existsSync(dir)) {
                continue;
            }

            const manifest = JSON.parse(
                fs.readFileSync(path.join(dir, "manifest.json"), "utf8")
            );

            const source = fs.readFileSync(
                path.join(dir, "tool.js"), "utf8"
            );

            const forgeGenerated = this.isForgeGeneratedDir(dir);
            const state = this.statusFor(dir, id, manifest, root === this.userRoot);

            return {
                id,
                status: state.status,
                activated: state.activated,
                canonicalRequired: forgeGenerated,
                manifest,
                source,
                spec: manifest.forge?.spec ?? null,
                risks: this.analyzeRisk(source)
            };

        }

        return null;

    }

    /** Daftar semua plugin buatan pengguna + draft. */
    list() {

        this.ensureDirs();

        const readRoot = (root, status) => {

            if (!fs.existsSync(root)) {
                return [];
            }

            return fs.readdirSync(root)
                .filter(name => !name.startsWith(".") || status === "draft")
                .filter(name => {
                    const m = path.join(root, name, "manifest.json");
                    return fs.existsSync(m);
                })
                .map(name => {
                    const manifest = JSON.parse(
                        fs.readFileSync(path.join(root, name, "manifest.json"), "utf8")
                    );
                    const source = fs.readFileSync(
                        path.join(root, name, "tool.js"), "utf8"
                    );
                    // Artefak forge tidak pernah dimuat: statusnya "approved"
                    // (persetujuan tersimpan), bukan "active".
                    const forgeGenerated = this.isForgeGeneratedDir(path.join(root, name));
                    const state = this.statusFor(path.join(root, name), name, manifest, status === "active");
                    return {
                        id: manifest.id,
                        name: manifest.name,
                        description: manifest.description,
                        status: state.status,
                        activated: state.activated,
                        canonicalRequired: forgeGenerated,
                        origin: manifest.forge?.origin ?? "manual",
                        createdAt: manifest.forge?.createdAt ?? null,
                        risks: this.analyzeRisk(source)
                    };
                });

        };

        return {
            active: readRoot(this.userRoot, "active"),
            drafts: readRoot(this.draftsRoot, "draft")
        };

    }

    removeDir(dir) {
        fs.rmSync(dir, { recursive: true, force: true });
    }

}

module.exports = new ToolForge();
