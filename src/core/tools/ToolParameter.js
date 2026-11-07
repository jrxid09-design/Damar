class ToolParameter {

    constructor(options = {}) {

        this.name = options.name;

        this.type = options.type ?? "string";

        this.description = options.description ?? "";

        this.required = options.required ?? false;

        this.defaultValue = options.defaultValue;

        this.enum = options.enum ?? null;

        this.minimum = options.minimum;

        this.maximum = options.maximum;

    }

}

module.exports = ToolParameter;