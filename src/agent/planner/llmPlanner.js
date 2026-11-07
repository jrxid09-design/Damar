const llm = require("../reasoning/llmClient");
const promptBuilder = require("../prompts/promptBuilder");
const ExecutionPlan = require("../models/executionPlan");

class LLMPlanner {

    async plan(state) {

        const prompt = promptBuilder.buildPlanner(state);

        console.log("===== Planner Prompt =====");
        console.dir(prompt, { depth: null });
        console.log("==========================");

        const response = await llm.generate(prompt);

        console.log("===== LLM Planner Raw Response =====");
        console.log(response.reply);
        console.log("====================================");

        const data = this.parse(response.reply);

        return this.toExecutionPlan(data);

    }

    parse(text) {

        try {
            return JSON.parse(text);
        } catch {

            const match = text.match(/\{[\s\S]*\}/);

            if (!match) {
                throw new Error(
                    `Planner returned invalid JSON.\n\n${text}`
                );
            }

            return JSON.parse(match[0]);
        }

    }

    toExecutionPlan(data) {

        const plan = new ExecutionPlan({
            thought: data.thought || "LLM generated execution plan"
        });

        for (const step of data.steps || []) {
            plan.addStep(step);
        }

        return plan;

    }

}

module.exports = new LLMPlanner();