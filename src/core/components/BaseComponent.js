const { BaseLifecycle } = require("../lifecycle");

const ConfigManager = require("../config/ConfigManager");

const Result = require("../models/Result");

const logger = require("../../utils/logger");

/**
 * Basis untuk service, provider, dan tool.
 *
 * Menyediakan tiga hal yang dibutuhkan hampir semua turunan:
 * logging berlabel, akses konfigurasi, dan pembungkus hasil
 * sukses/gagal — sebelumnya dipanggil turunan (this.debug,
 * this.ok, this.getConfig) tanpa pernah didefinisikan.
 */
class BaseComponent extends BaseLifecycle {

    constructor(metadata = {}) {

        super();

        // Turunan lama memanggil super("Nama"); yang baru mengirim
        // objek metadata. Keduanya diterima.
        this.metadata =
            typeof metadata === "string"
                ? { name: metadata }
                : (metadata ?? {});

    }

    get name() {

        return this.metadata?.name ?? this.constructor.name;

    }

    // ---- Logging ------------------------------------------------

    label(message) {

        return `[${this.name}] ${message}`;

    }

    debug(message) {

        if (ConfigManager.get("logger.level", "INFO") === "DEBUG") {
            logger.info(this.label(message));
        }

    }

    info(message) {

        logger.info(this.label(message));

    }

    warn(message) {

        logger.warn(this.label(message));

    }

    error(error) {

        logger.error(
            this.label(error?.stack ?? error?.message ?? String(error))
        );

    }

    // ---- Konfigurasi ---------------------------------------------

    getConfig(path, defaultValue = null) {

        return ConfigManager.get(path, defaultValue);

    }

    setConfig(path, value) {

        ConfigManager.set(path, value);

        return this;

    }

    // ---- Hasil ----------------------------------------------------

    ok(data = null) {

        return Result.ok(data);

    }

    fail(error) {

        return Result.fail(
            error instanceof Error ? error.message : error
        );

    }

}

module.exports = BaseComponent;
