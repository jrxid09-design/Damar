const response = require("../utils/response");

/**
 * Penjaga token opsional untuk bidang kendali.
 *
 * Saat daemon dijalankan di PC rumah, port-nya terbuka ke LAN —
 * siapa pun di jaringan yang sama bisa memanggil API ini. Set
 * AETHER_TOKEN di .env PC tersebut untuk menutupnya, lalu isi
 * token yang sama di Aether Console.
 *
 * Tanpa AETHER_TOKEN, API dibiarkan terbuka agar pengembangan di
 * laptop tetap ringan.
 */
module.exports = (req, res, next) => {

    const token = process.env.AETHER_TOKEN;

    if (!token) {
        return next();
    }

    // Preflight tidak membawa header Authorization.
    if (req.method === "OPTIONS") {
        return next();
    }

    const header = req.headers.authorization ?? "";

    const provided = header.startsWith("Bearer ")
        ? header.slice(7).trim()
        : req.query.token;

    if (provided !== token) {

        return response.error(
            res,
            "Unauthorized. Sertakan header 'Authorization: Bearer <AETHER_TOKEN>'.",
            401
        );

    }

    next();

};
