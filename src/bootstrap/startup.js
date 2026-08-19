const consoleUI = require("../utils/console");
const pluginRegistry = require("../plugins/pluginRegistry");

module.exports = (config) => {

    // Dijalankan lewat launcher (npm run aether) yang sudah punya banner
    // sendiri → lewati banner ini agar tak dobel.
    if (process.env.AETHER_NO_BANNER === "1") {
        return;
    }

    console.clear();

    console.log(`
     █████╗ ███████╗████████╗██╗  ██╗███████╗██████╗
    ██╔══██╗██╔════╝╚══██╔══╝██║  ██║██╔════╝██╔══██╗
    ███████║█████╗     ██║   ███████║█████╗  ██████╔╝
    ██╔══██║██╔══╝     ██║   ██╔══██║██╔══╝  ██╔══██╗
    ██║  ██║███████╗   ██║   ██║  ██║███████╗██║  ██║
    ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
    `);

    consoleUI.line();

    console.log(` Version     : v${config.version}`);
    console.log(` Environment : ${config.environment}`);
    console.log(` URL         : http://localhost:${config.port}`);

    consoleUI.section("Plugins");

    for (const plugin of pluginRegistry.all()) {

        consoleUI.success(plugin.manifest.name);

        for (const tool of plugin.instance.tools ?? []) {
            console.log(`    └─ ${tool.metadata?.name ?? tool.name}`);
        }

    }

    consoleUI.line();
};