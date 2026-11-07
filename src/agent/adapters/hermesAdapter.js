const BaseAgent = require("../baseAgent");
const aiProvider = require("../../providers/aiProvider");

class HermesAdapter extends BaseAgent {
  async run(context) {
    return aiProvider.chat({
      systemPrompt: context.systemPrompt,
      history: context.history,
    });
  }

  async health() {
    return {
      provider: "hermes",
      status: "ready",
    };
  }

  async listTools() {
    return [];
  }
}

module.exports = new HermesAdapter();