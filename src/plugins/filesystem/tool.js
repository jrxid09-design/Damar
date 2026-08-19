const ExistsTool = require("./tools/exists");
const ReadFileTool = require("./tools/readFile");
const WriteFileTool = require("./tools/writeFile");
const ListDirectoryTool = require("./tools/listDirectory");
const CreateDirectoryTool = require("./tools/createDirectory");
const DeleteFileTool = require("./tools/deleteFile");
const MoveFileTool = require("./tools/moveFile");
const CopyFileTool = require("./tools/copyFile");

module.exports = [
    new ExistsTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new ListDirectoryTool(),
    new CreateDirectoryTool(),
    new DeleteFileTool(),
    new MoveFileTool(),
    new CopyFileTool()
];