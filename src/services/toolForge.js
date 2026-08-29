const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const pluginLoader = require("../plugins/pluginLoader");
const telemetry = require("./telemetryService");

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

    /** Uji apakah tool.js bisa di-require tanpa error (syntax/runtime muat). */
    verifyLoads(dir) {

        const toolPath = path.join(dir, "tool.js");

        // Buang cache agar membaca berkas terbaru.
        try {
            delete require.cache[require.resolve(toolPath)];
        }
        catch { /* belum pernah di-cache */ }

        const exported = require(toolPath);

        const tools = Array.isArray(exported) ? exported : [];

        if (tools.length === 0) {
            throw new Error("tool.js tidak mengekspor tool apa pun.");
        }

        for (const tool of tools) {
            if (typeof tool.execute !== "function") {
                throw new Error("Tool tidak punya method execute().");
            }
        }

        return tools.length;

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

        // Sumber kode berbeda antara mode formulir vs kode penuh.
        const risks = this.analyzeRisk(
            spec.raw ?? spec.tool?.raw ?? spec.tool?.code
        );

        const goLive = activate || this.autoApprove;

        // Tulis dulu ke lokasi sementara untuk verifikasi muat,
        // supaya draft/plugin rusak tidak pernah tersimpan.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "damar-forge-"));

        try {

            const tmpDir = this.writePlugin(tmp, id, spec);
            const toolCount = this.verifyLoads(tmpDir);

            const targetRoot = goLive ? this.userRoot : this.draftsRoot;

            // Bersihkan versi lama di target bila ada.
            this.removeDir(path.join(targetRoot, id));

            const dir = this.writePlugin(targetRoot, id, spec);

            let loaded = null;

            if (goLive) {
                loaded = pluginLoader.loadOne(dir, "user");
                telemetry.publish("forge:changed", { id, action: "created" });
            }

            telemetry.publish("forge:created", {
                id,
                origin: spec.origin ?? "manual",
                draft: !goLive,
                risks
            });

            telemetry.info(
                `[forge] tool '${id}' ${goLive ? "dibuat & aktif" : "disimpan sebagai draft"}`
            );

            return {
                id,
                status: goLive ? "active" : "draft",
                tools: toolCount,
                risks,
                loaded: loaded?.ok ?? false,
                dir
            };

        }

        finally {
            this.removeDir(tmp);
        }

    }

    /** Setujui draft: pindahkan ke userPlugins dan load. */
    approve(id) {

        const draftDir = path.join(this.draftsRoot, id);

        if (!fs.existsSync(draftDir)) {
            throw new Error(`Draft '${id}' tidak ditemukan.`);
        }

        const target = path.join(this.userRoot, id);

        this.removeDir(target);

        fs.renameSync(draftDir, target);

        const loaded = pluginLoader.loadOne(target, "user");

        if (!loaded.ok) {
            throw new Error(`Gagal memuat setelah disetujui: ${loaded.error}`);
        }

        telemetry.publish("forge:changed", { id, action: "approved" });

        telemetry.info(`[forge] draft '${id}' disetujui & aktif`);

        return { id, status: "active", tools: loaded.tools };

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

            return {
                id,
                status: root === this.userRoot ? "active" : "draft",
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
                    return {
                        id: manifest.id,
                        name: manifest.name,
                        description: manifest.description,
                        status,
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
