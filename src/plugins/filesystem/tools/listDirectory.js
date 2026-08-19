const fs = require("fs").promises;
const path = require("path");

class ListDirectoryTool {

    constructor() {

        this.name = "listDirectory";

        this.description =
            "List files and folders inside a directory.";

    }

    /**
     * @param {Object} context
     * @param {Object} args
     * @param {string} args.path
     * @param {boolean} [args.recursive=false]
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

            const stat = await fs.stat(directory);

            if (!stat.isDirectory()) {
                return {
                    success: false,
                    error: "Target is not a directory."
                };
            }

            const items = await this.scan(
                directory,
                args.recursive || false
            );

            return {
                success: true,
                data: {
                    path: directory,
                    count: items.length,
                    items
                }
            };

        } catch (err) {

            if (err.code === "ENOENT") {
                return {
                    success: false,
                    error: "Directory not found."
                };
            }

            return {
                success: false,
                error: err.message
            };

        }

    }

    async scan(directory, recursive = false) {

        const entries = await fs.readdir(directory, {
            withFileTypes: true
        });

        const results = [];

        for (const entry of entries) {

            const fullPath = path.join(
                directory,
                entry.name
            );

            const stat = await fs.stat(fullPath);

            results.push({
                name: entry.name,
                path: fullPath,
                type: entry.isDirectory()
                    ? "directory"
                    : "file",
                size: stat.size,
                modified: stat.mtime
            });

            if (recursive && entry.isDirectory()) {

                const children =
                    await this.scan(fullPath, true);

                results.push(...children);

            }

        }

        return results;

    }

}

module.exports = ListDirectoryTool;