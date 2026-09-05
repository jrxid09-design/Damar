"use strict";

/**
 * BRAND KOMPOSISI KANONIK (MD-018) — satu-satunya klaim keanggotaan
 * "komposisi OwnerTrust kanonik tersertifikasi".
 *
 * OWNS: WeakSet closure-modul. Hanya compose() (ownerTrustComposition) yang
 * memanggil brandCanonicalComposition — hasilnya diteruskan KELUAR sudah
 * ter-brand. Pemanggil tidak bisa memalsukan keanggotaan: WeakSet tidak
 * pernah diekspor, dan objek tiruan (spread/lookalike duck-typed) bukan
 * objek yang sama. Pabrik jembatan trust (buildMataDewaTrustBridges)
 * menolak komposisi tanpa brand — authority palsu tidak pernah menjadi
 * sumber trust Mata Dewa.
 */

const CANONICAL_COMPOSITIONS = new WeakSet();

function brandCanonicalComposition(comp) {
    if (comp === null || typeof comp !== "object") {
        throw new TypeError("CANONICAL_BRAND_INVALID: komposisi wajib objek");
    }
    CANONICAL_COMPOSITIONS.add(comp);
    return comp;
}

function isCanonicalComposition(candidate) {
    return candidate !== null && typeof candidate === "object" &&
        CANONICAL_COMPOSITIONS.has(candidate);
}

module.exports = Object.freeze({ brandCanonicalComposition, isCanonicalComposition });