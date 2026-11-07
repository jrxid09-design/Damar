const fs = require("fs").promises;
const path = require("path");

class WriteFileTool {

    constructor() {

        this.name = "writeFile";

        this.description =
            "Write text content to a file.";

    }

    /**
     * @param {Object} context
     * @param {Object} args
     * @param {string} args.path
     * @param {string} args.content
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

            if (args.content === undefined) {
                return {
                    success: false,
                    error: "Parameter 'content' is required."
                };
            }

            const filePath = path.resolve(args.path);
            const encoding = args.encoding || "utf8";

            // Pastikan folder tujuan ada
            await fs.mkdir(
                path.dirname(filePath),
                { recursive: true }
            );

            await fs.writeFile(
                filePath,
                args.content,
                encoding
            );

            const stat = await fs.stat(filePath);

            return {
                success: true,
                data: {
                    path: filePath,
                    size: stat.size,
                    encoding,
                    written: true
                }
            };

        } catch (err) {

            return {
                success: false,
                error: err.message
            };

        }

    }

}

module.exports = WriteFileTool;