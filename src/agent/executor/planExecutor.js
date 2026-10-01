const AgentPhase = require("../runtime/agentPhase");
const ExecutionResult = require("./executionResult");
const Observation = require("../models/observation");

const { executeCanonicalAction } = require("../../services/canonicalActionClient");

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

                const output = await executeCanonicalAction({
                    context: state?.executionContext ?? state?.context ?? state,
                    capabilityId: toolName,
                    operation: step.operation ?? "execute",
                    arguments: step.arguments ?? {},
                    expectedPostcondition: step.expectedPostcondition ?? null
                });

                // A handler/result is never equivalent to verified effect.
                // Plans therefore accept only the Manager's verified
                // completion outcome; ambiguity and verification failure stay
                // failures/observations.
                if (output?.outcome !== "COMPLETED") {
                    throw new Error(output?.reason ?? output?.detail ?? output?.outcome ?? "canonical action denied");
                }

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
