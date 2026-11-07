const ExistsTool = require("../../src/plugins/filesystem/tools/exists");

(async () => {

    const tool = new ExistsTool();

    console.log("=== Exists Test ===");

    const result = await tool.execute({}, {
        path: "./test.txt"
    });

    console.dir(result, { depth: null });

})();