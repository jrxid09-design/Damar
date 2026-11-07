class ToolContext {

    constructor(context = {}) {

        Object.assign(this, {

            config: null,

            logger: null,

            cache: null,

            session: null,

            agent: null,

            plugin: null,

            executionId: null,

            memory: null

        }, context);

    }

}

module.exports = ToolContext;