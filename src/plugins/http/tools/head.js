const HttpClient = require("../services/HttpClient");

class HeadTool {

    constructor() {

        this.name = "head";
        this.description = "HTTP HEAD request";

    }

    async execute(context, params = {}) {

        if (!params.url) {
            return {
                success: false,
                error: "Parameter 'url' is required."
            };
        }

        return HttpClient.head(params.url, {
            headers: params.headers || {},
            timeout: params.timeout
        });

    }

}

module.exports = HeadTool;