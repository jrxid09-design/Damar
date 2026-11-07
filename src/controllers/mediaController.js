const fs = require("node:fs");
const path = require("node:path");

const { CACHE_DIR } = require("../services/streamResolver");

/**
 * Sajikan media terunduh (mp4) dari cache lokal daemon, dengan
 * dukungan Range (HTTP 206) agar <video> bisa seek dan buffer maju.
 *
 * Berkas ini diunduh sekali oleh streamResolver.downloadMedia agar
 * pemutaran di Console tak menembak googlevideo berulang (sumber
 * "429 Too Many Requests" + macet). Route berada di bawah router
 * console yang memakai auth; middleware auth menerima token lewat
 * header ATAU query (?token=), jadi <video src=…?token=…> tetap sah.
 */
function serve(req, res) {

    // Hanya nama berkas sederhana; cegah path-traversal.
    const name = String(req.params.id ?? "").replace(/[^\w.-]/g, "");
    const file = path.join(CACHE_DIR, name);

    if (file !== CACHE_DIR && !file.startsWith(CACHE_DIR + path.sep)) {
        res.status(403).end();
        return;
    }

    let stat;
    try {
        stat = fs.statSync(file);
    }
    catch {
        res.status(404).end("Media belum siap");
        return;
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");

    const range = req.headers.range;

    if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? parseInt(m[1], 10) : 0;
        const end = (m && m[2]) ? parseInt(m[2], 10) : stat.size - 1;

        if (start >= stat.size || end >= stat.size || start > end) {
            res.status(416).setHeader("Content-Range", `bytes */${stat.size}`);
            res.end();
            return;
        }

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        res.setHeader("Content-Length", end - start + 1);
        fs.createReadStream(file, { start, end }).pipe(res);
    }
    else {
        res.setHeader("Content-Length", stat.size);
        fs.createReadStream(file).pipe(res);
    }

}

module.exports = { serve };
