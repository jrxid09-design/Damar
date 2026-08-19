/**
 * CORS untuk Aether Console.
 *
 * Renderer Electron memuat berkas lewat file://, sehingga
 * Origin-nya "null" — tidak bisa dicocokkan dengan allowlist
 * berbasis host. Karena daemon ini memang ditujukan untuk
 * jaringan pribadi, origin diizinkan luas dan pengamanan
 * sesungguhnya diserahkan ke token (lihat middleware/auth.js).
 */
module.exports = (req, res, next) => {

    const origin = req.headers.origin;

    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");

    res.setHeader("Vary", "Origin");

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );

    // X-Aether-Channel WAJIB terdaftar di sini.
    //
    // Header kustom apa pun memicu preflight, dan preflight yang tidak
    // mendaftarkannya membuat browser MEMBATALKAN permintaannya — bukan
    // sekadar membuang headernya. Karena Console menyertakan header ini
    // di SETIAP panggilan (supaya Aether tahu percakapan berlangsung di
    // kanal mana), melewatkannya di sini akan mematikan seluruh Console
    // sekaligus, bukan satu fitur saja.
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,X-Aether-Channel"
    );

    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();

};
