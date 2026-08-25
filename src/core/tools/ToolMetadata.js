class ToolMetadata {

    constructor(options = {}) {

        Object.assign(this, {

            name: "",

            category: "",

            description: "",

            version: "1.0.0",

            permissions: [],

            tags: [],

            examples: [],

            parameters: {}

        }, options);

    }

}

module.exports = ToolMetadata;