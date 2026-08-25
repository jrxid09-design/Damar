const dns = require("node:dns");
const net = require("node:net");

/**
 * SSRF GUARD — kebijakan fetch untuk URL yang disuplai model/pengguna.
 *
 * Temuan: user → describe_image(url) → visionService.analyzeUrl →
 * server mengambil URL SEMBARANG (localhost, LAN, metadata cloud).
 *
 * Kebijakan:
 *   - skema hanya http/https
 *   - tolak loopback, RFC1918, link-local (termasuk 169.254.169.254),
 *     0.0.0.0/8, CGNAT 100.64/10, dan padanan IPv6 (::1, fc00::/7,
 *     fe80::/10, ::ffff:IPv4-mapped)
 *   - resolve DNS lalu validasi SEMUA alamat hasil resolve
 *   - H2/CLOSURE — ADDRESS PINNING: koneksi HTTP memakai PERSIS satu
 *     alamat yang sudah divalidasi (undici dispatcher + lookup
 *     terkunci); tidak ada re-resolusi OS antara validasi dan
 *     koneksi. Host header, SNI, dan verifikasi sertifikat HTTPS
 *     tetap memakai NAMA host di URL.
 *   - redirect diikuti manual: SETIAP hop mengulang resolve →
 *     validasi → pinned connect; jumlah hop dibatasi
 *   - H3/CLOSURE — trusted-lan hanya percaya ORIGIN dari registry;
 *     SETIAP hop tunduk pada kelas alamat yang DIIZINKAN EKSPLISIT
 *     (publik + RFC1918 + ULA) dengan daftar tolak keras:
 *     link-local/metadata, loopback, unspecified, multicast/reserved,
 *     benchmark, CGNAT.
 *   - M2/CLOSURE — resolver & dispatcher adalah MILIK PER PANGGILAN;
 *     tidak ada state global yang bisa bocor antar invokasi.
 *   - ukuran respons & waktu dibatasi; content-type gambar dituntut
 *     bila diminta
 *
 * DUA KELAS PEMANGGIL:
 *   policy "public"      — URL dari argumen model/user (describe_image)
 *   policy "trusted-lan" — HANYA untuk snapshot kamera/perangkat yang
 *                          terdaftar di registry internal (deviceService),
 *                          bukan karena pemanggilnya tepercaya. URL-nya
 *                          tetap berasal dari konfigurasi pemilik; batas
 *                          skema/waktu/ukuran/kelas-alamat tetap berlaku.
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;   // 10 MB
const DEFAULT_TIMEOUT_MS = 15000;

// ---- Klasifikasi alamat ------------------------------------------------

/** Kelas alamat IPv4 — dasar kebijakan per-hop (H3). */
function ipv4ClassOf(ip) {
    const o = String(ip).split(".").map(Number);
    if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
        return "unparseable";                 // bentuk tak sah → selalu ditolak
    }
    const [a, b] = o;
    if (a === 0) return "unspecified";                       // 0.0.0.0/8
    if (a === 127) return "loopback";                        // 127.0.0.0/8
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)) return "rfc1918";          // privat LAN
    if (a === 100 && b >= 64 && b <= 127) return "cgnat";    // 100.64.0.0/10
    if (a === 169 && b === 254) return "linklocal-metadata"; // termasuk cloud metadata
    if (a === 192 && b === 0) return "reserved";             // 192.0.0.0/24 + TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return "benchmark";
    if (a >= 224) return "multicast-reserved";
    return "public";
}

function expandIPv6(addr) {
    const [head, tail = ""] = addr.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - headParts.length - tailParts.length;
    const parts = [
        ...headParts,
        ...Array(Math.max(0, missing)).fill("0"),
        ...tailParts
    ];
    return parts.map(p => p.padStart(4, "0")).join(":");
}

/** Kelas alamat IPv6 (mapped IPv4 dievaluasi ulang sebagai IPv4). */
function ipv6ClassOf(ip) {

    let addr = String(ip).toLowerCase();

    // IPv4-mapped (::ffff:10.0.0.1) → evaluasi bagian IPv4-nya.
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4ClassOf(mapped[1]);

    // Bentuk penuh untuk prefix check.
    const full = net.isIP(addr) === 6 ? expandIPv6(addr) : null;
    if (!full) return "unparseable";      // tak bisa diurai → selalu ditolak

    const words = full.split(":").map(w => parseInt(w, 16));
    const firstWord = words[0];

    if (words.every(w => w === 0)) return "unspecified";               // ::
    if (words.slice(0, -1).every(w => w === 0) && words[7] === 1) {
        return "loopback";                                              // ::1
    }
    if ((firstWord & 0xfe00) === 0xfc00) return "ula";                  // fc00::/7
    if ((firstWord & 0xffc0) === 0xfe80) return "linklocal-metadata";   // fe80::/10
    if ((firstWord & 0xff00) === 0xff00) return "multicast-reserved";   // ff00::/8
    if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) {
        return ipv4ClassOf(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }

    return "public";
}

function addressClass(address) {
    const family = net.isIP(address);
    if (family === 4) return ipv4ClassOf(address);
    if (family === 6) return ipv6ClassOf(address);
    return "unparseable";                    // bukan IP → tolak
}

function isPrivateAddress(address) {
    return addressClass(address) !== "public";
}

function isPrivateIPv4(ip) { return ipv4ClassOf(ip) !== "public"; }
function isPrivateIPv6(ip) { return ipv6ClassOf(ip) !== "public"; }

// ---- Host metadata (nama) ----------------------------------------------
//
// Cloud metadata kerap juga tertulis sebagai nama; blokir sebelum DNS.

const METADATA_HOSTS = new Set([
    "metadata",
    "instance-data",
    "metadata.google.internal",
    "metadata.goog"
]);

function isMetadataHost(hostLower) {
    if (!hostLower) return false;
    if (METADATA_HOSTS.has(hostLower)) return true;
    for (const m of METADATA_HOSTS) {
        if (hostLower.endsWith("." + m)) return true;
    }
    return false;
}

/** Nama host yang selalu ditolak untuk policy publik. */
function forbiddenPublicHostname(h) {
    return h === "localhost" || h.endsWith(".localhost") ||
        h.endsWith(".local") || h.endsWith(".internal") ||
        isMetadataHost(h);
}

// ---- Kelas alamat yang DIIZINKAN per kebijakan/hop (H3) -----------------
//
// TIDAK ada lagi "lewati semua cek". Kepercayaan trusted-lan menempel
// pada ORIGIN dari registry — redirect destination TIDAK mewarisinya:
//
//   ORIGIN trusted-lan     : publik + RFC1918 + ULA + loopback + CGNAT
//                            (+reserved/benchmark) — milik pemilik.
//   REDIRECT trusted-lan   : publik + RFC1918 + ULA SAJA.
//   policy publik (semua)  : publik saja.
//
// Daftar ini otomatis MENOLAK link-local/metadata, unspecified,
// multicast/reserved — dan untuk redirect juga loopback & CGNAT —
// di SETIAP hop.

function allowedAddressClasses(policy, isOrigin) {

    if (policy === "trusted-lan") {
        if (isOrigin) {
            return new Set([
                "public", "rfc1918", "ula",
                "loopback", "cgnat", "reserved", "benchmark"
            ]);
        }
        // Redirect: kepercayaan TIDAK melompat ke target arbitrer.
        return new Set(["public", "rfc1918", "ula"]);
    }

    return new Set(["public"]);
}

function assertAddressAllowed(address, classes, what) {
    const klass = addressClass(address);
    if (!classes.has(klass)) {
        throw new Error(
            `${what} '${address}' (kelas ${klass}) tidak diizinkan ` +
            `kebijakan ini — ditolak.`);
    }
}

// ---- Resolver per-panggilan (M2) ----------------------------------------
//
// TIDAK ada state resolver global: setiap guardedFetch membawa lookup-nya
// sendiri. Injeksi tes (_lookup) maupun dispatcher dibuat PER PANGGILAN;
// tidak ada invokasi yang bisa mempengaruhi panggilan lain.

function defaultLookup(host, opts) {
    return dns.promises.lookup(host, opts);
}

/** Validasi + resolve satu target; dipakai guardedFetch & pengujian. */
async function assertPublicTarget(rawUrl, opts = {}) {

    const url = parseUrlOrThrow(rawUrl);
    const lookup = typeof opts._lookup === "function" ? opts._lookup : defaultLookup;

    return resolveAndValidate(url, {
        lookup,
        policy: opts.policy ?? "public",
        isOrigin: true
    });

}

function parseUrlOrThrow(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl));
    }
    catch {
        throw new Error(`URL tidak sah: ${String(rawUrl).slice(0, 120)}`);
    }
    if (!ALLOWED_SCHEMES.has(url.protocol)) {
        throw new Error(`Skema '${url.protocol.replace(":", "")}' tidak diizinkan.`);
    }
    return url;
}

/**
 * Resolve → validasi SEMUA jawaban → pilih SATU alamat tervalidasi
 * untuk dipin. Literal IP dinilai langsung tanpa DNS (tidak ada
 * TOCTOU untuk literal — koneksi memang menuju alamat itu sendiri).
 */
async function resolveAndValidate(url, { lookup, policy, isOrigin }) {

    const classes = allowedAddressClasses(policy, isOrigin);
    const host = url.hostname.toLowerCase()
        .replace(/\.$/, "").replace(/^\[|\]$/g, "");

    if (policy !== "trusted-lan" && forbiddenPublicHostname(host)) {
        throw new Error(`Host lokal/metadata tidak diizinkan: ${host}`);
    }
    // Host metadata ditolak di SEMUA kebijakan — kepercayaan registry
    // pada kamera LAN tidak membeli akses ke cloud metadata.
    if (isMetadataHost(host)) {
        throw new Error(`Host metadata tidak diizinkan: ${host}`);
    }

    // Literal IP langsung dinilai.
    if (net.isIP(host) !== 0) {
        assertAddressAllowed(
            host, classes,
            policy === "trusted-lan"
                ? "Alamat target"
                : "Alamat privat/loopback");
        return {
            url,
            pinned: host,
            family: net.isIP(host),
            isLiteral: true
        };
    }

    // Nama domain: resolve lalu nilai SEMUA hasil — satu jawaban di
    // luar kelas yang diizinkan → tolak seluruh target (anti round-
    // robin rebinding tingkat validasi DAN koneksi).
    let resolved;
    try {
        resolved = await lookup(host, { all: true, verbatim: true });
    }
    catch (error) {
        throw new Error(`DNS gagal untuk '${host}': ${error.message}`);
    }

    if (!Array.isArray(resolved) || resolved.length === 0) {
        throw new Error(`DNS tidak menghasilkan alamat untuk '${host}'.`);
    }

    for (const entry of resolved) {
        assertAddressAllowed(
            entry.address, classes,
            `'${host}' me-resolve ke alamat yang tidak diizinkan`);
    }

    return {
        url,
        pinned: resolved[0].address,
        family: resolved[0].family ?? net.isIP(resolved[0].address),
        isLiteral: false
    };

}

// ---- Transport ter-pin (H2) ---------------------------------------------

/**
 * Dispatcher undici yang lookup-nya TERKUNCI pada satu alamat
 * tervalidasi. Tidak ada resolusi OS lagi antara validasi dan
 * koneksi; Host header & servername TLS tetap dari NAMA host di URL
 * (SNI + verifikasi sertifikat tidak tersentuh).
 *
 * Dispatcher dibuat PER HOP dan dihancurkan setelah pemakaian —
 * tidak ada state lintas panggilan (M2).
 */
/** Lookup terkunci pada SATU alamat tervalidasi — dapat diuji langsung. */
function pinnedLookup(pinned, family) {
    return (hostname, options, callback) => {
        const entry = { address: pinned, family: family ?? 4 };
        // hostname sengaja DIABAIKAN: tidak ada resolusi OS kedua.
        if (options && options.all) callback(null, [entry]);
        else callback(null, entry.address, entry.family);
    };
}

/**
 * Fetch dari PAKET undici yang sama dengan Agent-nya.
 *
 * Global fetch milik Node bisa diganti/dibayangi pihak lain saat
 * runtime; Agent dan fetch HARUS satu keluarga undici agar bentuk
 * handler cocok. Referensi fungsi di-cache — bukan state per-panggilan.
 */
let _undiciFetch;
function samePackageFetch() {

    if (_undiciFetch !== undefined) {
        return _undiciFetch;
    }

    try {
        _undiciFetch = require("undici").fetch ?? null;
    }
    catch {
        _undiciFetch = null;
    }

    return _undiciFetch;

}

function makePinnedDispatcher(pinned, family, extraConnect = {}) {

    let undici;
    try {
        undici = require("undici");
    }
    catch {
        return null;                        // pemanggil wajib fail-closed
    }

    return new undici.Agent({
        // Opsi TLS tambahan (mis. ca untuk kamera self-signed dari
        // registry pemilik) HANYA melapisi; lookup tetap terkunci.
        connect: {
            ...extraConnect,
            lookup: pinnedLookup(pinned, family)
        }
    });

}

function destroyDispatcher(agent) {
    try { agent?.destroy?.(); } catch { /* best-effort */ }
}

// ---- Fetch terjaga ------------------------------------------------------

/**
 * Fetch dengan kebijakan SSRF penuh + address pinning per hop.
 *
 * @param {string} rawUrl
 * @param {object} opts { headers?, policy?="public", maxBytes?,
 *                        timeoutMs?, requireImage?=false,
 *                        _fetch? (injeksi tes), _lookup? (injeksi tes) }
 */
async function guardedFetch(rawUrl, opts = {}) {

    const policy = opts.policy ?? "public";

    // M2/CLOSURE — resolver adalah MILIK PANGGILAN INI. Tidak ada
    // mutasi module-global; dua permintaan konkuren tidak mungkin
    // saling mencemari resolver satu sama lain.
    const lookup = typeof opts._lookup === "function"
        ? opts._lookup : defaultLookup;

    const timeoutMs = Number(opts.timeoutMs) > 0
        ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const maxBytes = Number(opts.maxBytes) > 0
        ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;

    const doFetch = opts._fetch ?? ((u, i) => fetch(u, i));

    let current = String(rawUrl);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {

        // SETIAP hop: resolve → validasi semua jawaban → pin SATU
        // alamat tervalidasi. Redirect mengulang siklus penuh untuk
        // tujuan barunya (H2+H3).
        const target = await resolveAndValidate(
            parseUrlOrThrow(current),
            { lookup, policy, isOrigin: hop === 0 }
        );

        const agent = target.isLiteral
            ? null                              // literal: tak ada yang bisa berpindah
            : makePinnedDispatcher(
                target.pinned, target.family, opts.connect ?? {});

        if (!target.isLiteral && !agent) {
            // Tanpa transport ter-pin, fetch akan me-resolve ulang lewat
            // OS — jendela rebinding terbuka lagi. Fail-closed.
            throw new Error(
                "Transport ter-pin (undici) tidak tersedia — " +
                "fetch hostname ditolak (anti DNS rebinding).");
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        // Saat memakai dispatcher, fetch wajib dari keluarga undici yang
        // sama (global fetch bisa dibayangi salinan lain saat runtime).
        const doFetchHop = agent && !opts._fetch
            ? (samePackageFetch() ?? doFetch)
            : doFetch;

        let res;
        try {
            res = await doFetchHop(target.url.toString(), {
                headers: opts.headers ?? {},
                redirect: "manual",         // SETIAP hop divalidasi ulang
                signal: controller.signal,
                ...(agent ? { dispatcher: agent } : {})
            });
        }
        catch (error) {
            clearTimeout(timer);
            destroyDispatcher(agent);
            throw error;
        }

        clearTimeout(timer);

        // Redirect → validasi target hop berikutnya, lanjutkan loop.
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get("location");
            if (!location) {
                destroyDispatcher(agent);
                throw new Error("Redirect tanpa Location.");
            }
            res.body?.cancel?.().catch?.(() => {});
            destroyDispatcher(agent);
            current = new URL(location, current).toString();
            continue;
        }

        if (!res.ok) {
            res.body?.cancel?.().catch?.(() => {});
            destroyDispatcher(agent);
            throw new Error(`Snapshot gagal (${res.status})`);
        }

        // Content-type: gambar diharapkan (opsional dimatikan).
        const contentType = res.headers.get("content-type") ?? "";
        if (opts.requireImage !== false &&
            !contentType.toLowerCase().startsWith("image/")) {
            res.body?.cancel?.().catch?.(() => {});
            destroyDispatcher(agent);
            throw new Error(
                `Konten '${contentType.split(";")[0] || "tidak diketahui"}' ` +
                "bukan gambar."
            );
        }

        try {

            // Batas ukuran: baca bertahap, abort saat melampaui.
            const reader = res.body?.getReader?.();

            if (!reader) {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > maxBytes) throw new Error("Respons melebihi batas ukuran.");
                return { response: res, buffer: buf };
            }

            const chunks = [];
            let total = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel().catch(() => {});
                    throw new Error("Respons melebihi batas ukuran.");
                }
                chunks.push(Buffer.from(value));
            }

            return { response: res, buffer: Buffer.concat(chunks) };

        }
        finally {
            destroyDispatcher(agent);       // body sudah selesai dibaca
        }

    }

    throw new Error(`Terlalu banyak redirect (> ${MAX_REDIRECTS}).`);

}

module.exports = {
    guardedFetch, assertPublicTarget,
    isPrivateAddress, isPrivateIPv4, isPrivateIPv6,
    addressClass, allowedAddressClasses, isMetadataHost,
    pinnedLookup, makePinnedDispatcher,
    MAX_REDIRECTS, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS
};
