const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDamarSelfService } =
    require("../../src/services/damarSelfService");
const acc = require("../authority/evolution-harness");

/**
 * RED-TEAM BLOCKER 10: DamarSelf proposal path traversal.
 * Dua boundary wajib menolak:
 *   1. model validation (proposalId slug aman, bounded length)
 *   2. filesystem boundary (resolve + verify inside canonical dir)
 */

function tmpCanonical() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aself-path-"));
}

const MALICIOUS_IDS = [
    "../../../PWNED",
    "..\\..\\evil",
    "../../..%2fPWNED",
    "/etc/passwd",
    "C:\\evil\\note.md",
    "/abs/path/proposal",
    "..",
    ".",
    "a/../b",
    "a..b",
    "..a",
    "a..",
    "prop/../../../escape",
    "prop with space",
    "prop\nnewline",
    "%2e%2e%2fPWNED",
    "UPPER_CASE_NOT_ALLOWED",
    "x".repeat(121)
];

test("B10 model: proposalId malicious DITOLAK sebelum store write",
     async () => {
    const { registry, store } = acc.makeRegistry();
    for (const bad of MALICIOUS_IDS) {
        assert.throws(() => acc.model.buildEvolutionProposal({
            proposalId: bad, createdBy: "acc",
            problem: "p", proposedChange: "c" }),
            err => err.reasonCode === "CAP_MALFORMED" ||
                   err.name === "AuthorityMalformed",
            `model harus menolak: ${JSON.stringify(bad)}`);

        await assert.rejects(
            () => registry.proposeEvolution({
                proposalId: bad, createdBy: "acc",
                problem: "p", proposedChange: "c" }, "acc"),
            undefined,
            `registry harus menolak: ${JSON.stringify(bad)}`);
    }
    // Tidak ada proposal yang tersimpan:
    assert.equal(await store.getProposal(".."), null);
});

test("B10 model: normal safe proposal IDs diterima", () => {
    for (const ok of ["prop-expand", "p-tx", "evolution.proposal-2026_01",
                      "a", "prop1"]) {
        const p = acc.model.buildEvolutionProposal({
            proposalId: ok, createdBy: "acc",
            problem: "p", proposedChange: "c" });
        assert.equal(p.proposalId, ok, ok);
    }
});

test("B10 filesystem: malicious id gagal SEBELUM write; tidak ada " +
     "berkas di luar DamarSelf proposals yang tersentuh", () => {
    for (const bad of MALICIOUS_IDS) {
        const dir = tmpCanonical();
        try {
            const svc = createDamarSelfService({ canonicalDir: dir });
            svc.ensureStructure();

            let outsideTouched = null;
            const origWrite = fs.writeFileSync;
            const origMkdir = fs.mkdirSync;
            // Watchdog: tulisan apa pun di luar dir harus terdeteksi.
            fs.writeFileSync = function spy(file, ...rest) {
                const p = path.resolve(String(file));
                if (!p.startsWith(path.resolve(dir) + path.sep)) {
                    outsideTouched = p;
                }
                return origWrite.call(fs, file, ...rest);
            };
            fs.mkdirSync = function spyDir(p, ...rest) {
                const rp = path.resolve(String(p));
                if (!rp.startsWith(path.resolve(dir))) {
                    outsideTouched = rp;
                }
                return origMkdir.call(fs, p, ...rest);
            };

            let threw = false;
            try {
                svc.writeEvolutionProposalDoc({
                    proposalId: bad,
                    createdBy: "acc", kind: "architectural_change",
                    revision: 1, digest: "d", status: "DRAFT",
                    problem: "p", proposedChange: "c"
                });
            } catch {
                threw = true;
            } finally {
                fs.writeFileSync = origWrite;
                fs.mkdirSync = origMkdir;
            }

            assert.equal(threw, true,
                `boundary harus menolak: ${JSON.stringify(bad)}`);
            assert.equal(outsideTouched, null,
                `penulisan di luar canonical terdeteksi untuk: ` +
                JSON.stringify(bad));

            // Tidak ada berkas PWNED di lokasi manapun yang dekat:
            const parentOfCanonical =
                path.resolve(dir, "..", "..", "..");
            assert.ok(!fs.existsSync(
                path.join(parentOfCanonical, "PWNED")));
            assert.ok(!fs.existsSync(path.join(parentOfCanonical, "evil")));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test("B10 filesystem: safe id tetap tertulis di dalam proposals dir",
     () => {
    const dir = tmpCanonical();
    try {
        const svc = createDamarSelfService({ canonicalDir: dir });
        svc.ensureStructure();

        const file = svc.writeEvolutionProposalDoc({
            proposalId: "prop-safe_1.v2",
            createdBy: "acc", kind: "architectural_change",
            revision: 3, digest: "abc", status: "CANDIDATE_READY",
            problem: "p", proposedChange: "c",
            requiredCapabilities: ["self.research"]
        });

        const resolved = path.resolve(file);
        const expectedDir = path.resolve(dir, "evolution", "proposals");
        assert.ok(resolved.startsWith(expectedDir + path.sep));
        assert.ok(fs.existsSync(resolved));
        assert.match(fs.readFileSync(resolved, "utf8"),
            /EvolutionProposal prop-safe_1\.v2/);
        assert.match(fs.readFileSync(resolved, "utf8"), /revision  : 3/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
