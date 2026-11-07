const crypto = require("node:crypto");

const response = require("../../utils/response");

/**
 * Perbandingan token yang aman terhadap timing attack.
 *
 * Sebelumnya token dibanding `provided !== token` — rentan timing
 * attack di LAN (string berbeda panjang bocor lewat selisih waktu).
 * Kini kedua sisi di-hash SHA-256 dulu (panjang jadi tetap 32 byte)
 * lalu dibanding `crypto.timingSafeEqual` (waktu konstan).
 */

/** Ambil token dari header Authorization: Bearer atau ?token=. */
function extractToken(req) {

    const header = req.headers?.authorization ?? "";

    if (header.startsWith("Bearer ")) {
        return header.slice(7).trim();
    }

    const query = req.query?.token;

    return query === undefined || query === null ? null : String(query);

}

/** Banding dua token secara waktu-konstan (true bila sama). */
function tokensEqual(provided, expected) {

    if (typeof provided !== "string" || typeof expected !== "string") {
        return false;
    }

    const a = crypto.createHash("sha256").update(provided).digest();
    const b = crypto.createHash("sha256").update(expected).digest();

    return crypto.timingSafeEqual(a, b);

}

/**
 * N1 — bukti lokalitas klien dari TRANSPORT, bukan dari klien.
 *
 * Header Host dikendalikan klien sepenuhnya; `Host: localhost` dari
 * mesin lain TIDAK boleh dihitung lokal. Sumber kebenaran: alamat
 * remote socket (req.ip Express / req.socket.remoteAddress).
 * Fail-closed: tanpa alamat → dianggap TIDAK lokal.
 */
function isLocalRequest(req) {

    // socket.remoteAddress lebih dipilih daripada req.ip: req.ip bisa
    // berasal dari header X-Forwarded-For (bila trust proxy aktif) —
    // kembali dikendalikan klien. Alamat socket tidak bisa dipalsukan.
    const raw = req.socket?.remoteAddress ?? req.ip ?? "";

    const ip = String(raw).replace(/^::ffff:/i, "").toLowerCase();

    return ip === "::1" || ip === "127.0.0.1";

}

/**
 * G-FINAL — PERAN EKSTERNAL DIKUNCI PADA ENUM EKSTERNAL.
 *
 * DAMAR_AUTH_ROLE / DAMAR_MCP_ROLE / DAMAR_UNSAFE_DEV_ROLE adalah
 * STRING LINGKUNGAN — tidak boleh bisa mencetak otoritas runtime
 * "system" di permukaan token/MCP. Nilai apa pun di luar enum
 * eksternal (termasuk "system", typo, kosong) jatuh ke fallback
 * least-privilege. 'system' tetap otoritas INTERNAL runtime: satu-
 * satunya penciptanya Authorization.resolveDelegator lewat batas
 * otonom in-process (internal:true + symbol) — TIDAK ada override
 * environment menuju system, disengaja maupun tidak.
 */
const EXTERNAL_ROLES = Object.freeze(["user", "admin", "superadmin"]);

function clampExternalRole(value, fallback = "user") {
    const role = String(value ?? "").toLowerCase().trim();
    return EXTERNAL_ROLES.includes(role) ? role : fallback;
}

/**
 * Middleware penjaga token — FAIL-CLOSED (temuan C2 Round-2).
 *
 * Dulu: DAMAR_TOKEN kosong → API terbuka "untuk pengembangan" sambil
 * bind 0.0.0.0 (server.js:29) dan controller memberi role superadmin —
 * fail-open penuh di permukaan LAN.
 *
 * Sekarang (permukaan terlindungi):
 *   1. DAMAR_TOKEN kosong → 503 SERVICE LOCKED, BUKAN open;
 *   2. satu-satunya pintu dev: DAMAR_UNSAFE_DEV_OPEN_API="1"
 *      (eksplisit, default OFF, tak mungkin aktif karena lupa config);
 *      peran dev diikat localhost kecuali ditinggikan eksplisit;
 *   3. token sah → req.authIdentity { role, source:'token' } —
 *      otoritas selalu berprovenance, tidak pernah implisit-superadmin.
 *
 * `roleWhenAuthenticated` ditentukan permukaan pemanggil (Console =
 * pemilik lokal dengan token; API eksternal default 'user').
 */
function tokenGuard({ roleWhenAuthenticated = "user", surface = "api" } = {}) {

    // Permukaan pemanggil juga dikunci: param kode pun tak boleh
    // minta peran di luar enum eksternal (mis. "system").
    const authRole = clampExternalRole(roleWhenAuthenticated, "user");

    return (req, res, next) => {

        if (req.method === "OPTIONS") return next();

        const token = process.env.DAMAR_TOKEN;

        // ---- 1. Token belum diset: KUNCI, jangan buka ----------------
        if (!token) {

            const devOpen = process.env.DAMAR_UNSAFE_DEV_OPEN_API === "1";

            if (!devOpen) {
                return response.error(
                    res,
                    "Layanan terkunci: DAMAR_TOKEN belum diset. " +
                    "Set token, atau setel DAMAR_UNSAFE_DEV_OPEN_API=1 " +
                    "secara sadar untuk mode pengembangan berisiko.",
                    503
                );
            }

            // Mode dev eksplisit: identitas terbatas; superadmin dev
            // hanya untuk klien yang BENAR-BENAR lokal (alamat socket,
            // N1 — bukan header Host yang bisa dipalsukan).
            const isLocal = isLocalRequest(req);

            const devRole = isLocal
                ? clampExternalRole(process.env.DAMAR_UNSAFE_DEV_ROLE, "user")
                : "user";

            req.authIdentity = {
                role: devRole,
                source: `dev-open:${surface}`,
                sessionId: `${surface}:dev:${req.ip ?? "local"}`
            };

            return next();
        }

        // ---- 2. Token diset: wajib cocok (waktu-konstan) -------------
        if (!tokensEqual(extractToken(req), token)) {

            return response.error(
                res,
                "Unauthorized. Sertakan header 'Authorization: Bearer <DAMAR_TOKEN>'.",
                401
            );

        }

        // ---- 3. Terautentikasi: identitas berprovenance ---------------
        // G-FINAL: env tidak bisa mencetak "system" di sini — clamp.
        req.authIdentity = {
            role: clampExternalRole(process.env.DAMAR_AUTH_ROLE, authRole),
            source: `token:${surface}`,
            sessionId: `${surface}:${req.ip ?? "unknown"}`
        };

        next();

    };

}

module.exports = {
    tokensEqual, extractToken, tokenGuard, isLocalRequest,
    EXTERNAL_ROLES, clampExternalRole
};
