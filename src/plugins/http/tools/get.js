const HttpClient = require("../services/HttpClient");

class GetTool {

    constructor() {
        this.name = "get";
        this.description = "HTTP GET request";
    }

    async execute(context, params = {}) {

        if (!params.url) {
            return {
                success: false,
                error: "Parameter 'url' is required."
            };
        }

        return HttpClient.get(
            params.url,
            params.headers || {}
        );

    }

}

module.exports = GetTool;