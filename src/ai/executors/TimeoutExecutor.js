class TimeoutExecutor {

    constructor(timeout = 30000) {

        this.timeout = timeout;

    }

    async execute(callback) {

        return Promise.race([

            callback(),

            new Promise((_, reject) => {

                setTimeout(() => {

                    reject(
                        new Error("Request timeout.")
                    );

                }, this.timeout);

            })

        ]);

    }

}

module.exports = TimeoutExecutor;