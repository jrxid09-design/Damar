class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool.name) {
      throw new Error("Tool name is required.");
    }

    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered.`);
    }

    this.tools.set(tool.name, tool);
  }

  unregister(name) {
    this.tools.delete(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  list() {
    return [...this.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema
    }));
  }
}

module.exports = new ToolRegistry();