class ToolIndex {

    constructor() {
        this.tools = new Map();
    }

    register(toolName, pluginId) {
        this.tools.set(toolName, pluginId);
    }

    get(toolName) {
        return this.tools.get(toolName);
    }

    has(toolName) {
        return this.tools.has(toolName);
    }

    clear() {
        this.tools.clear();
    }

}

module.exports = new ToolIndex();