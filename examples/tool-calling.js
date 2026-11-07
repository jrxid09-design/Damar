const {
    AITool
} = require("../tools");

const timeTool = new AITool({

    name: "get_time",

    description: "Get current time",

    parameters: {

        type: "object",

        properties: {}

    },

    execute: async () => {

        return {

            time: new Date().toISOString()

        };

    }

});