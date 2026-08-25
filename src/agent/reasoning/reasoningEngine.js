const llm = require("./llmClient");
const promptBuilder = require("../prompts/promptBuilder");

class ReasoningEngine {

    async execute(state) {

        const prompt = promptBuilder.buildReasoning(state);

        console.log("===== Reasoning Payload =====");
        console.dir(prompt, { depth: null });
        console.log("=============================");

        const response = await llm.generate(prompt);

        console.log("===== Reasoning Response =====");
        console.dir(response, { depth: null });
        console.log("==============================");

        return response;

    }

}

module.exports = new ReasoningEngine();