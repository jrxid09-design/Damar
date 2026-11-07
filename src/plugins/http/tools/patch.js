const HttpClient = require("../services/HttpClient");

class PatchTool {

    constructor() {

        this.name = "patch";
        this.description = "HTTP PATCH request";

    }

    async execute(context, params = {}) {

        if (!params.url) {
            return {
                success: false,
                error: "Parameter 'url' is required."
            };
        }

        return HttpClient.patch(params.url, {
            headers: params.headers || {},
            body: params.body,
            timeout: params.timeout
        });

    }

}

module.exports = PatchTool;