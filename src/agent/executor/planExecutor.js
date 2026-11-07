const AgentPhase = require("../runtime/agentPhase");
const ExecutionResult = require("./executionResult");
const Observation = require("../models/observation");

const pluginManager = require("../../plugins/pluginManager");

class PlanExecutor extends AgentPhase {

    async run(state) {

        state.execution = await this.execute(
            state.plan,
            state
        );

        state.observations =
            state.execution.observations;

    }

    async execute(plan, state) {

        const result = new ExecutionResult();

        if (!plan?.steps?.length) {
            return result;
        }

        for (const step of plan.steps) {

            const toolName = step.tool;

            if (!toolName) {

                result.add(
                    new Observation({
                        success: false,
                        error: "Step does not contain a tool."
                    })
                );

                continue;

            }

            console.log(
                `[Executor] ${toolName}`
            );

            try {

                const output =
                    await pluginManager.execute(
                        toolName,
                        state,
                        step.arguments ?? {}
                    );

                if (output === undefined) {

                    throw new Error(
                        `Tool "${toolName}" returned undefined.`
                    );

                }

                result.add(
                    new Observation({
                        tool: toolName,
                        success: true,
                        result: output
                    })
                );

            } catch (err) {

                console.error(
                    `[Executor] ${toolName}`,
                    err
                );

                result.add(
                    new Observation({
                        tool: toolName,
                        success: false,
                        error: err.message
                    })
                );

            }

        }

        return result;

    }

}

module.exports = PlanExecutor;