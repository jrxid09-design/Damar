const memory = require("../memory/memoryManager");
const promptManager = require("../prompts/promptManager");

const agent = require("../agent/agentProvider");
const AgentContext = require("../agent/agentContext");

class ChatService {
  async chat(
    sessionId,
    message,
    prompt = "default"
  ) {
    await memory.addMessage(sessionId, "user", message);

    const history = await memory.getHistory(sessionId);

    const systemPrompt = await promptManager.get(prompt);

    const context = new AgentContext({
      sessionId,
      message,
      prompt,
      history,
      systemPrompt,
    });

    const result = await agent.run(context);

    await memory.addMessage(
      sessionId,
      "assistant",
      result.reply
    );

    return result;
  }
}

module.exports = new ChatService();