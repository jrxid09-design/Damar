const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDamarSelfService,
        DEFAULT_CANONICAL_DIR } = require("../../src/services/damarSelfService");

function tmpLegacy(sampleIdentity, sampleJournal) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-self-"));
    fs.writeFileSync(path.join(dir, "identity.md"), sampleIdentity);
    fs.writeFileSync(path.join(dir, "journal.md"), sampleJournal);
    return dir;
}

test("#1/#2/#3 migrasi byte-exact & hanya SATU path kanonik", () => {

    const legacy = tmpLegacy(
        "# AKU\n- Nama: Damar.\n",
        "# Jurnal\n\n[2026-08-18] Entri pertama yang wajib utuh.\n");

    const canonicalDir = path.join(os.tmpdir(),
        "canonical-self-" + Date.now());

    const svc = createDamarSelfService({
        canonicalDir, legacyDir: legacy });

    const result = svc.migrateFromLegacy(legacy);

    assert.deepEqual(result.copied.sort(), ["identity.md","journal.md"]);

    // Byte-exact:
    assert.ok(svc.readIdentityBytes().equals(
        fs.readFileSync(path.join(legacy, "identity.md"))));
    assert.ok(svc.readJournalBytes().equals(
        fs.readFileSync(path.join(legacy, "journal.md"))));

    // Marker migrasi di lokasi lama:
    assert.ok(fs.existsSync(path.join(legacy, "MIGRATED.md")));

    // Resolver HANYA mengembalikan canonical:
    assert.equal(svc.resolveCanonical(), canonicalDir);
    assert.equal(DEFAULT_CANONICAL_DIR.endsWith(
        path.join("DamarSelf")), true);

    // Struktur minimal hadir:
    for (const p of ["constitution/principles.md",
                     "self-model/capabilities.md",
                     "self-model/limitations.md",
                     "self-model/goals.md",
                     "evolution/proposals",
                     "README.md"]) {
        assert.ok(fs.existsSync(path.join(canonicalDir, p)), p);
    }

    fs.rmSync(canonicalDir, { recursive: true, force: true });
    fs.rmSync(legacy, { recursive: true, force: true });
});

test("#2 journal APPEND-ONLY: entri lama tidak boleh berubah", () => {

    const canonicalDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "journal-only-"));
    fs.writeFileSync(path.join(canonicalDir, "journal.md"),
        "# Jurnal\n\n[2026-01-01] Entri lama sakral.\n", "utf8");

    const svc = createDamarSelfService({ canonicalDir });

    // Tanpa identity/journal file lain — append harus tetap jalan:
    const before = fs.readFileSync(path.join(canonicalDir, "journal.md"));

    svc.appendJournal({ at: "2026-02-02T10:00:00.000Z",
                        text: "Interpretasi baru atas hari ini." });

    const after = fs.readFileSync(path.join(canonicalDir, "journal.md"));

    // Prefix lama WAJIB identik:
    assert.ok(after.subarray(0, before.length).equals(before),
        "entri lama berubah!");

    // Interpretasi baru ditambahkan sebagai ENTRI BARU:
    assert.match(after.toString(), /\[2026-02-02T10:00:00\.000Z\] Interpretasi baru/);

    fs.rmSync(canonicalDir, { recursive: true, force: true });
});
