const fs = require("fs").promises;
const path = require("path");

class CreateDirectoryTool {

    constructor() {

        this.name = "createDirectory";

        this.description =
            "Create a new directory.";

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

            const directory = path.resolve(args.path);

            await fs.mkdir(directory, {
                recursive: true
            });

            return {
                success: true,
                data: {
                    path: directory,
                    created: true
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

module.exports = CreateDirectoryTool;