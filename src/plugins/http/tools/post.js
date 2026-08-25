const HttpClient = require("../services/HttpClient");

class PostTool {

    constructor() {

        this.name = "post";
        this.description = "HTTP POST request";

    }

    async execute(context, params = {}) {

        if (!params.url) {

            return {
                success: false,
                error: "Parameter 'url' is required."
            };

        }

        return HttpClient.post(params.url, {
            headers: params.headers || {},
            body: params.body,
            timeout: params.timeout
        });

    }

}

module.exports = PostTool;