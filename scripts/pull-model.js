#!/usr/bin/env node
/**
 * Unduh bobot model lokal (GGUF) untuk otak in-process Aether.
 *
 *   node scripts/pull-model.js                 # model bawaan (Qwen2.5-7B Q4_K_M)
 *   node scripts/pull-model.js <url-gguf>      # model lain
 *
 * Bawaan dipilih untuk mesin CPU: pintar merespons + tool-calling kuat
 * di kelasnya, ~4,7 GB. Unduhan bisa dilanjut (resume) bila terputus.
 */
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_URL =
    "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf";

async function main() {

    const url = process.argv[2] || DEFAULT_URL;
    const dir = path.resolve(process.env.AETHER_MODEL_DIR || "models");
    fs.mkdirSync(dir, { recursive: true });

    const { createModelDownloader } = await import("node-llama-cpp");

    console.log(`Mengunduh model ke ${dir} …\n${url}\n`);

    const downloader = await createModelDownloader({
        modelUrl: url,
        dirPath: dir,
        showCliProgress: true
    });

    const file = await downloader.download();

    console.log(`\nSelesai: ${file}`);
    console.log("Aktifkan sebagai otak Aether: set AI_PROVIDER=llamacpp (atau pilih di Console → Settings).");
}

main().catch(err => {
    console.error("Gagal mengunduh model:", err.message);
    process.exit(1);
});
