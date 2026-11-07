class Observation {
  constructor({
    tool,
    success = true,
    result = null,
    error = null,
    timestamp = new Date().toISOString(),
  }) {
    this.tool = tool;
    this.success = success;
    this.result = result;
    this.error = error;
    this.timestamp = timestamp;
  }
}

module.exports = Observation;