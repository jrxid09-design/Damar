const DownloadTool = require("../plugins/http/tools/download");

(async () => {

    const tool = new DownloadTool();

    const result = await tool.execute({}, {
        url: "https://jsonplaceholder.typicode.com/posts/1",
        output: "./downloads/post1.json"
    });

    console.dir(result, {
        depth: null
    });

})();