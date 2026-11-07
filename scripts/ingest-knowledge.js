#!/usr/bin/env node

/**
 * Ingest basis pengetahuan AI/memory ke dalam memori dokumen Damar.
 *
 * Sumber (repo GitHub pemilik):
 *   - IAAR-Shanghai/Awesome-AI-Memory
 *   - gavischneider/awesome-llm-wiki
 *   - arturseo-geo/llm-knowledge-base
 *   - xoai/sage-wiki
 *   - synpulse8-opensource/pulse8-ai-cortex-knowledge-vault
 *
 * Tiap repo di-clone tipis (depth 1, tanpa blob Git) ke folder sementara,
 * lalu berkas markdown/teksnya dibaca DocumentService.ingestDirectory
 * (ekstraksi → chunk → simpan → embedding bila endpoint tersedia).
 *
 * Pemakaian:
 *   node scripts/ingest-knowledge.js            # semua repo
 *   node scripts/ingest-knowledge.js awesome    # yang cocok "awesome"
 *   --dry   # tampilkan rencana tanpa menulis
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REPOS = [
    { id: "awesome-ai-memory", url: "https://github.com/IAAR-Shanghai/Awesome-AI-Memory.git" },
    { id: "awesome-llm-wiki", url: "https://github.com/gavischneider/awesome-llm-wiki.git" },
    { id: "llm-knowledge-base", url: "https://github.com/arturseo-geo/llm-knowledge-base.git" },
    { id: "sage-wiki", url: "https://github.com/xoai/sage-wiki.git" },
    { id: "pulse8-cortex-vault", url: "https://github.com/synpulse8-opensource/pulse8-ai-cortex-knowledge-vault.git" }
];

const DRY = process.argv.includes("--dry");
const FILTER = process.argv.slice(2).find(a => !a.startsWith("--"));

function sh(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: "ignore", ...opts });
        child.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} gagal (${code})`)));
        child.on("error", reject);
    });
}

async function main() {

    const targets = REPOS.filter(r => !FILTER || r.id.includes(FILTER) || r.url.includes(FILTER));

    if (!targets.length) {
        console.log(`Tidak ada repo cocok "${FILTER}".`);
        process.exit(1);
    }

    const DocumentService = require("../src/memory/services/DocumentService");

    const tmpRoot = path.join(os.tmpdir(), "damar-knowledge");
    fs.mkdirSync(tmpRoot, { recursive: true });

    for (const repo of targets) {

        const dir = path.join(tmpRoot, repo.id);

        console.log(`\n=== ${repo.id} ===`);

        if (fs.existsSync(path.join(dir, ".git")) || fs.existsSync(dir)) {
            console.log("  sudah ada — pakai salinan lokal");
        }
        else {
            process.stdout.write("  clone… ");
            try {
                await sh("git", ["clone", "--depth", "1", "--filter=blob:none", repo.url, dir]);
                console.log("OK");
            }
            catch (error) {
                console.log(`GAGAL (${error.message}) — dilewati`);
                continue;
            }
        }

        if (DRY) {
            const files = countIngestable(dir);
            console.log(`  [dry] ${files} berkas markdown/teks akan dibaca`);
            continue;
        }

        try {
            const result = await DocumentService.ingestDirectory(dir, {
                maxFiles: 400,
                metadata: { source: "knowledge-repo", repo: repo.id, url: repo.url }
            });
            console.log(`  dibaca: ${result.ingested?.length ?? 0} dokumen` +
                (result.skipped?.length ? `, dilewati ${result.skipped.length}` : "") +
                (result.failed?.length ? `, gagal ${result.failed.length}` : ""));
        }
        catch (error) {
            console.log(`  ingest gagal: ${error.message}`);
        }

    }

    console.log("\nSelesai. Cari lewat Console → Memory → Dokumen, atau tanya Damar langsung.");

}

function countIngestable(dir) {
    let n = 0;
    const walk = d => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(md|markdown|txt|json|ya?ml)$/i.test(entry.name)) n++;
        }
    };
    walk(dir);
    return n;
}

main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
