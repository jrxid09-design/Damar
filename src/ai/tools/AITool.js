class AITool {

    constructor({

        name,

        description = "",

        parameters = {},

        execute,

        // Metadata kapabilitas (opsional): capabilities, keywords,
        // domain, risk, sideEffects, readOnly, channels, roles,
        // cost, latency, source, provider. Yang tidak diberi akan
        // diturunkan otomatis oleh CapabilityIndex.
        meta = {}

    }) {

        if (!name) {

            throw new Error("Tool name is required.");

        }

        if (typeof execute !== "function") {

            throw new Error("Tool execute must be a function.");

        }

        this.name = name;

        this.description = description;

        this.parameters = parameters;

        this.execute = execute;

        this.meta = meta && typeof meta === "object" ? meta : {};

    }

}

module.exports = AITool;