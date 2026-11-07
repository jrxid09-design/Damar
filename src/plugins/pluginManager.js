const pluginRegistry = require("./pluginRegistry");
const toolIndex = require("./toolIndex");
const eventBus = require("../events/eventBus");
const Events = require("../events/events");

class PluginManager {

    async execute(toolName, context = {}, args = {}) {

    const pluginId = toolIndex.get(toolName);

    if (!pluginId)
        throw new Error(`Tool '${toolName}' not found.`);

    const plugin = pluginRegistry.get(pluginId);

    const tool = plugin.instance.tools.find(
        t => t.name === toolName
    );

    if (!tool)
        throw new Error(`Tool '${toolName}' missing.`);

    try {

        eventBus.emit(
            Events.TOOL_STARTED,
            {
                plugin: plugin.manifest.id,
                tool: tool.name,
                args,
                timestamp: new Date().toISOString()
            }
        );

        const result = await tool.execute(context, args);

        eventBus.emit(
            Events.TOOL_COMPLETED,
            {
                plugin: plugin.manifest.id,
                tool: tool.name,
                result,
                timestamp: new Date().toISOString()
            }
        );

        return result;

    } catch (error) {

        eventBus.emit(
            Events.TOOL_FAILED,
            {
                plugin: plugin.manifest.id,
                tool: tool.name,
                error: error.message,
                timestamp: new Date().toISOString()
            }
        );

        throw error;
    };

    }

}

module.exports = new PluginManager();