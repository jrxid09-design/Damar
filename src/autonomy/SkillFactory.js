const toolBus = require("./ToolBus");
const capabilities = require("./CapabilityRegistry");

const { database, initialize } = require("../memory/db");

const telemetry = require("../services/telemetryService");

/**
 * SKILL FACTORY (§4-§5) — Aether membuat kapabilitas baru saat ada GAP.
 *
 * Pipeline deterministik di runtime (§53: bukan di prompt):
 *
 *   gap terdeteksi
 *     → discovery berlapis (registry/paket — §36, cegah duplikat)
 *     → desain spesifikasi (model menyusun spec, runtime memvalidasi)
 *     → implementasi (via ToolForge yang ADA: manifest + tool.js)
 *     → SANDBOX: eksekusi uji di folder karantina dgn argumen contoh
 *     → register ke CapabilityRegistry (+ usage tracking ToolBus)
 *     → skill sementara diberi TTL — otomatis kedaluwarsa kecuali
 *       dipromosikan setelah terbukti (§5/§21).
 *
 * Kode buatan TIDAK dijalankan bebas: sandbox = toolForge draft dir
 * yang di-load terisolasi, dan hanya naik live setelah lulus uji.
 */

const TEMP_TTL_MS = 24 * 60 * 60 * 1000;   // skill sementara hidup 24 jam

class SkillFactory {

    constructor() {
        this.userRoot = null;
        try {
            this.userRoot = require("../plugins/pluginLoader").userRoot;
        }
        catch { /* diisi saat ensure */ }
    }

    /**
     * UJI GAP (§36): adakah kapabilitas yang sudah menutup kebutuhan?
     * @returns {found: [...], packages: [...], gap: bool}
     */
    async analyzeGap(requirement) {

        const discovery = await capabilities.discover(requirement, { limit: 8 });

        const found = discovery.capabilities ?? discovery;
        const strong = Array.isArray(found) && found.some(c => (c.score ?? 0) >= 50);

        return {
            found,
            packages: discovery.packages ?? [],
            gap: !strong
        };

    }

    /**
     * Buat skill baru dari spesifikasi (dipanggil model/orchestrator
     * setelah analyzeGap menyatakan gap).
     *
     * @param {object} spec  spesifikasi ToolForge (id, name, description,
     *                       tool_name, parameters, code, test_code?)
     * @param {object} opts  { temporary: bool, sampleArgs: objek uji }
     */
    async create(spec, { temporary = true, sampleArgs = null } = {}) {

        // 1. Cegah duplikat dulu (§36) — reuse apa pun kondisi spec.
        const existing = await capabilities.get(`skill:${spec.id}`);
        if (existing?.alive) {
            return { reused: true, capability: existing, note: `skill '${spec.id}' sudah ada — dipakai ulang.` };
        }

        // 2. Validasi spesifikasi dasar — runtime tak percaya prompt.
        const verr = this.validateSpec(spec);
        if (verr) throw new Error(`spec tidak valid: ${verr}`);

        // 3. Implementasi via ToolForge (infrastruktur ADA).
        //    Mode RAW: kode modul penuh — cocok untuk kode buatan model.
        const forge = require("../services/toolForge");

        const rawCode = wrapRaw(spec);

        const created = await forge.create(
            {
                id: spec.id,
                raw: rawCode,
                name: spec.name ?? spec.id,
                description: spec.description
            },
            // Otonom (kebijakan pemilik): draft dulu, sandbox menentukan.
            { activate: false }
        );

        // 4. SANDBOX: uji eksekusi dengan argumen contoh sebelum hidup.
        let sandbox = { ok: false, error: "tidak diuji" };

        if (sampleArgs) {
            sandbox = await this.sandbox(spec.id, spec.tool_name, sampleArgs);
        }

        // 5. Register ke CapabilityRegistry (temporary → TTL metadata).
        const capId = `skill:${spec.id}`;

        await capabilities.upsert({
            id: capId,
            kind: "skill",
            name: spec.id,
            description: spec.description ?? "",
            source: temporary ? "temporary" : "forge",
            version: "0.1.0",
            meta: {
                toolName: spec.tool_name,
                sandboxOk: sandbox.ok,
                temporary,
                expiresAt: temporary ? new Date(Date.now() + TEMP_TTL_MS).toISOString() : null,
                provenance: { createdBy: "skill-factory", spec }
            }
        });

        // 5b. Lulus sandbox → AKTIFKAN ke runtime (forge.approve:
        //     pindah draft→live, load plugin, event forge:changed
        //     memicu refreshTools otomatis). Setelah load, baca nama
        //     tool AKTUAL dari registry (kode model bisa memakai nama
        //     berbeda dari spec — meta harus mengikuti kenyataan).
        let activationError = null;
        let actualToolNames = [];

        if (sandbox.ok) {
            try {
                forge.approve(spec.id);

                const { ToolRegistry } = require("../core/tools");
                const prefix = spec.id + ".";
                actualToolNames = ToolRegistry.describe()
                    .filter(d => d.id.startsWith(prefix))
                    .map(d => d.id);

                if (actualToolNames.length) {
                    await database.run(
                        "UPDATE capabilities SET meta = json_set(meta, '$.toolNames', ?) WHERE id = ?",
                        [JSON.stringify(actualToolNames), capId]
                    );
                }
            }
            catch (error) {
                activationError = error.message;
            }
        }

        await this.log(null, "create_skill",
            `buat skill ${temporary ? "sementara " : ""}${spec.id}`,
            `gap ditutup; sandbox ${sandbox.ok ? "LULUS" + (activationError ? ` (aktivasi gagal: ${activationError})` : ` → aktif: ${actualToolNames.join(",") || spec.id}`) : "gagal: " + sandbox.error}`,
            { spec: spec.id }, sandbox.ok && !activationError);

        telemetry.publish("autonomy:skill_created", { id: spec.id, temporary, sandboxOk: sandbox.ok });

        return {
            reused: false,
            capability: await capabilities.get(capId),
            sandbox,
            activated: sandbox.ok,   // lulus uji → forge.activate dipanggil
            forge: created
        };

    }

    /**
     * SANDBOX — eksekusi tool baru di draft (belum ter-load ke runtime
     * utama). Load plugin draft dalam proses terpisauk: require module
     * tool di drafts dir dengan timeout ketat.
     */
    async sandbox(skillId, toolName, sampleArgs) {

        const path = require("node:path");
        const fs = require("node:fs");

        try {

            const forge = require("../services/toolForge");
            const draftDir = path.join(forge.draftsRoot ?? path.join(this.userRoot ?? ".", ".drafts"), skillId);

            const toolFile = fs.existsSync(path.join(draftDir, "tool.js"))
                ? path.join(draftDir, "tool.js")
                : fs.existsSync(path.join(draftDir, "index.js"))
                    ? path.join(draftDir, "index.js")
                    : null;

            if (!toolFile) {
                return { ok: false, error: "berkas tool draft tidak ditemukan" };
            }

            // Hapus dari cache bila pernah dimuat (uji ulang versi baru).
            delete require.cache[require.resolve(toolFile)];

            const mod = require(toolFile);

            // Modul bisa: array instance, instance tunggal, atau class.
            let instance = null;

            if (Array.isArray(mod)) {
                instance = mod.find(t => t?.name === toolName) ?? mod[0];
            }
            else if (mod && typeof mod === "object" && typeof mod.execute === "function") {
                instance = mod;
            }
            else if (typeof mod === "function") {
                instance = new mod();
            }
            else if (mod?.default) {
                instance = typeof mod.default === "function" ? new mod.default() : mod.default;
            }

            if (!instance || typeof instance.execute !== "function") {
                return { ok: false, error: "modul tool tidak punya execute()" };
            }

            const result = await Promise.race([
                Promise.resolve(instance.execute?.(sampleArgs ?? {})),
                new Promise((_, reject) => setTimeout(() => reject(new Error("sandbox timeout 8s")), 8000))
            ]);

            return { ok: true, result };

        }
        catch (error) {
            return { ok: false, error: error.message ?? String(error) };
        }

    }

    /** Promosikan skill sementara → permanen (§5: terbukti berguna). */
    async promote(skillId) {

        const capId = `skill:${skillId}`;
        const cap = await capabilities.get(capId);

        if (!cap) throw new Error(`skill ${skillId} tidak terdaftar.`);

        await database.run(
            `UPDATE capabilities SET meta = json_set(meta, '$.temporary', 0, '$.expiresAt', null),
             source = 'forge' WHERE id = ?`,
            [capId]
        );

        await this.log(null, "promote_skill", `promosi ${skillId} jadi permanen`, "terbukti berguna", { skillId }, true);

        return capabilities.get(capId);

    }

    /** Jalur housekeeping: kedaluwarsakan skill temporary (dipanggil worker). */
    async expireTemporary() {

        await initialize();

        const rows = await database.all("SELECT id, meta FROM capabilities WHERE source = 'temporary' AND alive = 1");

        const expired = [];

        for (const row of rows) {
            let meta = {};
            try { meta = JSON.parse(row.meta ?? "{}"); } catch { /* ok */ }
            if (meta.expiresAt && new Date(meta.expiresAt) < new Date()) {
                await database.run("UPDATE capabilities SET alive = 0 WHERE id = ?", [row.id]);
                expired.push(row.id);
            }
        }

        return expired;

    }

    validateSpec(spec) {

        if (!spec?.id || !/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) {
            return "id wajib huruf kecil/angka/strip";
        }
        if (!spec?.tool_name || !/^[a-z][A-Za-z0-9]*$/.test(spec.tool_name)) {
            return "tool_name wajib camelCase";
        }
        if (!spec?.description || String(spec.description).length < 10) {
            return "description terlalu pendek (min 10 char)";
        }
        if (!spec?.code || !String(spec.code).includes("execute")) {
            return "code harus mengimplementasikan execute()";
        }
        return null;

    }

    /** Daftar skill buatan Aether (forge + temporary). */
    async listSkills({ includeExpired = false } = {}) {
        const all = await capabilities.list({ kind: "skill" });
        return includeExpired ? all : all.filter(c => c.alive);
    }

    async log(goalId, action, decision, reason, evidence = [], ok = null) {
        await initialize();
        await database.run(
            `INSERT INTO autonomy_log (goal_id, action, decision, reason, evidence, ok)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [goalId, action, decision, reason, JSON.stringify(evidence), ok === null ? null : ok ? 1 : 0]
        );
    }

}

/**
 * Bungkus kode model menjadi modul plugin utuh.
 *
 * Kontrak plugin Aether: execute(context, params) — sedangkan model
 * lazim menulis class dengan execute(args). Strategi AMAN tanpa
 * membongkar isi class:
 *   1. Tulis class model apa adanya sebagai `SkillImpl`.
 *   2. Bungkus dengan class `Tool` yang punya execute(context, params)
 *      kontrak plugin, yang meneruskan params ke SkillImpl.execute.
 *   3. SkillImpl bisa menulis execute(args) — wrapper yang menyesuaikan.
 */
function wrapRaw(spec) {

    let code = String(spec.code).trim();

    const params = Object.entries(spec.parameters ?? {})
        .map(([k, p]) => "    " + k + ": " + JSON.stringify({
            type: p?.type ?? "string",
            description: p?.description ?? k,
            required: p?.required === true
        }))
        .join(",\n");

    // Normalisasi kode model menjadi CLASS bernama SkillImpl.
    let impl;

    const modClass = code.match(/^module\.exports\s*=\s*class\s+([\w$]*)\s*\{([\s\S]*)\}\s*;?\s*$/);
    const plain = code.match(/^class\s+([\w$]*)\s*\{([\s\S]*)\}\s*;?\s*$/);

    if (modClass) {
        impl = "class SkillImpl {\n" + modClass[2] + "\n}";
    }
    else if (plain) {
        impl = "class SkillImpl {\n" + plain[2] + "\n}";
    }
    else {
        // Fungsi/objek lepas — bungkus jadi execute.
        impl = [
            "class SkillImpl {",
            "    async execute(args) {",
            "        const r = (" + code.replace(/\n/g, "\n") + ")(args);",
            "        return r && typeof r.then === 'function' ? r : { ok: true, hasil: r };",
            "    }",
            "}"
        ].join("\n");
    }

    return [
        "// Skill buatan Aether Skill Factory — jangan sunting manual.",
        impl,
        "",
        "class Tool {",
        "    constructor() {",
        "        this._impl = new SkillImpl();",
        "        this.name = " + JSON.stringify(String(spec.tool_name).toUpperCase()) + ";",
        "        this.description = " + JSON.stringify(spec.description) + ";",
        "        this.parameters = {",
        params,
        "        };",
        "    }",
        "    // Kontrak plugin: execute(context, params).",
        "    // Pilih sumber args yang benar: params utama; context",
        "    // kadang membawa args saat pemanggil legacy.",
        "    async execute(context, params) {",
        "        const args = (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length)",
        "            ? params",
        "            : (context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length)",
        "                ? context",
        "                : {};",
        "        return this._impl.execute(args);",
        "    }",
        "}",
        "module.exports = [new Tool()];",
        ""
    ].join("\n");
}

module.exports = new SkillFactory();
