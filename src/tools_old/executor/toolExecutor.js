const toolRegistry = require("../registry/toolRegistry");

class ToolExecutor {

  async execute(name, context, args = {}) {

    const tool = toolRegistry.get(name);

    if (!tool) {
      throw new Error(`Tool '${name}' not found.`);
    }

    return tool.execute(context, args);
  }

}

module.exports = new ToolExecutor();