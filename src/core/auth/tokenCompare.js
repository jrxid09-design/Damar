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
 * Middleware penjaga token opsional. Bila AETHER_TOKEN kosong, API
 * dibiarkan terbuka (pengembangan); bila diset, wajib cocok.
 */
function tokenGuard() {

    return (req, res, next) => {

        const token = process.env.AETHER_TOKEN;

        if (!token) {
            return next();
        }

        if (req.method === "OPTIONS") {
            return next();
        }

        if (!tokensEqual(extractToken(req), token)) {

            return response.error(
                res,
                "Unauthorized. Sertakan header 'Authorization: Bearer <AETHER_TOKEN>'.",
                401
            );

        }

        next();

    };

}

module.exports = { tokensEqual, extractToken, tokenGuard };
