const HttpClient = require("../services/HttpClient");

class DeleteTool {

    constructor() {

        this.name = "delete";
        this.description = "HTTP DELETE request";

    }

    async execute(context, params = {}) {

        if (!params.url) {
            return {
                success: false,
                error: "Parameter 'url' is required."
            };
        }

        return HttpClient.delete(params.url, {
            headers: params.headers || {},
            timeout: params.timeout
        });

    }

}

module.exports = DeleteTool;