const HttpClient = require("../services/HttpClient");

class PutTool {

    constructor() {

        this.name = "put";
        this.description = "HTTP PUT request";

    }

    async execute(context, params = {}) {

        if (!params.url) {
            return {
                success: false,
                error: "Parameter 'url' is required."
            };
        }

        return HttpClient.put(params.url, {
            headers: params.headers || {},
            body: params.body,
            timeout: params.timeout
        });

    }

}

module.exports = PutTool;