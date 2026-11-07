const fs = require("node:fs");
const path = require("node:path");

/**
 * Penyimpan konfigurasi berbasis satu berkas JSON.
 *
 * Penulisan dilakukan lewat berkas sementara lalu di-rename,
 * supaya konfigurasi tidak pernah setengah tertulis kalau proses
 * mati di tengah penyimpanan.
 */
class JsonStore {

    constructor(filePath, defaults = {}) {

        this.filePath = filePath;

        this.defaults = defaults;

        this.cache = null;

    }

    read() {

        if (this.cache) {
            return this.cache;
        }

        if (!fs.existsSync(this.filePath)) {

            this.cache = structuredClone(this.defaults);

            return this.cache;

        }

        try {

            this.cache = {
                ...structuredClone(this.defaults),
                ...JSON.parse(fs.readFileSync(this.filePath, "utf8"))
            };

        }

        catch {

            // Berkas rusak: pakai default daripada menggagalkan boot.
            this.cache = structuredClone(this.defaults);

        }

        return this.cache;

    }

    write(data) {

        const merged = {
            ...this.read(),
            ...data,
            updatedAt: new Date().toISOString()
        };

        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

        const temporary = `${this.filePath}.tmp`;

        fs.writeFileSync(
            temporary,
            JSON.stringify(merged, null, 2),
            "utf8"
        );

        fs.renameSync(temporary, this.filePath);

        this.cache = merged;

        return merged;

    }

    reset() {

        this.cache = null;

        return this.read();

    }

}

module.exports = JsonStore;
