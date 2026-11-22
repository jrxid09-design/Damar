/**
 * RE Intelligence — identitas artifact.
 *
 * SHA-256 dihitung streaming (chunk 1 MiB) agar file besar tidak
 * dimuat utuh ke RAM hanya untuk hashing. ArtifactId diturunkan
 * deterministik dari hash + ukuran — dua pembacaan file sama
 * menghasilkan ID yang sama.
 */

"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

const HASH_ALGO = "sha256";
const STREAM_CHUNK = 1024 * 1024;

/** Hash streaming dari file path. Mengembalikan hex digest penuh. */
function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(HASH_ALGO);
        const stream = fs.createReadStream(filePath, {
            highWaterMark: STREAM_CHUNK
        });
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

/** Hash buffer (untuk fixture/embedded artifact kecil). */
function sha256Buffer(buffer) {
    return crypto.createHash(HASH_ALGO).update(buffer).digest("hex");
}

/**
 * ArtifactId stabil: prefiks versi skema + hash + ukuran.
 * Ukuran disertakan sebagai sanity tambahan; hash tetap kunci utama.
 */
function deriveArtifactId(sha256Hex, sizeBytes) {
    return `rei1-${sha256Hex}-${String(sizeBytes)}`;
}

module.exports = { sha256File, sha256Buffer, deriveArtifactId, HASH_ALGO };
