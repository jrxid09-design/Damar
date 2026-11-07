class PluginValidator {

    validate(manifest) {

        const required = [
            "id",
            "name",
            "version",
            "entry"
        ];

        for (const field of required) {

            if (!manifest[field]) {

                throw new Error(
                    `Plugin manifest missing '${field}'`
                );

            }

        }

        return true;

    }

}

module.exports = new PluginValidator();