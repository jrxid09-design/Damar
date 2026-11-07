const PatchTool = require("../plugins/http/tools/patch");

(async () => {

    const tool = new PatchTool();

    const result = await tool.execute({}, {
        url: "https://jsonplaceholder.typicode.com/posts/1",
        body: {
            title: "Patched"
        }
    });

    console.dir(result, { depth: null });

})();