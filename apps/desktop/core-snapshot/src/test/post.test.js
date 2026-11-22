const PostTool = require("../plugins/http/tools/post");

(async () => {

    const tool = new PostTool();

    const result = await tool.execute({}, {
        url: "https://jsonplaceholder.typicode.com/posts",
        body: {
            title: "Damar",
            body: "Hello World",
            userId: 1
        }
    });

    console.dir(result, {
        depth: null
    });

})();