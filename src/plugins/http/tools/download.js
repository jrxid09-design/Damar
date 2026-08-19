const HttpClient = require("../services/HttpClient");

class DownloadTool {

    constructor() {

        this.name = "download";
        this.description = "Download file";

    }

    async execute(context, params = {}) {

        if (!params.url) {
            return {
                success: false,
                error: "Parameter 'url' is required."
            };
        }

        if (!params.output) {
            return {
                success: false,
                error: "Parameter 'output' is required."
            };
        }

        return HttpClient.download(
            params.url,
            params.output,
            {
                headers: params.headers || {},
                timeout: params.timeout
            }
        );

    }

}

module.exports = DownloadTool;