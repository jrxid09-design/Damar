const PutTool = require("../plugins/http/tools/put");

(async () => {

    const tool = new PutTool();

    const result = await tool.execute({}, {
        url: "https://jsonplaceholder.typicode.com/posts/1",
        body: {
            id: 1,
            title: "Updated",
            body: "Updated Body",
            userId: 1
        }
    });

    console.dir(result, { depth: null });

})();