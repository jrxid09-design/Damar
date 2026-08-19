#!/usr/bin/env node

const buildMemory = require("../src/memory/buildMemory");

/**
 * Ajari Aether tentang dirinya sendiri.
 *
 * Setiap kali kita mengubah atau mengonfigurasi Aether, catatannya
 * masuk ke memori Aether lewat sini — sehingga ia tahu bagaimana ia
 * dibangun, bukan hanya keadaannya sekarang.
 *
 * Dijalankan manusia (atau agen yang sedang mengerjakan Aether),
 * bukan oleh Aether sendiri saat melayani permintaan.
 *
 *   node scripts/learn.js \
 *     --area keselamatan \
 *     --change "terminal_run dinaikkan ke L5" \
 *     --why "eksekusi perintah sembarang; kemampuan sama tak boleh punya dua tingkat izin" \
 *     --files src/core/safety/riskCatalog.js \
 *     --verified "model mencoba terminal_run di daemon, ditolak SAFETY_RISK_BLOCKED" \
 *     --risks "klasifikasi ditetapkan dari deskripsi, belum dari pengamatan efek samping"
 *
 * Atau dari berkas JSON berisi satu objek / larik objek:
 *
 *   node scripts/learn.js --file docs/journal/2026-08-12.json
 *
 * Tambahkan --dry untuk melihat tanpa menyimpan.
 */

function parseArgs(argv) {

    const out = {};

    for (let i = 0; i < argv.length; i++) {

        const token = argv[i];

        if (!token.startsWith("--")) continue;

        const key = token.slice(2);

        // Flag tanpa nilai (mis. --dry) diikuti token lain atau habis.
        const next = argv[i + 1];

        if (next === undefined || next.startsWith("--")) {
            out[key] = true;
            continue;
        }

        // `--files a.js --files b.js` menumpuk menjadi larik.
        if (out[key] === undefined) out[key] = next;
        else out[key] = [].concat(out[key], next);

        i += 1;

    }

    return out;

}

function normalise(entry) {

    const files = entry.files
        ? [].concat(entry.files).flatMap(f => String(f).split(",")).map(f => f.trim()).filter(Boolean)
        : [];

    return {
        area: entry.area || null,
        change: entry.change,
        why: entry.why,
        files,
        verification: entry.verification ?? entry.verified ?? null,
        risks: entry.risks ?? null
    };

}

async function main() {

    const args = parseArgs(process.argv.slice(2));

    let entries = [];

    if (args.file) {

        const isi = require("node:fs").readFileSync(args.file, "utf8");
        const parsed = JSON.parse(isi);

        entries = (Array.isArray(parsed) ? parsed : [parsed]).map(normalise);

    }
    else if (args.change && args.why) {
        entries = [normalise(args)];
    }
    else {
        console.error(
            "Perlu --change dan --why, atau --file berisi JSON.\n" +
            "Lihat komentar di scripts/learn.js untuk contoh."
        );
        process.exitCode = 1;
        return;
    }

    let tersimpan = 0;

    for (const entry of entries) {

        if (args.dry) {
            console.log("— (uji kering)\n" + JSON.stringify(entry, null, 2));
            continue;
        }

        const res = await buildMemory.record(entry);

        if (res.ok) {
            tersimpan += 1;
            console.log(`✓ #${res.id}  ${entry.area ? `[${entry.area}] ` : ""}${entry.change.slice(0, 70)}`);
        }
        else {
            console.log(`✗ dilewati — ${res.note}`);
        }

    }

    if (!args.dry) {
        console.log(`\n${tersimpan} catatan masuk ke memori Aether.`);
    }

}

main().catch(error => {
    console.error(`Gagal: ${error.message}`);
    process.exitCode = 1;
});
