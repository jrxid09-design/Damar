const Observation = require("../models/observation");

class ExecutionResult {
  constructor() {
    this.observations = [];
  }

  add(observation) {
    this.observations.push(
      observation instanceof Observation
        ? observation
        : new Observation(observation)
    );
  }

  get hasObservations() {
    return this.observations.length > 0;
  }
}

module.exports = ExecutionResult;