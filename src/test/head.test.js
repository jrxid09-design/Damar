const HeadTool = require("../plugins/http/tools/head");

(async () => {

    const tool = new HeadTool();

    const result = await tool.execute({}, {
        url: "https://jsonplaceholder.typicode.com/posts/1"
    });

    console.dir(result, { depth: null });

})();