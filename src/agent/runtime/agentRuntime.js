const AgentPipeline = require("./agentPipeline");
const AgentState = require("../models/agentState");

class AgentRuntime {

    constructor(phases = []) {
        this.pipeline = new AgentPipeline(phases);
    }

    async run(context) {

        const state = new AgentState(context);

        await this.pipeline.execute(state);

        return state;
    }

}

module.exports = AgentRuntime;