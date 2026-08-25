const BaseComponent = require("../components/BaseComponent");

const ToolSchema = require("./ToolSchema");

const ToolResult = require("./ToolResult");

class BaseTool extends BaseComponent {

    constructor(metadata = {}) {

        super(metadata.name);

        this.metadata = metadata;

        this.schema = new ToolSchema(

            metadata.parameters || {}

        );

    }

    async run(args = {}, context = null) {

        const started = Date.now();

        try {

            await this.validate(args);

            await this.beforeExecute(args, context);

            const result = await this.execute(args, context);

            await this.afterExecute(result, context);

            return ToolResult.ok(

                result,

                {

                    tool: this.metadata.name,

                    duration: Date.now() - started

                }

            );

        }

        catch (error) {

            this.error(error);

            return ToolResult.fail(

                error.message,

                {

                    tool: this.metadata.name,

                    duration: Date.now() - started

                }

            );

        }

    }

    async validate(args) {

        this.schema.validate(args);

    }

    async beforeExecute(args, context) {}

    async afterExecute(result, context) {}

    async execute() {

        throw new Error(

            "execute() not implemented."

        );

    }

}

module.exports = BaseTool;