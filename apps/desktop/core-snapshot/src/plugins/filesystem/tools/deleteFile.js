const fs = require("fs").promises;
const path = require("path");

class DeleteFileTool {

    constructor() {

        this.name = "deleteFile";

        this.description =
            "Delete a file.";

    }

    /**
     * @param {Object} context
     * @param {Object} args
     * @param {string} args.path
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

            const stat = await fs.stat(filePath);

            if (!stat.isFile()) {

                return {
                    success: false,
                    error: "Target is not a file."
                };

            }

            await fs.unlink(filePath);

            return {
                success: true,
                data: {
                    path: filePath,
                    deleted: true
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

module.exports = DeleteFileTool;