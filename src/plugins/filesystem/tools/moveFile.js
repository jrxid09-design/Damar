const fs = require("fs").promises;
const path = require("path");

class MoveFileTool {

    constructor() {

        this.name = "moveFile";

        this.description =
            "Move a file to another location.";

    }

    /**
     * @param {Object} context
     * @param {Object} args
     * @param {string} args.source
     * @param {string} args.destination
     */
    async execute(context, args = {}) {

        try {

            if (!args.source) {
                return {
                    success: false,
                    error: "Parameter 'source' is required."
                };
            }

            if (!args.destination) {
                return {
                    success: false,
                    error: "Parameter 'destination' is required."
                };
            }

            const source = path.resolve(args.source);
            const destination = path.resolve(args.destination);

            const stat = await fs.stat(source);

            if (!stat.isFile()) {
                return {
                    success: false,
                    error: "Source is not a file."
                };
            }

            await fs.mkdir(
                path.dirname(destination),
                { recursive: true }
            );

            await fs.rename(source, destination);

            return {
                success: true,
                data: {
                    source,
                    destination,
                    moved: true
                }
            };

        } catch (err) {

            if (err.code === "ENOENT") {
                return {
                    success: false,
                    error: "Source file not found."
                };
            }

            return {
                success: false,
                error: err.message
            };

        }

    }

}

module.exports = MoveFileTool;