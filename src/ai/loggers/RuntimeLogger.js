class RuntimeLogger {

    constructor(logger = null) {

        this.logger = logger;

    }

    started(provider, request) {

        if (!this.logger) {
            return;
        }

        this.logger.info(
            `[AI] Request started (provider=${provider}, model=${request.model})`
        );

    }

    completed(provider, duration) {

        if (!this.logger) {
            return;
        }

        this.logger.info(
            `[AI] Request completed (provider=${provider}, duration=${duration} ms)`
        );

    }

    failed(provider, error) {

        if (!this.logger) {
            return;
        }

        this.logger.error(
            `[AI] Request failed (provider=${provider}): ${error.message}`
        );

    }

}

module.exports = RuntimeLogger;