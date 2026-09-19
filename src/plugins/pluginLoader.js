const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

/** Penanda internal: buku provenance ada tetapi tidak bisa dibaca (fail-closed). */
const LEDGER_UNREADABLE = "__forge-ledger-unreadable__";

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
     * Himpunan hash isi yang diketahui dihasilkan forge.
     *
     * DUA sumber, dan yang kedua tidak bisa dihapus dari dalam artefak:
     *   1. buku provenance yang dimiliki forge (`.forge-provenance.json`);
     *   2. hash LANGSUNG dari artefak yang masih ada di karantina.
     *
     * Sumber kedua menutup "salin lalu hapus buku": salinan dihapus bukunya,
     * tetapi artefak aslinya masih ada di karantina, jadi hash-nya tetap
     * dihitung dan salinannya tetap ditolak.
     */
    forgeGeneratedHashes() {

        const hashes = new Set();

        const ledgerPath = this.forgeProvenanceLedgerPath;
        if (fs.existsSync(ledgerPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
                const obj = parsed?.hashes;
                if (!obj || typeof obj !== "object") {
                    hashes.add(LEDGER_UNREADABLE);
                }
                else {
                    for (const key of Object.keys(obj)) hashes.add(key);
                }
            }
            catch {
                hashes.add(LEDGER_UNREADABLE);
            }
        }

        try {
            const root = this.forgeQuarantineRoot;
            if (fs.existsSync(root)) {
                for (const entry of fs.readdirSync(root)) {
                    const dir = path.join(root, entry);
                    let stat = null;
                    try { stat = fs.statSync(dir); } catch { continue; }
                    if (!stat?.isDirectory()) continue;
                    // HANYA tool.js (muatan hasil generate). index.js forge
                    // adalah pembungkus DETERMINISTIK yang sama untuk semua
                    // tool; ikut menghash-nya akan menolak plugin tulisan
                    // tangan yang kebetulan memakai pembungkus serupa, yaitu
                    // regresi pada sistem ekstensi.
                    const file = path.join(dir, "tool.js");
                    try {
                        if (fs.existsSync(file)) {
                            hashes.add(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
                        }
                    }
                    catch { /* berkas tak terbaca: lewati */ }
                }
            }
        }
        catch { /* karantina tak terbaca: sumber buku tetap berlaku */ }

        return hashes;

    }

    /**
     * Provenance BERBASIS ISI.
     *
     * Metadata di dalam artefak bisa dihapus; ISI berkas tidak. Hash setiap
     * berkas yang forge hasilkan dihitung dari buku provenance DAN dari artefak
     * yang masih ada di karantina, jadi menyalin artefak ke luar lalu menghapus
     * penanda — bahkan menghapus bukunya — tetap tertolak selama isinya belum
     * diubah.
     *
     * Fail-closed: buku ada tetapi tidak terbaca = tolak.
     */
    isForgeProvenanceContent(pluginPath, manifest) {

        let hashes;
        try {
            hashes = this.forgeGeneratedHashes();
        }
        catch {
            return true;
        }

        if (hashes.size === 0) return false;
        if (hashes.has(LEDGER_UNREADABLE)) return true;

        // Hanya muatan hasil generate yang dibandingkan. `manifest.entry`
        // sengaja TIDAK dibandingkan: entri normal adalah pembungkus
        // deterministik yang sah dipakai plugin tulisan tangan juga.
        const file = path.join(pluginPath, "tool.js");

        try {
            if (!fs.existsSync(file)) return false;
            const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
            return hashes.has(digest);
        }
        catch {
            return false;
        }

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

        // Entri WAJIB berada di dalam direktori plugin. `entry` datang dari
        // manifest yang bisa ditulis siapa saja (`../outside.js`), dan
        // `path.join` akan dengan senang hati keluar dari direktori —
        // menjalankan berkas di luar artefak.
        const entryPath = this.resolveEntryWithin(pluginPath, manifest?.entry);

        if (entryPath === null) {

            try {
                require("../services/telemetryService").info(
                    `[pluginLoader] menolak entri di luar direktori plugin: ${manifest?.id ?? path.basename(pluginPath)}`
                );
            }
            catch { /* observability opsional */ }

            return {};

        }

        if (!fs.existsSync(entryPath)) {
            return {};
        }

        delete require.cache[
            require.resolve(entryPath)
        ];

        return require(entryPath);

    }

    /**
     * Resolusi `entry` yang TIDAK boleh keluar dari direktori plugin.
     * @returns {string|null} path absolut di dalam pluginPath, atau null.
     */
    resolveEntryWithin(pluginPath, entry) {

        if (typeof entry !== "string" || entry.trim() === "") return null;

        const base = path.resolve(pluginPath);

        // Realpath bila pluginPath ada, supaya symlink tidak melewati cek ini.
        const baseReal = this.realPathOrSelf(base);
        const candidate = path.resolve(base, entry);

        for (const probe of [candidate, this.realPathOrSelf(candidate)]) {
            const rel = path.relative(baseReal, probe);
            if (rel === "" || path.isAbsolute(rel)) return null;
            if (rel === ".." || rel.startsWith(".." + path.sep)) return null;
        }

        return candidate;

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
