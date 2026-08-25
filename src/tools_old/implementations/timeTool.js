const BaseTool = require("../base/baseTool");

class TimeTool extends BaseTool {

  get name() {
    return "getCurrentTime";
  }

  get description() {
    return "Returns the current server time.";
  }

  get schema() {
    return {};
  }

  async execute() {
  console.log("[TimeTool] Executing");

  return {
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    locale: new Date().toLocaleString()
  };
}

}

module.exports = new TimeTool();