const AIError = require("./AIError");

class ProviderNotFoundError extends AIError {

    constructor(provider) {

        super(
            `Provider '${provider}' was not found.`
        );

        this.provider = provider;

    }

}

module.exports = ProviderNotFoundError;