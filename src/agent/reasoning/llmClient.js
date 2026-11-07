const aiProvider = require("../../providers/aiProvider");

class LLMClient {

  async generate({
    systemPrompt,
    history,
  }) {

    return await aiProvider.chat({
      systemPrompt,
      history,
    });

  }

}

module.exports = new LLMClient();