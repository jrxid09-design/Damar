/**
 * Retry dengan exponential backoff.
 *
 * Error validasi/otorisasi sengaja tidak di-retry karena
 * mengulanginya hanya membuang waktu dan token.
 */
class RetryExecutor {

    constructor({
        enabled = true,
        attempts = 3,
        delay = 1000,
        factor = 2,
        maxDelay = 15000
    } = {}) {

        this.enabled = enabled;

        this.attempts = attempts;

        this.delay = delay;

        this.factor = factor;

        this.maxDelay = maxDelay;

    }

    async execute(callback) {

        if (!this.enabled || this.attempts <= 1) {
            return callback();
        }

        let lastError = null;

        for (let attempt = 1; attempt <= this.attempts; attempt++) {

            try {

                return await callback();

            }

            catch (error) {

                lastError = error;

                if (
                    attempt === this.attempts ||
                    !this.isRetryable(error)
                ) {

                    throw error;

                }

                await this.sleep(
                    Math.min(
                        this.delay * Math.pow(this.factor, attempt - 1),
                        this.maxDelay
                    )
                );

            }

        }

        throw lastError;

    }

    isRetryable(error) {

        const message = String(error?.message ?? "").toLowerCase();

        const permanent = [
            "unauthorized",
            "forbidden",
            "invalid api key",
            "not found",
            "must be a string",
            "is required",
            "cannot be empty",
            "maximum tool iterations"
        ];

        return !permanent.some(token => message.includes(token));

    }

    sleep(ms) {

        return new Promise(resolve => setTimeout(resolve, ms));

    }

}

module.exports = RetryExecutor;
