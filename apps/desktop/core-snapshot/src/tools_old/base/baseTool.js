class BaseTool {
  get name() {
    throw new Error("Tool must define a name.");
  }

  get description() {
    return "";
  }

  get schema() {
    return {};
  }

  async execute(context, args = {}) {
    throw new Error("execute() must be implemented.");
  }
}

module.exports = BaseTool;