const fs = require("fs");
const path = require("path");

class ExistsTool {
    constructor() {
        this.name = "exists";
        this.description = "Check whether a file or directory exists.";
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

            const targetPath = path.resolve(args.path);

            return {
                success: true,
                data: {
                    path: targetPath,
                    exists: fs.existsSync(targetPath)
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

module.exports = ExistsTool;