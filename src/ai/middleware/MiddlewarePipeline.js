class MiddlewarePipeline {

    constructor() {

        this.middlewares = [];

    }

    use(middleware) {

        this.middlewares.push(middleware);

        return this;

    }

    async execute(context, last) {

        let index = -1;

        const dispatch = async (i) => {

            if (i <= index) {

                throw new Error(
                    "next() called multiple times."
                );

            }

            index = i;

            let fn = this.middlewares[i];

            if (!fn) {

                fn = last;

            }

            if (!fn) {

                return;

            }

            await fn(

                context,

                () => dispatch(i + 1)

            );

        };

        await dispatch(0);

    }

}

module.exports = MiddlewarePipeline;