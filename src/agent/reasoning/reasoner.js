const AgentPhase = require("../runtime/agentPhase");
const engine = require("./reasoningEngine");

class Reasoner extends AgentPhase {

  async run(state) {

    state.response =
      await engine.execute(state);

  }

}

module.exports = Reasoner;