/**
 * Coverage Engine — Mata Dewa tahu di mana sebuah provider BISA dan TIDAK BISA
 * mengamati.
 *
 * Hukum: "tidak ada observasi" TIDAK otomatis berarti "tidak terjadi apa-apa".
 * Coverage menrepresentasikan cakupan, ketersediaan, batas akses, freshness,
 * dan kualitas — sehingga ketiadaan data dibaca dengan jujur.
 */

const { isValidPoint, haversineMeters, isFiniteNumber } = require("../spatial/geo");
const { PROVIDER_STATE } = require("../registry/providerRegistry");
const { ACCESS_CLASS, requiresAuthorization } = require("../spatial/accessClass");

/**
 * Apakah sebuah provider (menurut deskripsinya) secara deklaratif mencakup
 * sebuah titik. coverage: null | { kind:"global" } | { kind:"regional", center?, radiusM? }
 */
function coversPoint(providerDescription, point) {
    if (!providerDescription || !isValidPoint(point)) return false;
    const cov = providerDescription.coverage;
    if (!cov) return true; // tanpa deklarasi = diasumsikan global (umum untuk feed dunia)
    if (cov.kind === "global") return true;
    if (cov.kind === "regional") {
        if (isValidPoint(cov.center) && isFiniteNumber(cov.radiusM)) {
            const d = haversineMeters(cov.center, point);
            return isFiniteNumber(d) && d <= cov.radiusM;
        }
        // regional tanpa geometri eksplisit: tidak bisa dibuktikan mencakup.
        return false;
    }
    return false;
}

/**
 * Nilai ketersediaan observasi sebuah tipe di sebuah titik, menggabungkan
 * coverage + state provider + akses. Mengembalikan objek jujur:
 * {
 *   covered, observable, reason, providers: [{ id, covered, available, accessClass }]
 * }
 */
function assessCoverage(registry, { type = null, point = null } = {}) {
    const providers = registry.listProviders()
        .filter(p => !type || p.types.includes(type));

    const rows = providers.map(p => {
        const covered = point ? coversPoint(p, point) : true;
        const available = p.availability === PROVIDER_STATE.AVAILABLE;
        const accessBlocked = requiresAuthorization(p.accessClass) &&
            p.availability !== PROVIDER_STATE.AVAILABLE;
        return {
            id: p.id,
            covered,
            available,
            accessClass: p.accessClass ?? ACCESS_CLASS.PUBLIC,
            blocked: accessBlocked,
            reason: available ? null : (p.failureReason ?? "unavailable")
        };
    });

    const anyObservable = rows.some(r => r.covered && r.available);
    const anyCovered = rows.some(r => r.covered);

    let reason = null;
    if (!anyCovered) reason = "outside_coverage";
    else if (!anyObservable) reason = "covered_but_unavailable";

    return {
        type: type ?? null,
        point: point ?? null,
        covered: anyCovered,
        observable: anyObservable,
        reason,
        providers: rows
    };
}

/**
 * Baca jujur atas "tidak ada observasi" di sebuah titik untuk sebuah tipe.
 * Mengembalikan kalimat status epistemik:
 *   - "observing"      : provider mencakup & tersedia → ketiadaan berarti
 *                        kemungkinan memang tidak ada kejadian.
 *   - "blind"          : di luar coverage / provider mati → ketiadaan BUKAN
 *                        bukti tidak ada kejadian.
 */
function interpretAbsence(registry, { type, point } = {}) {
    const assess = assessCoverage(registry, { type, point });
    if (assess.observable) {
        return { status: "observing", meaning: "no_observation_likely_no_event", assess };
    }
    return { status: "blind", meaning: "no_observation_is_not_evidence_of_absence", assess };
}

module.exports = { coversPoint, assessCoverage, interpretAbsence };
