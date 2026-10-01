class TimeoutExecutor {

    constructor(timeout = 30000) {

        this.timeout = timeout;

    }

    async execute(callback) {

        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error("Request timeout."));
            }, this.timeout);

            // The timeout is a guard, not an owned background task. Clear it
            // on both callback outcomes so completed requests do not retain
            // live timers and keep a test/runtime process open unnecessarily.
            Promise.resolve()
                .then(callback)
                .then(
                    value => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        resolve(value);
                    },
                    error => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        reject(error);
                    }
                );
        });

    }

}

module.exports = TimeoutExecutor;
