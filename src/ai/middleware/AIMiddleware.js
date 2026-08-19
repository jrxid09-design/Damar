class AIMiddleware {

    async handle(context, next) {

        await next();

    }

}

module.exports = AIMiddleware;