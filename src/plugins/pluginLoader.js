const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

const pluginRegistry = require("./pluginRegistry");
const pluginValidator = require("./pluginValidator");

const {
    ToolRegistry
} = require("../core/tools");

/**
 * Direktori plugin buatan pengguna / hasil karya Damar sendiri.
 *
 * Dipisah dari src/plugins (bawaan, ikut git) supaya tool yang
 * dibuat di rumah tidak tercampur dengan kode inti dan tidak
 * ikut ter-commit. Isinya di-scan bersama plugin bawaan.
 */
const USER_ROOT =
    process.env.DAMAR_USER_PLUGINS ??
    path.join(__dirname, "..", "..", "userPlugins");

class PluginLoader {

    constructor() {

        /**
         * Catatan tiap plugin ter-load: dari mana asalnya dan tool
         * apa saja miliknya. Dibutuhkan untuk hot reload / unload
         * yang bersih tanpa merestart daemon.
         * @type {Map<string, {path:string, source:string, toolIds:string[]}>}
         */
        this.loaded = new Map();

    }

    get userRoot() {
        return USER_ROOT;
    }

    /**
     * Muat ulang semuanya dari awal: plugin bawaan lalu plugin
     * pengguna. Dipanggil sekali saat boot (dari app.js).
     */
    load(builtinRoot) {

        pluginRegistry.clear();
        ToolRegistry.clear();
        this.loaded.clear();

        this.loadRoot(builtinRoot, "builtin");

        if (fs.existsSync(USER_ROOT)) {
            this.loadRoot(USER_ROOT, "user");
        }

    }

    loadRoot(root, source) {

        const folders = fs.readdirSync(root);

        for (const folder of folders) {

            // Lewati folder tersembunyi (mis. .drafts) — draft belum
            // disetujui tidak boleh ikut ter-load.
            if (folder.startsWith(".")) {
                continue;
            }

            const pluginPath = path.join(root, folder);

            if (!this.isPluginDirectory(pluginPath)) {
                continue;
            }

            this.loadOne(pluginPath, source);

        }

    }

    /**
     * Muat satu plugin dari folder-nya. Aman dipanggil ulang untuk
     * plugin yang sama (hot reload) — versi lama di-unload dulu.
     *
     * @returns {{ok:boolean, id?:string, tools?:number, error?:string}}
     */
    /**
     * Root karantina artefak forge (draft). Artefak di sini TIDAK PERNAH
     * dimuat, dan alasan penolakannya adalah LOKASI, bukan metadata.
     */
    get forgeQuarantineRoot() {
        return path.join(USER_ROOT, ".drafts");
    }

    /** Buku provenance keluaran forge (ditulis forge, di luar direktori artefak). */
    get forgeProvenanceLedgerPath() {
        return path.join(USER_ROOT, ".forge-provenance.json");
    }

    /** realpath bila bisa; kalau tidak (belum ada / bukan symlink), path apa adanya. */
    realPathOrSelf(target) {
        try {
            return fs.realpathSync.native
                ? fs.realpathSync.native(target)
                : fs.realpathSync(target);
        }
        catch {
            return target;
        }
    }

    /**
     * Apakah path ini berada di dalam karantina forge?
     *
     * Dua lapis: path leksikal DAN realpath-nya. Sebuah symlink/junction di
     * root plugin (mis. `userPlugins/alias -> .drafts/x`) lolos pemeriksaan
     * leksikal tetapi realpath-nya tetap menunjuk ke karantina, jadi jalur
     * alias ini ikut tertutup.
     */
    isQuarantinedForgeArtifact(pluginPath) {

        const resolved = path.resolve(pluginPath);
        const targets = [resolved, this.realPathOrSelf(resolved)];
        const roots = [this.forgeQuarantineRoot, this.realPathOrSelf(this.forgeQuarantineRoot)];

        for (const target of targets) {
            for (const root of roots) {
                const rel = path.relative(root, target);
                if (rel === "") return true;
                if (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)) return true;
            }
        }

        return false;

    }

    /**
     * Provenance BERBASIS ISI.
     *
     * Metadata di dalam artefak bisa dihapus; ISI berkas tidak bisa dihapus
     * tanpa mengubah artefaknya. Hash dari setiap berkas yang forge hasilkan
     * dicatat di buku provenance yang dimiliki forge (di luar direktori
     * artefak), jadi menyalin artefak ke luar karantina lalu menghapus penanda
     * TETAP tertolak selama isinya belum diubah.
     *
     * Fail-closed: buku ada tetapi tidak terbaca = tolak (provenance forge
     * eksis tetapi tidak bisa diverifikasi).
     */
    isForgeProvenanceContent(pluginPath, manifest) {

        const ledgerPath = this.forgeProvenanceLedgerPath;

        if (!fs.existsSync(ledgerPath)) return false;

        let ledger;
        try {
            ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        }
        catch {
            return true;
        }

        const hashes = ledger?.hashes;
        if (!hashes || typeof hashes !== "object") return true;

        const names = new Set(["tool.js", "index.js", manifest?.entry ?? "index.js"].filter(Boolean));

        for (const name of names) {
            const file = path.join(pluginPath, name);
            try {
                if (!fs.existsSync(file)) continue;
                const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
                if (Object.prototype.hasOwnProperty.call(hashes, digest)) return true;
            }
            catch { /* berkas tak terbaca: lanjut memeriksa yang lain */ }
        }

        return false;

    }

    /**
     * Provenance: artefak hasil generate forge TIDAK PERNAH dimuat.
     *
     * W8 legacy second-path remediation: `require()` atas modul plugin
     * menjalankan BODY modulnya, jadi kode hasil generate forge (yang bukan
     * kapabilitas kanonik) tidak boleh dimuat dari jalur legacy mana pun.
     * Penanda diperiksa SEBELUM require/index.js dibaca.
     */
    isForgeGenerated(pluginPath) {

        try {

            if (fs.existsSync(path.join(pluginPath, ".forge-generated"))) return true;

            const manifestPath = path.join(pluginPath, "manifest.json");

            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                if (manifest?.forgeGenerated === true) return true;
                if (manifest?.forge?.generated === true) return true;
            }

        }
        catch { /* manifest rusak bukan bukti provenance */ }

        return false;

    }

    /** Alasan penolakan yang seragam untuk artefak forge. */
    refuseForgeArtifact(pluginPath) {

        const name = path.basename(pluginPath);

        try {
            require("../services/telemetryService").info(
                `[pluginLoader] menolak memuat artefak forge '${name}' (menunggu jalur kanonik)`
            );
        }
        catch { /* observability opsional */ }

        return { ok: false, forgeGenerated: true, canonicalRequired: true, error: `artefak forge '${name}' tidak dimuat tanpa registrasi kanonik` };

    }

    loadOne(pluginPath, source = "user") {

        // require/require.resolve butuh path absolut (relatifnya
        // dihitung dari lokasi modul ini, bukan cwd). Diresolve di
        // sini agar pemanggil boleh memberi path relatif.
        pluginPath = path.resolve(pluginPath);

        // Guard PALING AWAL, tiga lapis: LOKASI karantina (leksikal + realpath,
        // jadi symlink/junction tidak menembus), provenance metadata, lalu
        // provenance ISI (menutup copy-out yang penandanya dihapus). Semuanya
        // dijalankan sebelum manifest dibaca dan sebelum index.js/tool.js
        // di-require.
        if (this.isQuarantinedForgeArtifact(pluginPath) ||
            this.isForgeGenerated(pluginPath) ||
            this.isForgeProvenanceContent(pluginPath, null)) {
            return this.refuseForgeArtifact(pluginPath);
        }

        let manifest;

        try {
            manifest = this.loadManifest(pluginPath);
        }
        catch (error) {
            console.error(`✗ Manifest plugin gagal : ${pluginPath}`);
            console.error(error.message);
            return { ok: false, error: error.message };
        }

        // Kalau plugin ini sudah ter-load, lepas dulu supaya tidak
        // menumpuk tool ganda di registry.
        if (this.loaded.has(manifest.id)) {
            this.unloadPlugin(manifest.id);
        }

        try {

            const instance = this.loadPlugin(pluginPath, manifest);

            const tools = this.collectTools(pluginPath, instance);

            this.registerPlugin(manifest, instance);

            const toolIds = this.registerTools(manifest, tools);

            this.loaded.set(manifest.id, {
                path: pluginPath,
                source,
                toolIds
            });

            console.log(
                `✓ Loaded Plugin : ${manifest.name}` +
                (source === "user" ? "  (user)" : "")
            );

            return { ok: true, id: manifest.id, tools: toolIds.length };

        }

        catch (error) {

            console.error(`✗ Failed Plugin : ${path.basename(pluginPath)}`);
            console.error(error);

            return { ok: false, id: manifest.id, error: error.message };

        }

    }

    /**
     * Lepas sebuah plugin: hapus tool-nya dari ToolRegistry, cabut
     * dari pluginRegistry, dan buang cache require-nya supaya
     * pemuatan berikutnya membaca kode terbaru.
     */
    unloadPlugin(pluginId) {

        const record = this.loaded.get(pluginId);

        if (!record) {
            return false;
        }

        for (const toolId of record.toolIds) {
            ToolRegistry.unregister(toolId);
        }

        pluginRegistry.unregister(pluginId);

        this.clearRequireCache(record.path);

        this.loaded.delete(pluginId);

        return true;

    }

    /** Muat ulang satu plugin dari path-nya (dipakai setelah edit). */
    reloadPath(pluginPath) {

        return this.loadOne(pluginPath, "user");

    }

    /** Buang cache require untuk seluruh berkas di dalam folder plugin. */
    clearRequireCache(pluginPath) {

        const resolved = path.resolve(pluginPath);

        for (const key of Object.keys(require.cache)) {

            if (path.resolve(key).startsWith(resolved)) {
                delete require.cache[key];
            }

        }

    }

    info(pluginId) {
        return this.loaded.get(pluginId) ?? null;
    }

    /**
     * Jalankan hook lifecycle `initialize()` untuk semua plugin
     * yang sudah ter-load. Dipisah dari load() karena load()
     * sinkron (dipanggil saat require app.js).
     */
    async initializeAll(context) {

        const { LifecycleManager } =
            require("../core/lifecycle");

        for (const { id, item } of pluginRegistry.list()) {

            try {

                await LifecycleManager.initialize(
                    item.instance,
                    context
                );

            }
            catch (error) {

                console.error(
                    `✗ Failed to initialize plugin : ${id}`
                );

                console.error(error);

            }

        }

    }

    isPluginDirectory(pluginPath) {

        return (
            fs.existsSync(pluginPath) &&
            fs.statSync(pluginPath).isDirectory() &&
            fs.existsSync(
                path.join(
                    pluginPath,
                    "manifest.json"
                )
            )
        );

    }

    loadManifest(pluginPath) {

        const manifest = JSON.parse(
            fs.readFileSync(
                path.join(pluginPath, "manifest.json"),
                "utf8"
            )
        );

        pluginValidator.validate(manifest);

        return manifest;

    }

    loadPlugin(pluginPath, manifest) {

        // Defense-in-depth: even if a caller reaches here directly, neither a
        // quarantined path nor a forge artifact is ever required (this is the
        // last point before require).
        if (this.isQuarantinedForgeArtifact(pluginPath) ||
            this.isForgeGenerated(pluginPath) ||
            this.isForgeProvenanceContent(pluginPath, manifest)) {
            return {};
        }

        const entryPath = path.join(
            pluginPath,
            manifest.entry
        );

        if (!fs.existsSync(entryPath)) {
            return {};
        }

        delete require.cache[
            require.resolve(entryPath)
        ];

        return require(entryPath);

    }

    /**
     * Tool sebuah plugin bisa datang dari dua tempat:
     * `index.js` yang mengekspor `tools: [...]` (sudah
     * ter-instansiasi), atau `tool.js` yang mengekspor array.
     * Keduanya digabung dan dideduplikasi berdasarkan nama.
     */
    collectTools(pluginPath, instance) {

        const tools = [];

        if (Array.isArray(instance?.tools)) {
            tools.push(...instance.tools);
        }

        // Beberapa plugin lama memakai `tool` (tunggal).
        if (instance?.tool) {
            tools.push(instance.tool);
        }

        tools.push(...this.loadTools(pluginPath));

        const seen = new Set();

        return tools.filter(tool => {

            const name = tool?.metadata?.name ?? tool?.name;

            if (!name || seen.has(name)) {
                return false;
            }

            seen.add(name);

            return true;

        });

    }

    loadTools(pluginPath) {

        const toolPath = path.join(
            pluginPath,
            "tool.js"
        );

        if (!fs.existsSync(toolPath)) {

            return [];

        }

        // W8 legacy second-path remediation: kode hasil generate forge BUKAN
        // kapabilitas kanonik, dan `require()` di bawah menjalankan body
        // modulnya. Artefak di karantina TIDAK dimuat karena LOKASINYA, dan
        // artefak berpenanda provenance tidak dimuat karena asal-usulnya —
        // jadi menghapus penanda tidak membuka jalur ini.
        if (this.isQuarantinedForgeArtifact(pluginPath) ||
            this.isForgeGenerated(pluginPath) ||
            this.isForgeProvenanceContent(pluginPath, { entry: "tool.js" })) {

            return [];

        }

        delete require.cache[
            require.resolve(toolPath)
        ];

        const tools = require(toolPath);

        return Array.isArray(tools)
            ? tools
            : [];

    }

    registerPlugin(manifest, instance) {

        pluginRegistry.register({
            manifest,
            instance
        });

    }

    /** @returns {string[]} id tool yang terdaftar (untuk unload nanti). */
    registerTools(manifest, tools) {

        const toolIds = [];

        for (const tool of tools) {

            const registered = ToolRegistry.register(
                manifest.id,
                tool
            );

            const name = tool.metadata?.name ?? tool.name;

            toolIds.push(`${manifest.id}.${name}`);

            console.log(`   └── ${manifest.id}.${name}`);

        }

        return toolIds;

    }

}

module.exports = new PluginLoader();
