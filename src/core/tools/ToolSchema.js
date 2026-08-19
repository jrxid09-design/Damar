class ToolSchema {

    constructor(schema = {}) {

        this.schema = schema;

    }

    validate(args = {}) {

        for (const [name, rule] of Object.entries(this.schema)) {

            const value = args[name];

            if (rule.required && value === undefined) {

                throw new Error(`"${name}" is required.`);

            }

            if (value === undefined) {

                continue;

            }

            if (rule.type && typeof value !== rule.type) {

                throw new Error(

                    `"${name}" must be ${rule.type}.`

                );

            }

            if (rule.enum && !rule.enum.includes(value)) {

                throw new Error(

                    `"${name}" must be one of ${rule.enum.join(", ")}.`

                );

            }

        }

        return true;

    }

}

module.exports = ToolSchema;