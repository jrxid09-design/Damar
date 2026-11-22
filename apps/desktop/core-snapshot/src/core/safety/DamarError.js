/**
 * Error terstruktur Damar (§110).
 *
 * String exception tidak cukup: pemulihan yang benar butuh tahu
 * apakah sebuah kegagalan layak diulang, seberapa parah, dan apa
 * langkah pemulihannya. Semua itu hilang kalau error cuma teks.
 *
 * Dipakai di batas modul. Error bawaan Node tetap boleh di dalam
 * satu modul; yang menyeberang batas harus terstruktur.
 */
class DamarError extends Error {

    /**
     * @param {object} spec
     * @param {string}  spec.code       kode stabil, mis. "SAFETY_STOP_ENGAGED"
     * @param {string}  spec.message    penjelasan untuk manusia
     * @param {string} [spec.severity]  info | degraded | error | critical
     * @param {boolean}[spec.retryable] apakah mengulang masuk akal
     * @param {string} [spec.cause]     penyebab yang teramati
     * @param {string} [spec.recovery]  langkah pemulihan yang disarankan
     * @param {object} [spec.details]   konteks tambahan
     */
    constructor({
        code,
        message,
        severity = "error",
        retryable = false,
        cause = null,
        recovery = null,
        details = null
    }) {

        super(message);

        this.name = "DamarError";
        this.code = code;
        this.severity = severity;
        this.retryable = retryable;
        this.cause = cause;
        this.recovery = recovery;
        this.details = details;

    }

    /** Bentuk yang aman dikirim lewat API/log. */
    toJSON() {

        return {
            error_code: this.code,
            message: this.message,
            severity: this.severity,
            retryable: this.retryable,
            cause: this.cause,
            recovery: this.recovery,
            details: this.details
        };

    }

}

module.exports = DamarError;
