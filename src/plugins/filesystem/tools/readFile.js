const fs = require("fs").promises;
const path = require("path");

class ReadFileTool {
    constructor() {
        this.name = "readFile";
        this.description = "Read the contents of a text file.";
    }

    /**
     * @param {Object} context
     * @param {Object} args
     * @param {string} args.path
     * @param {string} [args.encoding="utf8"]
     */
    async execute(context, args = {}) {
        try {

            if (!args.path) {
                return {
                    success: false,
                    error: "Parameter 'path' is required."
                };
            }

            const filePath = path.resolve(args.path);
            const encoding = args.encoding || "utf8";

            const stat = await fs.stat(filePath);

            if (!stat.isFile()) {
                return {
                    success: false,
                    error: "Target is not a file."
                };
            }

            const content = await fs.readFile(filePath, encoding);

            return {
                success: true,
                data: {
                    path: filePath,
                    size: stat.size,
                    encoding,
                    content
                }
            };

        } catch (err) {

            if (err.code === "ENOENT") {
                return {
                    success: false,
                    error: "File not found."
                };
            }

            return {
                success: false,
                error: err.message
            };
        }
    }
}

module.exports = ReadFileTool;