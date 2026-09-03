/**
 * Guardrails HTTP provider Mata Dewa.
 *
 * Setiap panggilan upstream melewati sini: timeout, batas ukuran respons,
 * User-Agent yang jujur, dan penolakan host privat/loopback (mitigasi SSRF).
 * Tidak ada pengambilan URL arbitrer dari luar allowlist provider.
 */

const dns = require("node:dns").promises;
const net = require("node:net");

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

const USER_AGENT = "damar-mata-dewa/1.0 (+https://github.com/jrxid09-design/Aether)";

function isPrivateIp(ip) {
    if (net.isIPv6(ip)) {
        const lower = ip.toLowerCase();
        return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
            lower.startsWith("fe80") || lower === "::";
    }
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) return true;
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

async function assertPublicHost(url) {
    let hostname;
    try {
        hostname = new URL(url).hostname;
    }
    catch {
        throw new Error("url tidak valid");
    }
    if (net.isIP(hostname)) {
        if (isPrivateIp(hostname)) throw new Error("host privat/loopback ditolak");
        return hostname;
    }
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) throw new Error("host privat/loopback ditolak");
    return hostname;
}

/**
 * Fetch teks/JSON dengan guardrails. Mengembalikan body mentah (string).
 * Melempar Error dengan pesan ringkas bila gagal (untuk failureReason).
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, headers?: object, skipSsrfCheck?: boolean }} opts
 */
async function fetchText(url, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

    // Skip SSRF check hanya untuk tes (inject host lokal). Default SELALU cek.
    if (opts.skipSsrfCheck !== true) {
        await assertPublicHost(url);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...(opts.headers ?? {}) },
            redirect: "follow"
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const reader = response.body?.getReader?.();
        if (!reader) {
            const text = await response.text();
            if (text.length > maxBytes) throw new Error("respons melebihi batas ukuran");
            return text;
        }
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
                try { await reader.cancel(); } catch { /* abaikan */ }
                throw new Error("respons melebihi batas ukuran");
            }
            chunks.push(value);
        }
        const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
        return buffer.toString("utf8");
    }
    catch (error) {
        if (error.name === "AbortError") throw new Error(`timeout setelah ${timeoutMs}ms`);
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}

/** Fetch JSON dengan guardrails (parse aman; lempar bila malformed). */
async function fetchJson(url, opts = {}) {
    const text = await fetchText(url, opts);
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error("respons malformed (bukan JSON)");
    }
}

/**
 * POST urlencoded/JSON dengan guardrails yang sama. Mengembalikan body teks.
 * @param {string} url
 * @param {string|object} body  string (urlencoded) atau objek (di-JSON-kan)
 * @param {{ timeoutMs?: number, maxBytes?: number, form?: boolean }} opts
 */
async function fetchPost(url, body, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (opts.skipSsrfCheck !== true) {
        await assertPublicHost(url);
    }
    const isForm = opts.form !== false && typeof body === "string";
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "User-Agent": USER_AGENT,
                "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json",
                Accept: "application/json"
            },
            body: payload,
            redirect: "follow"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > maxBytes) throw new Error("respons melebihi batas ukuran");
        return text;
    }
    catch (error) {
        if (error.name === "AbortError") throw new Error(`timeout setelah ${timeoutMs}ms`);
        throw error;
    }
    finally {
        clearTimeout(timer);
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

module.exports = { fetchText, fetchJson, fetchPost, fetchPostJson, assertPublicHost, isPrivateIp, USER_AGENT };
