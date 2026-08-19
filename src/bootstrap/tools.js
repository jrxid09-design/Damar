const pluginRegistry = require("../plugins/pluginRegistry");

module.exports = () => {

    for (const plugin of pluginRegistry.all()) {

        console.log(
            `Plugin Loaded : ${plugin.manifest.name}`
        );

        for (const tool of plugin.instance.tools ?? []) {

            console.log(
                `  └─ ${tool.metadata?.name ?? tool.name}`
            );

        }

    }

};