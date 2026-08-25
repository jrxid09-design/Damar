const killSwitch = require("./killSwitch");
const riskPolicy = require("./riskPolicy");
const pathPolicy = require("./pathPolicy");
const loopGuard = require("./loopGuard");
const verifier = require("../verify/VerificationEngine");
const auditTrail = require("./auditTrail");
const riskCatalog = require("./riskCatalog");
const telemetry = require("../../services/telemetryService");

/**
 * Rantai keselamatan tool — satu definisi, dipakai semua jalur.
 *
 * Sebelumnya rantai ini hanya ada di dalam `ToolRegistry.execute`.
 * Jalur Console memang melewatinya, tetapi tool asli milik model
 * (memori, rumah, WhatsApp, terminal, coding) didaftarkan di
 * registry AI yang terpisah dan dijalankan langsung oleh
 * `ToolExecutor` — sehingga `terminal_run`, `code_commit`, dan
 * `home_control` berjalan tanpa otorisasi risiko, tanpa rem
 * kebuntuan, tanpa batas jalur, dan tanpa verifikasi. Yang berlaku
 * hanyalah kill switch.
 *
 * Menyalin rantai ke jalur kedua akan membuat dua definisi yang
 * pasti menyimpang seiring waktu; karena itu ia diangkat ke sini
 * dan kedua pemanggil memakai fungsi yang sama.
 *
 * `before()` menjaga SEBELUM tool menyentuh apa pun, `after()`
 * membuktikan hasilnya, `failed()` mencatat kegagalan.
 */

/**
 * Penjagaan sebelum eksekusi.
 *
 * Urutan disengaja: rem dulu (paling murah, paling mutlak),
 * lalu wewenang, lalu kebuntuan, lalu batas jalur.
 *
 * @returns {boolean} true bila tool ini destruktif
 */
function before(id, args = {}, tool = null, exec = null) {

    let destructive = null;

    // Scope rem kebuntuan = identitas eksekusi (H11): sesi/principal
    // berbeda tidak saling memengaruhi.
    const scope = exec?.sessionId ?? exec?.principalId ?? "global";

    try {

        killSwitch.assertRunning(id);

        destructive = riskPolicy.assertAllowed(id, tool);

        loopGuard.assertNotLooping(id, args, scope);

        pathPolicy.assertToolPaths(id, args);

    }
    catch (error) {

        // Penolakan justru peristiwa yang paling perlu tercatat:
        // ia menandai model mencoba melewati batas. Dicatat sebelum
        // dilempar ulang supaya tidak ada jalur yang melewatkannya.
        auditTrail.record({
            tool: id,
            risk: (destructive ?? riskCatalog.riskOf(id, tool)) ? "destructive" : "safe",
            outcome: "denied",
            reason: error?.code ?? error?.message,
            args
        });

        throw error;

    }

    if (destructive) {
        telemetry.publish("tool:execute", { tool: id, risk: "destructive" });
    }

    return destructive;

}

/** Kegagalan berulang menandakan percobaan ulang tak menyentuh akarnya (§140). */
function failed(id, error, exec = null) {

    const scope = exec?.sessionId ?? exec?.principalId ?? "global";

    loopGuard.recordFailure(id, error, scope);

    auditTrail.record({
        tool: id,
        risk: riskCatalog.riskOf(id) ? "destructive" : "safe",
        outcome: "error",
        reason: error?.message
    });

}

/**
 * Verifikasi hasil (§46): keluaran tool bukan bukti.
 *
 * Tidak boleh menjatuhkan eksekusi yang sudah berhasil — bila
 * enginenya sendiri bermasalah, hasil tetap dikembalikan dengan
 * status "belum terverifikasi".
 */
async function after(id, args, result) {

    try {

        const report = await verifier.verify(id, args, result);

        if (report.state !== "skipped") {
            telemetry.publish("tool:verify", {
                tool: id,
                risk: report.risk,
                state: report.state,
                passed: report.passed,
                total: report.total
            });
        }

        if (report.state === "failed") {
            telemetry.warn(
                `[verify] ${id} — ${verifier.summarize(report)}`
            );
        }

        // Ditempelkan sebagai field tambahan agar konsumen lama
        // tetap membaca hasil seperti sebelumnya.
        if (result && typeof result === "object" && !Array.isArray(result)) {
            result.verification = report;
        }

        // Pembacaan murni yang tidak diverifikasi tidak dicatat —
        // hanya akan menenggelamkan jejak. Sisanya dicatat: ada yang
        // berubah di luar kepala Aether, dan pemilik berhak melihatnya.
        if (report.risk === "destructive" || report.state !== "skipped") {
            auditTrail.record({
                tool: id,
                risk: report.risk,
                outcome: "ok",
                verification: report.state,
                checks: report.total ? `${report.passed}/${report.total}` : null,
                args
            });
        }

        return report;

    }
    catch {
        // Verifikasi tidak boleh membatalkan hasil nyata.
        return null;
    }

}

module.exports = { before, after, failed };
