class AIProviderConfig {

    constructor({

        apiKey = null,

        baseUrl = null,

        timeout = 30000,

        headers = {},

        metadata = {}

    } = {}) {

        this.apiKey = apiKey;

        this.baseUrl = baseUrl;

        this.timeout = timeout;

        this.headers = headers;

        this.metadata = metadata;

    }

}

module.exports = AIProviderConfig;