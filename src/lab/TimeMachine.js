const fs = require("node:fs");
const path = require("node:path");

const { database, initialize } = require("../memory/db");

const activity = require("./ActivityLog");

/**
 * TimeMachine — snapshot non-destruktif (§23 MVP).
 *
 * Snapshot menyimpan REFERENSI keadaan (git commit, misi, artefak,
 * keputusan, memori), BUKAN rollback destruktif. Data model & timeline
 * dulu; pemulihan menyusul bila dibutuhkan.
 */

class TimeMachine {

    async snapshot({ projectId, label = null }) {

        await initialize();

        const project = await database.get("SELECT * FROM lab_projects WHERE id=?", [projectId]);
        if (!project) throw new Error(`Project ${projectId} tidak ditemukan.`);

        // Git commit saat ini (bila ada .git) — best effort, dibaca dari metadata
        // git (lihat readGitCommit), bukan dengan menjalankan proses.
        let gitCommit = null;
        try { gitCommit = readGitCommit(project.dir); }
        catch { /* bukan repo git — tetap snapshot */ }

        const [missions, artifacts, decisions] = await Promise.all([
            database.all("SELECT id, status, progress FROM lab_missions WHERE project_id=?", [projectId]),
            database.all("SELECT id FROM lab_artifacts WHERE project_id=?", [projectId]),
            database.all("SELECT id FROM lab_decisions WHERE project_id=?", [projectId])
        ]);

        const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        await database.run(
            `INSERT INTO lab_snapshots (id, project_id, label, git_commit, mission_states, artifact_ids, decision_ids, memory_refs)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, projectId, label, gitCommit,
             JSON.stringify(missions), JSON.stringify(artifacts.map(a => a.id)),
             JSON.stringify(decisions.map(d => d.id)), "[]"]
        );

        await activity.record({
            type: "project.updated", projectId,
            payload: { snapshot: id, label, gitCommit }
        });

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM lab_snapshots WHERE id=?", [id]);

        return row ? hydrate(row) : null;

    }

    async list(projectId, { limit = 30 } = {}) {

        await initialize();

        const rows = await database.all(
            "SELECT * FROM lab_snapshots WHERE project_id=? ORDER BY id DESC LIMIT ?",
            [projectId, limit]
        );

        return rows.map(hydrate);

    }

}

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// git menerima heksadesimal huruf besar tetapi selalu MENCETAK huruf kecil
// (`git rev-parse HEAD` atas ref huruf besar menghasilkan oid huruf kecil),
// jadi hasilnya disamakan dengan cetakan git: menolak huruf besar berarti
// kehilangan commit yang git laporkan, mengembalikannya apa adanya berarti
// berbeda dari git hanya pada huruf.
//
// Panjangnya juga harus cocok dengan format objek repo: git menolak oid 64
// heks di repo sha1, dan sebaliknya (diukur dengan git 2.55: `rev-parse`
// gagal di kedua arah).
function commitHash(value, hexLength) {
    return value.length === hexLength && HASH.test(value) ? value.toLowerCase() : null;
}

// Panjang oid yang dipakai repo: `git init --object-format=sha256` menuliskan
// `[extensions] objectformat = sha256` ke config, dan hanya di sana git
// mencarinya. Tanpa config yang terbaca, git sendiri memakai sha1.
function objectIdHexLength(commonDir) {
    try {
        const config = fs.readFileSync(path.join(commonDir, "config"), "utf8");
        let inExtensions = false;
        let inCore = false;
        let repositoryFormatVersion = 0;
        let objectFormat = null;
        for (const line of config.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
            const section = /^\[([^\]]+)\]/.exec(trimmed);
            if (section) {
                inExtensions = section[1].trim().toLowerCase() === "extensions";
                inCore = section[1].trim().toLowerCase() === "core";
                continue;
            }
            const setting = /^\s*([^=\s]+)\s*=\s*(.*)$/i.exec(line);
            if (!setting) continue;
            const key = setting[1].toLowerCase();
            let rawValue = setting[2].trim();
            let quote = null;
            for (let i = 0; i < rawValue.length; i++) {
                const ch = rawValue[i];
                if (quote) {
                    if (ch === quote) {
                        let slashes = 0;
                        for (let j = i - 1; j >= 0 && rawValue[j] === "\\"; j--) slashes++;
                        if (slashes % 2 === 0) quote = null;
                    }
                }
                else if (ch === "\"" || ch === "'") quote = ch;
                else if (ch === "#" || ch === ";") {
                    rawValue = rawValue.slice(0, i).trim();
                    break;
                }
            }
            const value = rawValue.replace(/^["']|["']$/g, "").toLowerCase();
            if (inCore && key === "repositoryformatversion" && /^\d+$/.test(value)) {
                repositoryFormatVersion = Number(value);
            }
            if (inExtensions && key === "objectformat") objectFormat = value;
        }
        return repositoryFormatVersion >= 1 && objectFormat === "sha256" ? 64 : 40;
    }
    catch { return 40; }
}

// Nama ref harus sah menurut git sebelum berkasnya dicari (check_refname_format,
// diukur lewat `git check-ref-format` dan `git rev-parse`): komponen kosong,
// komponen yang mulai ".", komponen yang berakhir "." atau ".lock", "..", "@{",
// serta karakter `~ ^ : ? * [ \`, spasi dan kontrol — semuanya ditolak git.
// Diukur: `refs/heads/x.locked`, `refs/heads/x@y`, `refs/heads/x-y_z` tetap sah.
//
// Target `HEAD` wajib di bawah "refs/" (validate_headref: `ref: refs2` gagal),
// sedangkan target symref yang lebih dalam boleh nama satu tingkat (diukur:
// `ref: refs2` di dalam berkas ref diselesaikan git).
const INVALID_REF_CHARS = /[\x00-\x20\x7f~^:?*\[\\]/;

function refNameValid(name, mustBeUnderRefs) {
    if (mustBeUnderRefs && !name.startsWith("refs/")) return false;
    if (name === "@") return false;
    if (INVALID_REF_CHARS.test(name) || name.includes("..") || name.includes("@{")) return false;
    return name.split("/").every(part => part && part[0] !== "." && !part.endsWith(".") && !part.endsWith(".lock"));
}

// Pseudo-ref yang memang privat per-worktree; sisanya (refs/heads/*, refs/tags/*, ...)
// tinggal di common dir.
const WORKTREE_PRIVATE_REF = /^refs\/(?:bisect|worktree|rewritten)\//;

// git sendiri berhenti pada rantai symbolic ref yang lebih dalam dari ini
// ("too many levels of symbolic refs"), jadi batasnya disamakan: rantai yang
// git tolak harus menghasilkan null di sini juga, bukan hash yang lebih benar
// daripada git.
const MAX_REF_DEPTH = 4;

/**
 * Commit HEAD sebuah working tree, dibaca langsung dari metadata git.
 *
 * Sebelumnya ini `execSync("git rev-parse HEAD", { cwd })`: sebuah proses
 * dijalankan hanya untuk membaca satu referensi. Snapshot adalah operasi
 * BACA, jadi jalur yang benar bukan memberinya otoritas eksekusi,
 * melainkan berhenti mengeksekusi: `.git/HEAD` (atau file `gitdir:`,
 * untuk worktree/submodule) dibaca apa adanya.
 *
 * Best effort seperti sebelumnya: null bila bukan repo git, HEAD belum
 * punya commit, atau isinya tidak dikenali.
 */
function readGitCommit(dir) {

    const dotGit = path.join(dir, ".git");
    let gitDir = dotGit;

    try {
        if (!fs.statSync(dotGit).isDirectory()) {
            // git membaca berkas `gitdir:` sebagai string C: isinya berhenti di
            // NUL pertama (diukur: `gitdir: <path><NUL>` tetap diselesaikan).
            // Setelah "gitdir: " hanya akhir baris yang dibuang — satu "\n",
            // lalu satu "\r" — bukan spasi: "gitdir: X ", "gitdir:  X",
            // "gitdir:\tX" dan "gitdir:refs/heads/x" ditolak git (diukur
            // dengan git 2.55, `git rev-parse HEAD` gagal di semuanya).
            const raw = fs.readFileSync(dotGit, "utf8").split("\0")[0];
            if (!raw.startsWith("gitdir: ")) return null;
            gitDir = path.resolve(dir, raw.slice("gitdir: ".length).replace(/\r?\n$|\r$/, ""));
        }
    }
    catch {
        // Tanpa `.git`: direktori ini sendiri mungkin git dir (repo bare) —
        // `git rev-parse HEAD` dulu juga bekerja di sana.
        gitDir = dir;
    }

    // Worktree tertaut (`git worktree add`): HEAD tinggal di direktori worktree,
    // tetapi ref-nya tinggal di COMMON dir yang ditunjuk berkas `commondir`.
    // Tanpa ini snapshot dari worktree kehilangan commit-nya.
    let commonDir = gitDir;
    try {
        const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
        if (common) commonDir = path.resolve(gitDir, common);
    }
    catch { /* repo biasa/bare: ref memang ada di git dir itu sendiri */ }

    // git hanya mengakui direktori yang berbentuk repo: `objects` dan `refs`
    // harus ADA di common dir (salah satu hilang dan git menolak seluruh
    // direktori itu). Diukur dengan git 2.55: tidak ada salah satunya -> gagal,
    // tetapi berbentuk berkas biasa -> tetap diterima, jadi yang diuji
    // keberadaannya saja. Tanpa cek ini git dir sisa/rusak — mis. isinya
    // terhapus sebagian — melaporkan commit yang git sendiri tolak, padahal
    // kontraknya null untuk bukan-repo.
    for (const part of ["objects", "refs"]) {
        if (!fs.existsSync(path.join(commonDir, part))) return null;
    }

    let head;
    // Hanya spasi di BELAKANG yang dibuang git; spasi di depan membuat isinya
    // bukan lagi oid dan git menolaknya. NUL menghentikan isi berkasnya lebih
    // dulu, karena git membacanya sebagai string C (diukur: `<hash><NUL>` dan
    // `<hash><NUL>junk` sama-sama menghasilkan hash yang sama dengan `<hash>`).
    try { head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").split("\0")[0].replace(/\s+$/, ""); }
    catch { return null; }

    const hexLength = objectIdHexLength(commonDir);

    const symbolic = /^ref:\s*(.+)$/.exec(head);
    if (!symbolic) return commitHash(head, hexLength);

    // HEAD boleh menunjuk symbolic ref yang menunjuk symbolic ref lagi. Nama
    // yang git tolak tidak pernah dicari git, jadi berkas apa pun — termasuk di
    // luar direktori git — tidak boleh dibaca di sini.
    let ref = symbolic[1].trim();
    if (!refNameValid(ref, true)) return null;
    for (let hop = 0; hop < MAX_REF_DEPTH; hop++) {
        const value = readRef(gitDir, commonDir, ref, hexLength);
        if (value === null) return null;
        const deeper = /^ref:\s*(.+)$/.exec(value);
        // Ada tetapi bukan hash: git pun gagal di sini, dan dulu hasilnya null.
        if (!deeper) return commitHash(value, hexLength);
        ref = deeper[1].trim();
        if (!refNameValid(ref, false)) return null;
    }

    return null;
}

/**
 * Isi sebuah ref — berkas longgar lebih dulu, lalu `packed-refs` — atau null.
 *
 * Ref biasa (`refs/heads/*`, `refs/tags/*`, ...) dicari HANYA di common dir:
 * git tidak pernah menyelesaikannya di direktori privat worktree, dan berkas
 * sisa di sana (mis. dari restore) akan memenangkan ref yang sebenarnya.
 *
 * Ref privat worktree (`refs/bisect|worktree|rewritten/*`) hanya dibaca
 * longgar di direktori privat worktree itu sendiri. Diukur dengan git 2.55:
 * pada linked worktree, ref privat yang hanya ada di common dir TIDAK
 * diselesaikan git, jadi tidak ada fallback ke sana.
 */
function readRef(gitDir, commonDir, ref, hexLength) {
    const bases = commonDir !== gitDir && !WORKTREE_PRIVATE_REF.test(ref) ? [commonDir] : [gitDir];

    for (const base of bases) {
        // Hanya spasi di BELAKANG yang dibuang git; spasi di depan membuat isi
        // berkas bukan lagi oid dan `git rev-parse` menolaknya. NUL menghentikan
        // isi berkas lebih dulu, karena git membacanya sebagai string C (diukur:
        // `<hash><NUL>` dan `<hash><NUL>junk` sama-sama menghasilkan hash).
        try { return fs.readFileSync(path.join(base, ref), "utf8").split("\0")[0].replace(/\s+$/, ""); }
        catch { /* belum dilonggarkan di sini — mungkin hanya ada di packed-refs */ }
    }

    for (const base of bases) {
        // `packed-refs` hanya diakui git di common dir. `git pack-refs --all`
        // membiarkan ref privat tetap longgar, jadi berkas di direktori privat
        // worktree tidak pernah dibaca git dan tidak boleh dipercaya di sini.
        if (base !== commonDir) continue;
        try {
            const packed = fs.readFileSync(path.join(base, "packed-refs"), "utf8");
            // Baris terakhir yang terpotong (berkas tanpa LF penutup) membuat
            // git menolak SELURUH berkas, termasuk baris yang lengkap; jadi
            // menerimanya di sini berarti menerima ref yang git tidak selesaikan.
            if (!packed.endsWith("\n")) continue;
            // Hanya oid sepanjang format repo yang sah: baris 64 heks di repo
            // sha1 membuat git gagal menyelesaikan ref itu (diukur dengan 2.55).
            const entryPattern = new RegExp(`^([0-9a-f]{${hexLength}})(?: |\\t)(.+)$`, "i");
            let found = null;
            for (const line of packed.split("\n")) {
                if (line.startsWith("#") || line.startsWith("^")) continue;
                // git memisahkan hash dari nama ref pada SATU spasi/tab pertama,
                // dan nama ref-nya adalah SISA baris itu apa adanya: "hash ref "
                // dan "hash ref extra" bukan nama yang sama bagi git, jadi
                // baris rusak tidak dirapikan di sini.
                const entry = entryPattern.exec(line);
                if (entry) {
                    // Entri TERAKHIR untuk sebuah nama yang menang, bukan yang
                    // pertama: git memuat packed-refs berurutan dan entri
                    // belakangan menimpa yang sebelumnya (diukur: duplikat
                    // "c1 ref" lalu "c2 ref" diselesaikan git sebagai c2).
                    if (entry[2] === ref) found = entry[1].toLowerCase();
                    continue;
                }
                // Baris tanpa oid sepanjang format repo: bila namanya ref ini,
                // git kehilangan nilainya — termasuk bila sebelumnya ada baris
                // sah (diukur: "c1 ref" lalu "garbage ref" gagal, sedangkan
                // urutan sebaliknya berhasil).
                const broken = /^\S+(?: |\t)(.*)$/.exec(line);
                if (broken && broken[1] === ref) found = null;
            }
            if (found) return found;
        }
        catch { /* tidak ada packed-refs di sini */ }
    }

    return null;

}

function hydrate(row) {
    const parse = (t, f) => { try { return JSON.parse(t ?? "") ?? f; } catch { return f; } };
    return {
        id: row.id, projectId: row.project_id, label: row.label,
        gitCommit: row.git_commit,
        missionStates: parse(row.mission_states, []),
        artifactIds: parse(row.artifact_ids, []),
        decisionIds: parse(row.decision_ids, []),
        memoryRefs: parse(row.memory_refs, []),
        createdAt: row.created_at
    };
}

module.exports = new TimeMachine();
// Diekspor untuk pengujian langsung (lihat tests/wave8/legacy/labTimeMachineGitRead.test.js).
module.exports.readGitCommit = readGitCommit;
