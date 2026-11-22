class RuntimeMetrics {

    constructor() {

        this.reset();

    }

    reset() {

        this.requests = 0;

        this.success = 0;

        this.failed = 0;

        this.totalDuration = 0;

        this.totalTokens = 0;

    }

    recordSuccess({

        duration = 0,

        tokens = 0

    } = {}) {

        this.requests++;

        this.success++;

        this.totalDuration += duration;

        this.totalTokens += tokens;

    }

    recordFailure({

        duration = 0

    } = {}) {

        this.requests++;

        this.failed++;

        this.totalDuration += duration;

    }

    get averageDuration() {

        if (!this.requests) {

            return 0;

        }

        return this.totalDuration / this.requests;

    }

    get successRate() {

        if (!this.requests) {

            return 0;

        }

        return (this.success / this.requests) * 100;

    }

    toJSON() {

        return {

            requests: this.requests,

            success: this.success,

            failed: this.failed,

            totalDuration: this.totalDuration,

            averageDuration: this.averageDuration,

            totalTokens: this.totalTokens,

            successRate: this.successRate

        };

    }

}

module.exports = RuntimeMetrics;