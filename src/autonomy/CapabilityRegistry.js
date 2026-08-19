const { database, initialize } = require("../memory/db");

const toolBus = require("./ToolBus");
const telemetry = require("../services/telemetryService");

/**
 * CAPABILITY REGISTRY — pusat seluruh kapabilitas Aether (§35).
 *
 * Mendaftarkan SEMUA jenis kapabilitas: tool runtime, skill buatan
 * (forge/temporary), agent, model, instrumen Lab, connector eksternal.
 * Tiap kapabilitas punya: identitas, versi, health, reliability,
 * usage, trust — dipakai SkillFactory untuk mencegah duplikat (§36)
 * dan router untuk memilih yang terbaik (§39).
 *
 * Sumber kebenaran TETAP registry tool asli; tabel ini menyimpan
 * metadata & telemetri kapabilitas, bukan implementasinya.
 */

class CapabilityRegistry {

    /** Sinkronkan registry DB ↔ runtime (idempoten, dipanggil berkala). */
    async sync() {

        await initialize();

        const seen = new Set();

        // 1. Tool runtime nyata (AI + plugin).
        for (const t of toolBus.discover()) {
            seen.add(t.name);
            await this.upsert({
                id: `tool:${t.name}`,
                kind: "tool",
                name: t.name,
                description: t.description,
                source: t.source,
                version: "1.0.0"
            });
        }

        // 2. Agent (AgentHub).
        try {
            const agentHub = require("../services/agentHub");
            for (const a of agentHub.describe()) {
                const id = `agent:${a.id}`;
                seen.add(id);
                await this.upsert({
                    id, kind: "agent", name: a.id,
                    description: a.description ?? "",
                    source: "agenthub", version: "1.0.0",
                    meta: { skills: a.skills ?? [], kind: a.kind }
                });
            }
        }
        catch { /* agentHub opsional */ }

        // 3. Model (provider aktif).
        try {
            const aiRuntime = require("../services/aiRuntimeService");
            const info = aiRuntime.activeInfo?.() ?? {};
            if (info.model) {
                const id = `model:${info.model}`;
                seen.add(id);
                await this.upsert({
                    id, kind: "model", name: info.model,
                    description: info.platform ?? "",
                    source: "provider", version: "1.0.0"
                });
            }
        }
        catch { /* opsional */ }

        // 4. Skill buatan forge (userPlugins aktif + drafts).
        try {
            const pluginLoader = require("../plugins/pluginLoader");
            const user = pluginLoader.userRoot ?? "";
            const fs = require("node:fs");
            const path = require("node:path");
            if (user && fs.existsSync(user)) {
                for (const entry of fs.readdirSync(user, { withFileTypes: true })) {
                    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                    const manifest = path.join(user, entry.name, "manifest.json");
                    if (!fs.existsSync(manifest)) continue;
                    try {
                        const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
                        const id = `skill:${m.id ?? entry.name}`;
                        seen.add(id);
                        await this.upsert({
                            id, kind: "skill", name: m.id ?? entry.name,
                            description: m.description ?? "",
                            source: "forge", version: m.version ?? "0.1.0"
                        });
                    }
                    catch { /* manifest rusak — skip */ }
                }
            }
        }
        catch { /* opsional */ }

        // 5. Tandai hilang (tool dicabut) tanpa menghapus riwayat.
        const rows = await database.all("SELECT id FROM capabilities WHERE alive = 1");
        for (const row of rows) {
            if (!seen.has(row.id)) {
                await database.run("UPDATE capabilities SET alive = 0 WHERE id = ?", [row.id]);
            }
        }

        return seen.size;

    }

    async upsert({ id, kind, name, description = "", source, version = "1.0.0", meta = {} }) {

        await database.run(
            `INSERT INTO capabilities (id, kind, name, description, source, version, meta)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                version = excluded.version,
                meta = excluded.meta,
                alive = 1`,
            [id, kind, name, description, source, version, JSON.stringify(meta)]
        );

    }

    /**
     * DISCOVERY BERLAPIS (§36) — sebelum membuat skill baru, cek:
     *   1. registry DB (tool/skill/agent/model)
     *   2. telemetri ToolBus (tool pernah dipakai)
     *   3. paket terpasang (node_modules / global bin)
     * @returns kandidat terurut skor kecocokan
     */
    async discover(query, { limit = 12 } = {}) {

        await initialize();

        const q = String(query ?? "").toLowerCase().trim();

        if (!q) return await this.list({ alive: true, limit });

        const rows = await database.all("SELECT * FROM capabilities WHERE alive = 1");

        const scored = rows
            .map(c => ({ ...hydrate(c), score: matchScore(c, q) }))
            .filter(c => c.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        // Lapis 3: paket terpasang (via terminal tersedia, tidak dijalankan
        // di sini — dilaporkan sebagai kandidat "installable").
        const packages = findPackages(q);

        return { capabilities: scored, packages };

    }

    /** Catat hasil pemakaian — bahan trust score (§39). */
    async recordUsage(id, { ok, ms, error = null } = {}) {

        await initialize();

        await database.run(
            `UPDATE capabilities SET
                usage_count = usage_count + 1,
                success_count = success_count + CASE WHEN ? THEN 1 ELSE 0 END,
                failure_count = failure_count + CASE WHEN ? THEN 1 ELSE 0 END,
                total_ms = total_ms + ?,
                last_used_at = datetime('now'),
                last_error = ?
             WHERE id = ?`,
            [ok ? 1 : 0, ok ? 0 : 1, Math.round(ms ?? 0), error, id]
        );

        const row = await database.get("SELECT usage_count, success_count FROM capabilities WHERE id = ?", [id]);

        // Trust naik/turun eksponensial menuju tingkat kesuksesan nyata.
        if (row && row.usage_count > 0) {
            const trust = row.success_count / row.usage_count;
            await database.run("UPDATE capabilities SET trust = ? WHERE id = ?", [+trust.toFixed(3), id]);
        }

    }

    async list({ kind = null, alive = null, limit = 200 } = {}) {

        await initialize();

        const where = [];
        const params = [];

        if (kind) { where.push("kind = ?"); params.push(kind); }
        if (alive !== null) { where.push("alive = ?"); params.push(alive ? 1 : 0); }

        const rows = await database.all(
            `SELECT * FROM capabilities ${where.length ? "WHERE " + where.join(" AND ") : ""}
             ORDER BY usage_count DESC, name ASC LIMIT ?`,
            [...params, limit]
        );

        return rows.map(hydrate);

    }

    async get(id) {
        await initialize();
        const row = await database.get("SELECT * FROM capabilities WHERE id = ?", [id]);
        return row ? hydrate(row) : null;
    }

}

function matchScore(cap, q) {

    const name = (cap.name ?? "").toLowerCase();
    const desc = (cap.description ?? "").toLowerCase();
    const id = (cap.id ?? "").toLowerCase();

    let score = 0;

    if (name === q) score += 100;
    if (name.includes(q)) score += 50;
    if (id.includes(q)) score += 20;
    for (const word of q.split(/\s+/)) {
        if (word.length >= 3 && desc.includes(word)) score += 8;
        if (word.length >= 3 && name.includes(word)) score += 12;
    }

    return score;

}

/** Paket npm global/bin yang relevan (heuristik nama — tanpa eksekusi). */
function findPackages(query) {

    const hints = [
        { q: /pdf|document/, pkg: ["pdf-parse", "mammoth"] },
        { q: /image|ocr|vision/, pkg: ["tesseract.js", "sharp"] },
        { q: /excel|sheet|spread/, pkg: ["xlsx", "exceljs"] },
        { q: /csv|data/, pkg: ["papaparse", "csv-parse"] },
        { q: /email|imap/, pkg: ["nodemailer", "imapflow"] },
        { q: /browser|scrape/, pkg: ["playwright", "puppeteer"] },
        { q: /qr|barcode/, pkg: ["qrcode", "jsbarcode"] },
        { q: /audio|sound|speech/, pkg: ["sox", "whisper.cpp"] }
    ];

    const out = [];
    for (const h of hints) {
        if (h.q.test(query)) out.push(...h.pkg);
    }

    return out.slice(0, 6);

}

function hydrate(row) {
    let meta = {};
    try { meta = JSON.parse(row.meta ?? "{}"); } catch { /* ok */ }
    return {
        id: row.id, kind: row.kind, name: row.name,
        description: row.description, source: row.source,
        version: row.version, meta, alive: !!row.alive,
        trust: row.trust, usageCount: row.usage_count,
        successCount: row.success_count, failureCount: row.failure_count,
        totalMs: row.total_ms, lastUsedAt: row.last_used_at,
        lastError: row.last_error
    };
}

module.exports = new CapabilityRegistry();
