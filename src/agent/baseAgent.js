class BaseAgent {
  async run(context) {
    throw new Error("run() must be implemented.");
  }

  async health() {
    return {
      status: "unknown",
    };
  }

  async listTools() {
    return [];
  }
}

module.exports = BaseAgent;