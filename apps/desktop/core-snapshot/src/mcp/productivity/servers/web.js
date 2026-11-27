"use strict";

const dns = require("node:dns/promises");
const net = require("node:net");
const { SERVER_BY_ID } = require("../registry");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server web — ambil halaman (fetch → teks terbaca) + pencarian web.
 * Tanpa login. Penjagaan egress minimum di sini (modul ini adalah
 * permukaan keluar suite):
 *   - hanya http/https;
 *   - host literal IP privat/loopback/link-local ditolak, dan nama
 *     host di-resolve lalu alamatnya diperiksa dengan aturan sama
 *     (SSRF dasar) — pemeriksaan ulang di setiap lompatan redirect;
 *   - ukuran respons dan waktu dibatasi.
 * Kebijakan egress yang lebih kaya (allowlist domain dsb.) adalah
 * lapisan kebijakan Damar di atas tool ini, bukan di dalam tool.
 */

const SERVER_ID = "web";
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2_000_000;

function isPrivateIp(ip) {
    if (!net.isIP(ip)) return false;
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split(".").map(Number);
        return a === 10 || a === 127 || a === 0
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254)
            || (a === 100 && b >= 64 && b <= 127);
    }
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

async function assertPublicUrl(rawUrl, lookup = dns.lookup) {
    let url;
    try { url = new URL(rawUrl); } catch { throw new ToolError(`URL tidak sah: ${rawUrl}`, "URL_INVALID"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ToolError("Hanya URL http/https yang diizinkan.", "URL_SCHEME_BLOCKED");
    }
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local")) {
        throw new ToolError("Host lokal ditolak.", "URL_HOST_BLOCKED");
    }
    if (net.isIP(host)) {
        if (isPrivateIp(host)) throw new ToolError("Alamat IP privat/loopback ditolak.", "URL_HOST_BLOCKED");
        return url;
    }
    const answers = await lookup(host, { all: true }).catch(() => []);
    for (const a of answers) {
        if (isPrivateIp(a.address)) {
            throw new ToolError("Host menunjuk alamat privat/loopback — ditolak.", "URL_HOST_BLOCKED");
        }
    }
    return url;
}

/** Ekstraksi teks terbaca sederhana: buang script/style/tag, rapikan. */
function htmlToText(html) {
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
}

function parseSearchResults(html, max) {
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null && out.length < max) {
        let href = m[1];
        try {
            const u = new URL(href, "https://duckduckgo.com");
            const uddg = u.searchParams.get("uddg");
            if (uddg) href = decodeURIComponent(uddg);
        } catch { /* biarkan apa adanya */ }
        out.push({
            title: htmlToText(m[2]),
            url: href,
            snippet: htmlToText(m[3])
        });
    }
    return out;
}

function createServer({ fetch: fetchImpl, lookup } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const doFetch = fetchImpl || globalThis.fetch;

    async function fetchChecked(rawUrl) {
        let url = await assertPublicUrl(rawUrl, lookup);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const res = await doFetch(url.toString(), {
                redirect: "manual",
                headers: { "user-agent": "DamarMCP/1.0 (+productivity-web)", accept: "text/html,application/xhtml+xml,text/plain" }
            });
            if ([301, 302, 303, 307, 308].includes(res.status)) {
                const loc = res.headers.get("location");
                if (!loc) throw new ToolError(`Redirect tanpa lokasi (HTTP ${res.status}).`, "FETCH_FAILED");
                url = await assertPublicUrl(new URL(loc, url).toString(), lookup);
                continue;
            }
            if (!res.ok) throw new ToolError(`HTTP ${res.status} saat mengambil ${url.hostname}.`, "FETCH_FAILED");
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_RESPONSE_BYTES) {
                throw new ToolError("Respons terlalu besar (>2MB).", "FETCH_TOO_LARGE");
            }
            return { url: url.toString(), contentType: res.headers.get("content-type") || "", text: buf.toString("utf8") };
        }
        throw new ToolError("Terlalu banyak redirect.", "FETCH_FAILED");
    }

    async function callTool(name, args = {}) {
        switch (name) {

            case "web_fetch": {
                const page = await fetchChecked(args.url);
                const isHtml = /html/i.test(page.contentType) || /^\s*</.test(page.text);
                const text = isHtml ? htmlToText(page.text) : page.text;
                const cap = args.maxChars ?? 20000;
                return { url: page.url, truncated: text.length > cap, text: text.slice(0, cap) };
            }

            case "web_search": {
                const q = encodeURIComponent(String(args.query ?? ""));
                if (!q) throw new ToolError("Query wajib diisi.", "QUERY_REQUIRED");
                const res = await doFetch(`https://html.duckduckgo.com/html/?q=${q}`, {
                    headers: { "user-agent": "DamarMCP/1.0 (+productivity-web)" }
                });
                if (!res.ok) throw new ToolError(`Pencarian gagal (HTTP ${res.status}).`, "SEARCH_FAILED");
                const html = await res.text();
                return { query: args.query, results: parseSearchResults(html, args.maxResults ?? 5) };
            }

            default:
                throw new ToolError(`Tool tidak dikenal: ${name}`, "UNKNOWN_TOOL");
        }
    }

    return createServerDefinition({
        name: SERVER_ID,
        tools: descriptor.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        callTool,
        health: async () => ({ ok: true })
    });
}

module.exports = { createServer, SERVER_ID, htmlToText, parseSearchResults, isPrivateIp, assertPublicUrl };
