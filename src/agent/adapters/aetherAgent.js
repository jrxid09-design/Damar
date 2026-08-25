const AgentRuntime = require("../runtime/agentRuntime");

const ToolPlanner = require("../planner/toolPlanner");
const PlanExecutor = require("../executor/planExecutor");
const Reasoner = require("../reasoning/reasoner");
const Reflection = require("../reflection/reflectionEngine");

class AetherAgent {

    constructor() {

        this.runtime = new AgentRuntime([

            new ToolPlanner(),

            new PlanExecutor(),

            new Reasoner(),

            new Reflection()

        ]);

    }

    async run(context) {

        const state =
            await this.runtime.run(context);

        return state.response;

    }

}

module.exports = new AetherAgent();