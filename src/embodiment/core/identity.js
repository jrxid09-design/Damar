/**
 * Identitas kanonik perangkat (B§3).
 *
 * Identitas = <namespace>:<stable-key>. Namespace menandai domain
 * penemuan (windows.audio, usb, network, host.os, ...); stable-key
 * berasal dari pengenal stabil OS/perangkat — BUKAN nama tampilan,
 * karena nama bisa berubah dan duplikat.
 *
 * Kejujuran kestabilan: bila sumber tidak menyediakan pengenal stabil,
 * adapter WAJIB memakai fallbackStableKey() (hash sifat teramati) dan
 * mengklaim stability "session"/"ephemeral" — bukan "stable". Kita tidak
 * pernah mengklaim kestabilan yang tidak bisa ditjamin sumbernya.
 */

const { sha256Hex, canonicalJson, fail } = require("../core/util");
const { IDENTITY_STABILITY } = require("../domain/types");

const NAMESPACE_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;
const STABLE_KEY_PATTERN = /^[A-Za-z0-9._:+@{}\-]{1,240}$/;
const DEVICE_ID_PATTERN =
    /^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9._:+@{}\-]{1,240}$/;

function validateDeviceId(deviceId) {
    return typeof deviceId === "string" && DEVICE_ID_PATTERN.test(deviceId);
}

/** Bangun ID kanonik; gagal-tutup pada bentuk kotor. */
function canonicalDeviceId({ namespace, stableKey }) {
    if (!NAMESPACE_PATTERN.test(String(namespace ?? ""))) {
        throw fail("EMB_INVALID_NAMESPACE",
            `namespace tidak sah: '${namespace}'`);
    }
    if (!STABLE_KEY_PATTERN.test(String(stableKey ?? ""))) {
        throw fail("EMB_INVALID_STABLE_KEY",
            `stableKey tidak sah: '${String(stableKey).slice(0, 40)}'`);
    }
    return `${namespace}:${stableKey}`;
}

/** Fallback jujur: hash sifat teramati → pseudo-ID deterministik. */
function fallbackStableKey(traits) {
    return `unverified-${sha256Hex(canonicalJson(traits ?? {})).slice(0, 16)}`;
}

/** Pisahkan ID kanonik menjadi {namespace, stableKey}. */
function parseDeviceId(deviceId) {
    if (!validateDeviceId(deviceId)) {
        throw fail("EMB_INVALID_DEVICE_ID", `deviceId tidak sah: '${deviceId}'`);
    }
    const idx = deviceId.indexOf(":");
    return {
        namespace: deviceId.slice(0, idx),
        stableKey: deviceId.slice(idx + 1)
    };
}

module.exports = {
    NAMESPACE_PATTERN, STABLE_KEY_PATTERN, DEVICE_ID_PATTERN,
    validateDeviceId, canonicalDeviceId, fallbackStableKey, parseDeviceId
};
