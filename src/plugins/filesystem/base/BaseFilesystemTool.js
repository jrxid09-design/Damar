const path = require("path");

class BaseFilesystemTool {

    success(data = {}) {
        return {
            success: true,
            data
        };
    }

    failure(error) {
        return {
            success: false,
            error: error instanceof Error
                ? error.message
                : error
        };
    }

    require(args, fields = []) {

        for (const field of fields) {

            if (
                args[field] === undefined ||
                args[field] === null ||
                args[field] === ""
            ) {

                return this.failure(
                    `Parameter '${field}' is required.`
                );

            }

        }

        return null;

    }

    resolve(target) {
        return path.resolve(target);
    }

    isNotFound(err) {
        return err.code === "ENOENT";
    }

}

module.exports = BaseFilesystemTool;