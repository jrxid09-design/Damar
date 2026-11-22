"use strict";

/**
 * Kanonikalisasi ketat skema spasial (MD-005).
 *
 * HUKUM:
 *  - REJECT, bukan clamp, untuk nilai keamanan/bukti yang tidak sah:
 *    confidence di luar [0,1], NaN/Infinity, epoch negatif, timestamp
 *    masa depan di luar toleransi clock-skew → observasi/event DITOLAK
 *    dengan alasan eksplisit.
 *  - Setelah konstruksi, TIDAK ADA mutasi pemanggil terhadap objek input
 *    yang bisa mengubah rekaman kanonik: deep copy defensif → deep freeze.
 *  - Prototype berbahaya (class instance, getter) DITOLAK — tidak ada
 *    eksekusi getter saat kanonikalisasi data hostil (baca via
 *    Object.getOwnPropertyDescriptor, mirror pola payload bus).
 *  - Semua string dibatasi; struktur dibatasi (depth/nodes/keys).
 */

const OWN = Object.prototype.hasOwnProperty;

/** Kunci prototype-hostil: SELALU reject (bukan drop, bukan re-assign). */
const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

// Batas kanonikalisasi (bukan batas impor — ini batas rekaman kanonik).
const CANON_LIMITS = Object.freeze({
    MAX_DEPTH: 6,
    MAX_NODES: 512,
    MAX_STRING_BYTES: 4096,
    MAX_ATTRIBUTES: 32,
    /** Toleransi clock-skew: timestamp masa depan di atas ini ditolak. */
    FUTURE_SKEW_MS: 5 * 60 * 1000
});

/** Baca properti data-only (tanpa getter) — anti side-effect hostil. */
function readOwn(value, key) {
    if (!OWN.call(value, key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
        throw new CanonError(`akses '${key}' memakai getter — data hostil ditolak`);
    }
    return descriptor.value;
}

class CanonError extends Error {
    constructor(message) {
        super(message);
        this.name = "CanonError";
    }
}

function byteLengthOf(str) {
    return Buffer.byteLength(String(str), "utf8");
}

function isPlainObjectSafe(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** String kanonik: trim, bounded; kosong → undefined. */
function boundedString(value, max = CANON_LIMITS.MAX_STRING_BYTES) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new CanonError("nilai string tidak sah (bukan skalar)");
    }
    const str = String(value).trim();
    if (!str) return undefined;
    if (byteLengthOf(str) > max) {
        throw new CanonError(`string > ${max} bytes — ditolak (bukan dipotong)`);
    }
    return str;
}

/**
 * Deep canonicalize: copy defensif prototype-safe → struktur beku.
 * Melampaui depth/nodes/limits → CanonError (REJECT).
 */
function deepCanonicalize(value, { depth = 0, state = { nodes: 0 }, limits = CANON_LIMITS } = {}) {
    if (depth > limits.MAX_DEPTH) {
        throw new CanonError(`kedalaman struktur > ${limits.MAX_DEPTH}`);
    }
    if (value === null) return null;
    if (typeof value === "string") return boundedString(value, limits.MAX_STRING_BYTES) ?? null;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new CanonError("angka non-finite (NaN/Infinity) ditolak");
        return value;
    }
    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (Array.isArray(value)) {
        state.nodes += value.length;
        if (state.nodes > limits.MAX_NODES) throw new CanonError(`struktur > ${limits.MAX_NODES} node`);
        const out = [];
        for (let i = 0; i < value.length; i++) {
            out.push(deepCanonicalize(readOwn(value, i), { depth: depth + 1, state, limits }));
        }
        return Object.freeze(out);
    }
    if (isPlainObjectSafe(value)) {
        const keys = Object.keys(value);
        state.nodes += keys.length;
        if (state.nodes > limits.MAX_NODES) throw new CanonError(`struktur > ${limits.MAX_NODES} node`);
        const out = {};
        for (const key of keys) {
            if (byteLengthOf(key) > 128) throw new CanonError("kunci atribut > 128 bytes");
            // Prototype trick: kunci __proto__/constructor/prototype pada
            // input DITOLAK KERAS — tidak pernah menular ke rekaman kanonik
            // (bukan diam-diam mengganti prototype objek hasil).
            if (DANGEROUS_KEYS.has(key)) throw new CanonError(`kunci prototype-hostil '${key}' ditolak`);
            out[key] = deepCanonicalize(readOwn(value, key), { depth: depth + 1, state, limits });
        }
        return Object.freeze(out);
    }
    // Class instance, function, symbol, dst → tolak.
    throw new CanonError(`tipe tidak sah untuk rekaman kanonik: ${typeof value}`);
}

/**
 * Confidence KETAT: wajib number finite dalam [0,1]. Di luar itu → REJECT.
 * (MD-005: tidak ada konversi diam-diam 4.7 → 1.)
 */
function strictConfidence(value, field = "confidence") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CanonError(`${field} wajib number finite dalam [0,1] (dapat: ${String(value)})`);
    }
    if (value < 0 || value > 1) {
        throw new CanonError(`${field} di luar rentang [0,1]: ${value} — ditolak, bukan di-clamp`);
    }
    return value;
}

/**
 * Timestamp KETAT: epoch ms finite, non-negatif, tidak lebih jauh di masa
 * depan daripada toleransi clock-skew.
 */
function strictTimestamp(value, field, { nowMs, skewMs = CANON_LIMITS.FUTURE_SKEW_MS } = {}) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CanonError(`${field} wajib epoch ms finite (dapat: ${String(value)})`);
    }
    if (value < 0) {
        throw new CanonError(`${field} negatif ditolak: ${value}`);
    }
    if (typeof nowMs === "number" && value > nowMs + skewMs) {
        throw new CanonError(
            `${field} di masa depan melebihi toleransi clock-skew (${skewMs}ms): ${value}`);
    }
    return value;
}

/** Freeze mendalam untuk struktur yang SUDAH canonical (tanpa re-copy). */
function deepFreezeCanonical(value) {
    if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) deepFreezeCanonical(value[key]);
        Object.freeze(value);
    }
    return value;
}

module.exports = Object.freeze({
    CANON_LIMITS,
    CanonError,
    readOwn,
    isPlainObjectSafe,
    boundedString,
    deepCanonicalize,
    strictConfidence,
    strictTimestamp,
    deepFreezeCanonical
});
