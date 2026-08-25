class RuntimeOptions {

    constructor({

        defaultProvider = null,

        defaultModel = null,

        // Model lokal sering perlu waktu muat model
        // pertama kali, jadi ambangnya lebih longgar dari cloud.
        timeout = 120000,

        retry = {

            enabled: true,

            attempts: 3,

            delay: 1000

        },

        logging = {

            enabled: true

        },

        metrics = {

            enabled: true

        },

        events = {

            enabled: true

        }

    } = {}) {

        this.defaultProvider = defaultProvider;

        this.defaultModel = defaultModel;

        this.timeout = timeout;

        this.retry = {

            ...retry

        };

        this.logging = {

            ...logging

        };

        this.metrics = {

            ...metrics

        };

        this.events = {

            ...events

        };

        // Tanpa batas iterasi tool (praktis tak terbatas) — Aether boleh
        // merangkai tool sebanyak yang dibutuhkan. Rem pengaman tetap ada:
        // RuntimeExecutor akan berhenti bila terdeteksi memanggil tool
        // yang sama berulang tanpa hasil baru (anti loop liar).
        this.maxToolIterations = Number.MAX_SAFE_INTEGER;


    }

}

module.exports = RuntimeOptions;