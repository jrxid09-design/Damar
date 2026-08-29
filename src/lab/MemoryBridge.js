const projects = require("./ProjectEngine");
const activity = require("./ActivityLog");

/**
 * MemoryBridge — memori & pengetahuan yang project-aware (§16-§17).
 *
 * Distingsi:
 *   MEMORY   = apa yang Damar ingat tentang project/user/sejarah.
 *   KNOWLEDGE= apa yang Damar KETAHUI (dokumen, repo, riset).
 *
 * Jalur tulis memakai MemoryEngine yang ADA dengan scope=projectId —
 * tanpa gerbang persetujuan (kebijakan pemilik). Pentingnya memori
 * dihitung dari konteks (keputusan > obrolan).
 */

class MemoryBridge {

    /**
     * Catat fakta/keputusan/pelajaran project ke memori jangka panjang.
     * type: decision|architecture|constraint|lesson|failed-approach|fact|preference
     */
    async remember(projectId, { type = "fact", content, importance = null }) {

        const engine = require("../memory/core/MemoryEngine");

        const weight = {
            decision: 0.9, architecture: 0.85, constraint: 0.8,
            lesson: 0.75, "failed-approach": 0.7, fact: 0.6, preference: 0.6
        }[type] ?? 0.6;

        const saved = await engine.remember(
            content,
            {
                type: "semantic",
                importance: importance ?? weight,
                metadata: { lab: true, labType: type, projectId }
            },
            { writer: "lab", scope: `lab:${projectId}` }
        );

        await activity.record({
            type: "memory.updated", projectId,
            payload: { memoryId: saved?.id, type, content: String(content).slice(0, 80) }
        });

        return saved;

    }

    /** Ingat kembali dalam scope project. */
    async recall(projectId, query, { limit = 6 } = {}) {

        const engine = require("../memory/core/MemoryEngine");

        const result = await engine.recall(query, { limit: limit * 2 });

        // Utamakan memori bertanda project ini.
        const items = (result?.items ?? []).map(m => ({
            id: m.id,
            content: m.content,
            importance: m.importance,
            projectId: m.metadata?.projectId ?? null,
            inProject: m.metadata?.projectId === projectId
        }));

        const scoped = items.filter(i => i.inProject);
        const rest = items.filter(i => !i.inProject);

        return { items: [...scoped, ...rest].slice(0, limit), scoped: scoped.length };

    }

    /**
     * Masukkan pengetahuan baru ke project (dokumen/teks/repo path).
     * Pakai DocumentService yang ADA — knowledge = dokumen terindeks.
     */
    async ingestKnowledge(projectId, { text = null, path = null, title = null }) {

        const DocumentService = require("../memory/services/DocumentService");

        const project = await projects.get(projectId);
        if (!project) throw new Error(`Project ${projectId} tidak ditemukan.`);

        let doc;

        if (text) {
            doc = await DocumentService.ingestText({
                uri: `lab://${projectId}/${Date.now()}`,
                title: title ?? `Lab knowledge ${new Date().toISOString().slice(0, 10)}`,
                content: text,
                metadata: { lab: true, projectId }
            });
        }
        else if (path) {
            doc = await DocumentService.ingestFile(path, {
                title, metadata: { lab: true, projectId }
            });
        }
        else {
            throw new Error("Sertakan 'text' atau 'path'.");
        }

        await activity.record({
            type: "knowledge.updated", projectId,
            payload: { documentId: doc?.id, title: doc?.title }
        });

        return doc;

    }

    /** Ringkasan memori + knowledge project. */
    async summary(projectId) {

        const { database } = require("../memory/db");

        const [mem, docs] = await Promise.all([
            database.all(
                `SELECT id, content, importance, metadata FROM memories
                 WHERE metadata LIKE ? ORDER BY importance DESC LIMIT 50`,
                [`%"projectId":"${projectId}"%`]
            ).catch(() => []),
            database.all(
                "SELECT id, title, uri FROM documents WHERE metadata LIKE ? LIMIT 50",
                [`%"projectId":"${projectId}"%`]
            ).catch(() => [])
        ]);

        return {
            memories: mem.map(m => ({
                id: m.id,
                content: m.content,
                importance: m.importance,
                metadata: safeJson(m.metadata, {})
            })),
            knowledge: docs
        };

    }

}

function safeJson(t, f) { try { return JSON.parse(t ?? "") ?? f; } catch { return f; } }

module.exports = new MemoryBridge();
