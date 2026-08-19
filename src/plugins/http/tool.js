const GetTool = require("./tools/get");
const PostTool = require("./tools/post");
const PutTool = require("./tools/put");
const PatchTool = require("./tools/patch");
const DeleteTool = require("./tools/delete");
const HeadTool = require("./tools/head");
const DownloadTool = require("./tools/download");

module.exports = [
    new GetTool(),
    new PostTool(),
    new PutTool(),
    new PatchTool(),
    new DeleteTool(),
    new HeadTool(),
    new DownloadTool()
];