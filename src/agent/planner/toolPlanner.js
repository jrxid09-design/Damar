const AgentPhase = require("../runtime/agentPhase");

const rulePlanner = require("./rulePlanner");
const llmPlanner = require("./llmPlanner");

class ToolPlanner extends AgentPhase {

    async run(state) {

        console.log("Planner Mode:", process.env.PLANNER_MODE);

        if (process.env.PLANNER_MODE === "llm") {

            state.plan = await llmPlanner.plan(state);

        } else {

            state.plan = rulePlanner.plan(state.context);

        }

        console.log(
            "Execution Plan:",
            JSON.stringify(state.plan, null, 2)
        );

    }

}

module.exports = ToolPlanner;