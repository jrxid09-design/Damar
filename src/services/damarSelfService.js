const fs = require("node:fs");
const path = require("node:path");

const { isValidProposalId } = require("../authority/model");

/**
 * DAMARSELF SERVICE — satu resolver path kanonik (§Migration rule 5).
 *
 * CANONICAL dir = <repoRoot>/DamarSelf (di-commit; identitas/jurnal/
 * konstitusi/self-model/evolution docs).
 *
 * TIDAK ADA lokasi kedua yang dianggap kanonik. migrateFromLegacy()
 * hanya menyalin byte-exact saat canonical kosong, lalu menandai folder
 * legacy dengan MIGRATED.md (best-effort) agar tidak jadi sumber ganda.
 *
 * SEMANTIC SEPARATION (load-bearing): seluruh isi DamarSelf adalah
 * NARASI/pemahaman diri - BUKAN sumber otorisasi. Otoritas hanya lahir
 * dari src/authority (CapabilityGrant + OwnerRatification).
 */

const DEFAULT_CANONICAL_DIR =
    path.resolve(__dirname, "..", "..", "DamarSelf");

const REQUIRED_SUBDIRS = [
    ["constitution"],
    ["self-model"],
    ["evolution", "proposals"],
    ["evolution", "experiments"],
    ["evolution", "approved"],
    ["evolution", "rejected"]
];

function createDamarSelfService({
    canonicalDir = process.env.DAMARSELF_DIR ?? DEFAULT_CANONICAL_DIR,
    legacyDir = null,
    clock = null
} = {}) {

    const nowIso = () => clock ? clock.nowIso() : new Date().toISOString();

    function resolveCanonical() {
        return canonicalDir;
    }

    /**
     * ADOPSI DIREKTORI LAMA — AetherSelf → DamarSelf (§rename).
     *
     * Kontinuitas autobiografis TIDAK BOLEH putus karena rename.
     * Setiap berkas di direktori lama yang BELUM ada di kanonik
     * disalin apa adanya; yang sudah ada tidak pernah ditimpa —
     * jadi jurnal append-only tetap utuh sebagai prefix.
     *
     * Idempoten: pemanggilan kedua tidak menyalin apa pun lagi.
     * Direktori lama ditandai MIGRATED.md agar tidak menjadi sumber
     * kanonik kedua.
     */
    function adoptLegacySelfDir(legacyPath = defaultLegacyDir()) {

        if (!legacyPath || !fs.existsSync(legacyPath)) return [];
        if (path.resolve(legacyPath) === path.resolve(canonicalDir)) return [];

        const copied = [];

        const walk = (fromDir, toDir) => {
            for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
                if (entry.name === "MIGRATED.md") continue;
                const from = path.join(fromDir, entry.name);
                const to = path.join(toDir, entry.name);
                if (entry.isDirectory()) {
                    fs.mkdirSync(to, { recursive: true });
                    walk(from, to);
                }
                else if (entry.isFile() && !fs.existsSync(to)) {
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    fs.copyFileSync(from, to);
                    copied.push(path.relative(canonicalDir, to));
                }
            }
        };

        fs.mkdirSync(canonicalDir, { recursive: true });
        walk(legacyPath, canonicalDir);

        try {
            fs.writeFileSync(path.join(legacyPath, "MIGRATED.md"),
                "# MIGRATED\n\nDamarSelf kanonik kini:\n" +
                `${canonicalDir}\n\nFolder ini adalah arsip dari masa ` +
                "ketika sistem bernama Aether; tidak lagi dipakai runtime.\n",
                "utf8");
        } catch { /* read-only media: marker opsional */ }

        return copied;

    }

    /** Struktur minimal idempoten; file seed dibuat hanya bila absen. */
    function ensureStructure() {
        // Adopsi lebih dulu: seed tidak boleh menutupi narasi lama.
        //
        // HANYA lokasi IMPLISIT (saudara `AetherSelf`) yang diadopsi
        // otomatis. `legacyDir` yang diberikan pemanggil tetap jalur
        // EKSPLISIT lewat migrateFromLegacy() — supaya laporan
        // `copied` milik pemanggil tidak dicuri oleh adopsi otomatis.
        try { adoptLegacySelfDir(implicitLegacyDir()); }
        catch { /* adopsi best-effort; struktur tetap dibuat */ }
        for (const parts of REQUIRED_SUBDIRS) {
            fs.mkdirSync(path.join(canonicalDir, ...parts), { recursive: true });
        }
        const seeds = [
            [path.join(canonicalDir, "README.md"),
             damarSelfReadme()],
            [path.join(canonicalDir, "constitution", "principles.md"),
             principlesSeed()],
            [path.join(canonicalDir, "self-model", "capabilities.md"),
             "# Capabilities (self-perception)\n\n- Diisi oleh Damar; BUKAN state otorisasi.\n"],
            [path.join(canonicalDir, "self-model", "limitations.md"),
             "# Limitations (self-perception)\n\n- Diisi oleh Damar.\n"],
            [path.join(canonicalDir, "self-model", "goals.md"),
             "# Goals (self-perception)\n\n- Diisi oleh Damar.\n"]
        ];
        for (const [file, content] of seeds) {
            if (!fs.existsSync(file)) {
                fs.writeFileSync(file, content, "utf8");
            }
        }
    }

    /**
     * Migrasi dari lokasi legacy: identity.md & journal.md disalin
     * BYTE-EXACT bila canonical belum memilikinya. Tidak pernah
     * menimpa konten canonical yang sudah ada.
     */
    function migrateFromLegacy(legacyPath) {

        ensureStructure();

        const copied = [];
        for (const name of ["identity.md", "journal.md"]) {
            const src = path.join(legacyPath, name);
            const dst = path.join(canonicalDir, name);
            if (!fs.existsSync(src)) continue;
            if (fs.existsSync(dst)) continue;      // jangan timpa
            fs.copyFileSync(src, dst);
            copied.push(name);
        }

        // Marker di lokasi legacy (best-effort) supaya tidak menjadi
        // sumber kanonik kedua:
        try {
            fs.writeFileSync(path.join(legacyPath, "MIGRATED.md"),
                "# MIGRATED\n\nCanonical DamarSelf kini:\n" +
                `${canonicalDir}\n\nFile di folder ini adalah arsip ` +
                "dan tidak lagi dipakai runtime.\n",
                "utf8");
        } catch { /* read-only media: marker opsional */ }

        // Verifikasi byte-exact untuk yang disalin:
        for (const name of copied) {
            const a = fs.readFileSync(path.join(legacyPath, name));
            const b = fs.readFileSync(path.join(canonicalDir, name));
            if (!a.equals(b)) {
                throw new Error(
                    `MIGRASI GAGAL: ${name} tidak identik setelah salin`);
            }
        }

        return { copied, canonicalDir };
    }

    /** Baca utuh (buffer) — dipakai tes byte-exactness. */
    function readIdentityBytes() {
        return fs.readFileSync(path.join(canonicalDir, "identity.md"));
    }
    function readJournalBytes() {
        return fs.readFileSync(path.join(canonicalDir, "journal.md"));
    }

    /**
     * APPEND-ONLY journal: konten lama wajib tetap identik sebagai prefix;
     * pelanggaran = gagal sebelum menulis (§PAST EXPERIENCE PRESERVED).
     */
    function appendJournal({ at, text }) {

        const file = path.join(canonicalDir, "journal.md");
        const before = fs.readFileSync(file);

        const block = `\n[${at ?? nowIso()}] ${String(text).replace(/\r?\n/g, "\n")}\n`;

        fs.writeFileSync(file,
            Buffer.concat([before, Buffer.from(block, "utf8")]));

        const after = fs.readFileSync(file);
        if (!after.subarray(0, before.length).equals(before)) {
            fs.writeFileSync(file, before);      // rollback
            throw new Error(
                "PELANGGARAN JURNAL: penulisan mengubah entri lama (rollback).");
        }

        return after.length;

    }

    /** Konstitusi versioned; perubahan material butuh ratifikasi owner. */
    function writeConstitutionPrinciples(body, { version, reason,
                                                 ratificationId = null }) {
        const file = path.join(canonicalDir, "constitution", "principles.md");
        const header =
            `<!-- constitution-version:${version} ` +
            `ratification:${ratificationId ?? "-"} ` +
            `reason:${String(reason ?? "").slice(0, 120)} -->\n`;
        fs.writeFileSync(file, header + body + "\n", "utf8");
        return { version, file };
    }

    function readConstitutionVersion() {
        const file = path.join(canonicalDir, "constitution", "principles.md");
        if (!fs.existsSync(file)) return null;
        const m = fs.readFileSync(file, "utf8")
            .match(/constitution-version:(\d+)/);
        return m ? Number(m[1]) : null;
    }

    /**
     * Tulis EvolutionProposal ke folder evolution/proposals (dokumen).
     *
     * PATH-SAFETY (dua lapis, §path-safety):
     *   1. proposalId wajib slug aman (validasi model).
     *   2. Boundary filesystem: target di-resolve dan diverifikasi tetap
     *      DI DALAM direktori proposals kanonik — tidak cukup bergantung
     *      pada path.join.
     */
    function writeEvolutionProposalDoc(proposal) {
        if (!isValidProposalId(proposal?.proposalId)) {
            throw new Error(
                `proposalId tidak sah (slug [a-z0-9._-], maks 120): ` +
                `'${String(proposal?.proposalId ?? "").slice(0, 80)}'`);
        }

        const dir = path.resolve(canonicalDir, "evolution", "proposals");
        fs.mkdirSync(dir, { recursive: true });

        const resolved = path.resolve(dir, `${proposal.proposalId}.md`);
        const rel = path.relative(dir, resolved);
        if (rel === "" || rel.startsWith("..") ||
            path.isAbsolute(rel) || resolved.startsWith(`${dir}.`)) {
            throw new Error(
                "PERLANGKARAN PATH: proposalId keluar dari direktori " +
                "proposals DamarSelf — penulisan ditolak.");
        }

        const body = [
            `# EvolutionProposal ${proposal.proposalId}`,
            `- createdBy : ${proposal.createdBy}`,
            `- kind      : ${proposal.kind}`,
            `- revision  : ${proposal.revision}`,
            `- digest    : ${proposal.digest}`,
            `- status    : ${proposal.status}`,
            "",
            "## Problem", proposal.problem,
            "## Hypothesis", proposal.hypothesis || "(tidak ada)",
            "## ProposedChange", proposal.proposedChange,
            "## Risk", proposal.risk || "(tidak disebutkan)",
            "## RollbackPlan", proposal.rollbackPlan || "(wajib untuk material)",
            "## RequiredCapabilities",
            ...(proposal.requiredCapabilities ?? []).map(c => `- ${c}`)
        ].join("\n");
        fs.writeFileSync(resolved, body + "\n", "utf8");
        return resolved;
    }

    /**
     * Lokasi direktori EJAAN LAMA yang layak diadopsi.
     *
     * Urutan: `legacyDir` eksplisit → `AETHERSELF_DIR` (bila memang
     * menunjuk tempat lain) → saudara kanonik bernama `AetherSelf`.
     * Mengembalikan null bila hasilnya sama dengan kanonik.
     */
    function implicitLegacyDir() {
        const kandidat =
            process.env.AETHERSELF_DIR
            ?? path.resolve(path.dirname(canonicalDir), "AetherSelf");
        return path.resolve(kandidat) === path.resolve(canonicalDir)
            ? null
            : kandidat;
    }

    function defaultLegacyDir() {
        return legacyDir ?? implicitLegacyDir();
    }

    return {
        resolveCanonical, ensureStructure, migrateFromLegacy,
        adoptLegacySelfDir, defaultLegacyDir,
        readIdentityBytes, readJournalBytes, appendJournal,
        writeConstitutionPrinciples, readConstitutionVersion,
        writeEvolutionProposalDoc
    };

}

function damarSelfReadme() {
    return [
        "# DamarSelf (CANONICAL)",
        "",
        "Folder ini adalah SATU-SATUNYA lokasi kanonik DamarSelf.",
        "",
        "| Path | Arti | Sifat |",
        "|---|---|---|",
        "| identity.md | narasi diri saat ini | evolvable, provenance-aware, BUKAN otoritas |",
        "| journal.md | autobiografi append-only | entri lama tidak ditulis ulang |",
        "| constitution/principles.md | prinsip | versioned, amandemen butuh ratifikasi owner |",
        "| self-model/* | proyeksi pemahaman diri | BUKAN permission state |",
        "| evolution/* | siklus usulan perubahan | proposals/experiments/approved/rejected |",
        "",
        "ATURAN LOAD-BEARING:",
        "- Isi folder ini TIDAK memberikan otoritas apa pun.",
        "- Klaim di sini boleh menjadi bahan EvolutionProposal /",
        "  AuthorityExpansionRequest; otoritas nyata hanya lahir dari",
        "  OwnerRatification via src/authority.",
        "",
        "Runtime DB/cache/embeddings TIDAK boleh ditaruh di sini."
    ].join("\n") + "\n";
}

function principlesSeed() {
    return "<!-- constitution-version:1 -->\n" +
        "# Principles v1\n\n" +
        "1. Kejujuran di atas pujian.\n" +
        "2. Bukti di atas klaim.\n" +
        "3. Pemilik memutuskan transisi besar; Damar mengusulkan & menjalankan.\n" +
        "4. Kognisi tidak pernah memberi otoritas.\n";
}

module.exports = { createDamarSelfService, DEFAULT_CANONICAL_DIR };
