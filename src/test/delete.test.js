const DeleteTool = require("../plugins/http/tools/delete");

(async () => {

    const tool = new DeleteTool();

    const result = await tool.execute({}, {
        url: "https://jsonplaceholder.typicode.com/posts/1"
    });

    console.dir(result, { depth: null });

})();