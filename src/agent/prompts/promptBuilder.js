const plannerPrompt = require("./plannerPrompt");
const reasoningPrompt = require("./reasoningPrompt");
const reflectionPrompt = require("./reflectionPrompt");

const pluginRegistry = require("../../plugins/pluginRegistry");

class PromptBuilder {

    buildPlanner(state) {

        const tools = pluginRegistry
            .all()
            .flatMap(plugin => plugin.instance.tools)
            .map(tool =>
                `- ${tool.name}: ${tool.description}`
            )
            .join("\n");

        const systemPrompt = plannerPrompt.replace(
            "{{tools}}",
            tools
        );

        return {
            systemPrompt,
            history: state.context.history
        };

    }

    buildReasoning(state) {

        const history = [...state.context.history];

        if (state.observations?.length) {

            history.push({
                role: "system",
                content:
`The following tools have already been executed successfully.

Tool Observations:

${JSON.stringify(state.observations, null, 2)}

Use these tool observations as the source of truth.

If a successful tool observation exists, use it directly in your answer.

Do NOT say that you cannot access the requested information if a tool has already provided it.`
            });

        }

        return {
            systemPrompt: reasoningPrompt,
            history
        };

    }

    buildReflection(state) {

        return {
            systemPrompt: reflectionPrompt,
            history: state.context.history
        };

    }

}

module.exports = new PromptBuilder();