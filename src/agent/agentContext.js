class AgentContext {
  constructor({
    sessionId,
    message,
    prompt = "default",
    history = [],
    systemPrompt,
    metadata = {},
  }) {
    this.sessionId = sessionId;
    this.message = message;
    this.prompt = prompt;
    this.history = history;
    this.systemPrompt = systemPrompt;
    this.metadata = metadata;
  }
}

module.exports = AgentContext;