/**
 * HTTP provider Mata Dewa — ADAPTER tipis ke SATU batas jaringan kanonik
 * Damar (src/core/safety/ssrfGuard.js). MD-002 repair.
 *
 * HUKUM:
 *  - TIDAK ada implementasi SSRF Mata Dewa sendiri. Semua permintaan
 *    upstream melewati guardedFetch kanonik:
 *      • allowlist host per penyedia (allowRedirectHost per hop)
 *      • HTTPS diwajibkan untuk provider publik
 *      • loopback/RFC1918/link-local/metadata/CGNAT/unspecified ditolak
 *      • IPv4-mapped IPv6 dievaluasi ulang sebagai IPv4
 *      • ADDRESS PINNING: alamat yang divalidasi = alamat yang dipakai
 *        koneksi (anti DNS rebinding pada level koneksi, bukan sekadar
 *        dns.lookup ganda)
 *      • SETIAP hop redirect divalidasi ulang penuh (tanpa follow buta)
 *      • batas byte STREAMING (bukan length-check setelah .text())
 *      • stall deadline antar-chunk (anti slowloris)
 *  - DUA kelas sumber — model ancaman BERBEDA, tidak saling melemahkan:
 *      PUBLIC_REMOTE_PROVIDER  (policy "public"): hanya alamat publik.
 *      AUTHORIZED_LOCAL_SOURCE (policy "trusted-lan"): endpoint lokal
 *      milik pemilik HANYA melalui otorisasi kanonik Damar (registry
 *      perangkat/Lane 4). Sebelum trust itu ada, pemanggil TIDAK bisa
 *      memilih policy sendiri — fail closed (lihat authorizedLocalFetch).
 *  - Raw URL CCTV/kamera TIDAK pernah berarti otorisasi (lihat cctv.js).
 */

const ssrfGuard = require("../../core/safety/ssrfGuard");

const USER_AGENT = "damar-mata-dewa/1.0 (+https://github.com/jrxid09-design/Aether)";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const DEFAULT_STALL_MS = 8000;

/** Host yang diizinkan per kebijakan penyedia publik (allowlist ketat). */
function makeHostAllowlist(hosts) {
    const normalized = new Set(
        (hosts ?? []).map(h => String(h).toLowerCase().replace(/\.$/, "")));
    return (host) => normalized.has(String(host).toLowerCase().replace(/\.$/, ""));
}

function baseHeaders(headers) {
    return { "User-Agent": USER_AGENT, Accept: "*/*", ...(headers ?? {}) };
}

function toText(result) {
    return result.buffer.toString("utf8");
}

/**
 * GET teks/JSON ke provider publik — SATU batas kanonik, streaming-bound.
 * @param {string} url
 * @param {{ timeoutMs?, maxBytes?, stallTimeoutMs?, headers?,
 *           expectedContentType?: "json"|"text"|null,
 *           allowedHosts?: string[] }} opts
 */
async function fetchText(url, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    try {
        // Allowlist ORIGIN yang ketat: host yang disetujui penyedia,
        // bukan sembarang host publik.
        if (opts.allowedHosts) {
            const originHost = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
            const allow = makeHostAllowlist(opts.allowedHosts);
            if (!allow(originHost)) {
                throw new Error(`host di luar allowlist penyedia ditolak: ${originHost}`);
            }
        }
        const result = await ssrfGuard.guardedFetch(url, {
            policy: "public",
            timeoutMs,
            maxBytes,
            stallTimeoutMs: opts.stallTimeoutMs ?? DEFAULT_STALL_MS,
            headers: baseHeaders(opts.headers),
            expectedContentType: opts.expectedContentType === undefined
                ? null : opts.expectedContentType,
            allowRedirectHost: opts.allowedHosts
                ? makeHostAllowlist(opts.allowedHosts) : null
        });
        return toText(result);
    }
    catch (error) {
        throw new Error(simplifyNetworkError(error));
    }
}

/** Fetch JSON dengan guardrails (parse aman; lempar bila malformed). */
async function fetchJson(url, opts = {}) {
    const text = await fetchText(url, {
        ...opts,
        expectedContentType: opts.expectedContentType === undefined
            ? "json" : opts.expectedContentType
    });
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error("respons malformed (bukan JSON)");
    }
}

/**
 * POST urlencoded/JSON dengan batas kanonik yang SAMA. Mengembalikan teks.
 * @param {string} url
 * @param {string|object} body  string (urlencoded) atau objek (di-JSON-kan)
 * @param {{ timeoutMs?, maxBytes?, headers?, form?: boolean, allowedHosts? }} opts
 */
async function fetchPost(url, body, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const isForm = opts.form !== false && typeof body === "string";
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    try {
        if (opts.allowedHosts) {
            const originHost = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
            const allow = makeHostAllowlist(opts.allowedHosts);
            if (!allow(originHost)) {
                throw new Error(`host di luar allowlist penyedia ditolak: ${originHost}`);
            }
        }
        const result = await ssrfGuard.guardedFetch(url, {
            policy: "public",
            method: "POST",
            body: payload,
            timeoutMs,
            maxBytes,
            stallTimeoutMs: opts.stallTimeoutMs ?? DEFAULT_STALL_MS,
            headers: {
                ...baseHeaders(opts.headers),
                "Content-Type": isForm
                    ? "application/x-www-form-urlencoded" : "application/json"
            },
            expectedContentType: null,
            allowRedirectHost: opts.allowedHosts
                ? makeHostAllowlist(opts.allowedHosts) : null
        });
        return toText(result);
    }
    catch (error) {
        throw new Error(simplifyNetworkError(error));
    }
}

async function fetchPostJson(url, body, opts = {}) {
    const text = await fetchPost(url, body, opts);
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error("respons malformed (bukan JSON)");
    }
}

/**
 * AUTHORIZED_LOCAL_SOURCE — fail closed pra-Lane4.
 *
 * Endpoint lokal (RFC1918/kamera LAN/sensor) butuh otorisasi kanonik
 * Damar (registry perangkat tepercaya / trust Lane 4 tersertifikasi).
 * Pemanggil TIDAK BISA memilih kebijakan sendiri; hingga integrasi
 * itu ada, fungsi ini MENOLAK dengan alasan eksplisit.
 */
async function authorizedLocalFetch() {
    throw new Error("AUTHORIZED_LOCAL_SOURCE ditolak: OWNER_TRUST_NOT_INTEGRATED " +
        "(post-Lane4: otorisasi kanonik perangkat lokal diwajibkan)");
}

function simplifyNetworkError(error) {
    const msg = String(error?.message ?? error);
    // Pesan panjang upstream diringkas untuk failureReason provider.
    return msg.length > 240 ? msg.slice(0, 240) : msg;
}

module.exports = {
    fetchText, fetchJson, fetchPost, fetchPostJson,
    authorizedLocalFetch,
    // Ekspos terbatas untuk pengujian/diagnostik — BUKAN pengganti guard.
    isPrivateIp: ssrfGuard.isPrivateAddress,
    addressClass: ssrfGuard.addressClass,
    USER_AGENT
};
