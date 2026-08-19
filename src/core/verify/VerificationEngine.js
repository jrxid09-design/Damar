const { verifierFor } = require("./verifiers");
const { riskOf } = require("../safety/riskCatalog");

/**
 * Verification Engine (§46, §192, Konstitusi Pasal 5).
 *
 * Aether tidak boleh melaporkan keberhasilan yang belum
 * diverifikasi. Sebelum ini, "tool selesai tanpa melempar error"
 * dianggap sama dengan "tindakan berhasil" — dua hal yang sangat
 * berbeda ketika sebuah tool menulis ke jalur yang salah, atau
 * mengembalikan sukses padahal berkasnya kosong.
 *
 * Verifikasi berjalan untuk tool apa pun yang punya verifier,
 * apa pun klasifikasinya; tool destruktif tanpa verifier dilaporkan
 * "unverified" dengan jujur. Hanya pembacaan murni yang tidak punya
 * verifier dilewati — biayanya tak sepadan.
 *
 * Empat keadaan, sengaja dibedakan:
 *
 *   verified    — ada bukti nyata bahwa dunia berubah sesuai klaim
 *   failed      — bukti menunjukkan klaim TIDAK benar
 *   unverified  — belum ada verifier untuk tool ini
 *   skipped     — tool aman tanpa verifier, tidak perlu dibuktikan
 *
 * `unverified` bukan `verified`. Menyamakan keduanya persis
 * kesalahan yang ingin dihapus modul ini.
 */

class VerificationEngine {

    /**
     * @param {string} toolId
     * @param {object} args   argumen yang dipakai memanggil tool
     * @param {*}      result hasil mentah dari tool
     * @returns {Promise<object>} laporan verifikasi
     */
    async verify(toolId, args = {}, result = null) {

        const destructive = riskOf(toolId);
        const risk = destructive ? "destructive" : "safe";

        const verifier = verifierFor(toolId);

        if (!verifier) {

            // Tool destruktif tanpa verifier harus dilaporkan apa
            // adanya; tool aman tanpa verifier cukup dilewati.
            if (!destructive) {
                return this.report(toolId, risk, "skipped", [], "tool aman");
            }

            return this.report(
                toolId, risk, "unverified", [],
                "belum ada verifier untuk tool ini"
            );
        }

        try {

            const out = await verifier(args, result);
            const checks = Array.isArray(out?.checks) ? out.checks : [];

            if (checks.length === 0) {
                return this.report(toolId, risk, "unverified", [], "verifier tidak menghasilkan pemeriksaan");
            }

            const allPassed = checks.every(c => c.passed === true);

            return this.report(
                toolId,
                risk,
                allPassed ? "verified" : "failed",
                checks,
                allPassed ? null : "sebagian bukti tidak sesuai klaim"
            );

        }
        catch (e) {

            // Verifier rusak ≠ tindakan gagal. Jangan menuduh.
            return this.report(
                toolId, risk, "unverified", [],
                `verifier bermasalah: ${e.message}`
            );

        }

    }

    report(tool, risk, state, checks, note) {

        return {
            tool,
            risk,
            state,
            note,
            checks,
            passed: checks.filter(c => c.passed).length,
            total: checks.length,
            at: new Date().toISOString()
        };

    }

    /** Kalimat pendek untuk manusia. */
    summarize(report) {

        if (!report) return "tanpa verifikasi";

        switch (report.state) {
            case "verified":
                return `terverifikasi (${report.passed}/${report.total} bukti)`;
            case "failed":
                return `TIDAK terverifikasi — ${report.checks.filter(c => !c.passed).map(c => c.name).join(", ")}`;
            case "skipped":
                return "tidak perlu diverifikasi";
            default:
                return `belum terverifikasi — ${report.note}`;
        }

    }

}

module.exports = new VerificationEngine();
