const BaseAgent = require("../baseAgent");
const aiProvider = require("../../providers/aiProvider");

class OpenClawAdapter extends BaseAgent {
  async run(context) {
    return aiProvider.chat({
      systemPrompt: context.systemPrompt,
      history: context.history,
    });
  }

  async health() {
    return {
      provider: "openclaw",
      status: "ready",
    };
  }

  async listTools() {
    return [];
  }
}

module.exports = new OpenClawAdapter();