const GetTool = require("../plugins/http/tools/get");

(async () => {

    const tool = new GetTool();

    const result = await tool.execute({}, {
        url: "https://jsonplaceholder.typicode.com/posts/1"
    });

    console.dir(result, {
        depth: null
    });

})();