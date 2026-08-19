class CalculatorTool {

    constructor() {

        this.name = "calculator";

        this.description =
            "Perform basic arithmetic calculations.";

        this.parameters = {
            operation: {
                type: "string",
                description: "Arithmetic operation.",
                enum: [
                    "add",
                    "subtract",
                    "multiply",
                    "divide"
                ]
            },

            a: {
                type: "number",
                description: "First number."
            },

            b: {
                type: "number",
                description: "Second number."
            }
        };

    }

    async execute(context, args = {}) {

        const {
            operation,
            a,
            b
        } = args;

        if (typeof a !== "number")
            throw new Error("Parameter 'a' must be a number.");

        if (typeof b !== "number")
            throw new Error("Parameter 'b' must be a number.");

        switch (operation) {

            case "add":
                return {
                    result: a + b
                };

            case "subtract":
                return {
                    result: a - b
                };

            case "multiply":
                return {
                    result: a * b
                };

            case "divide":

                if (b === 0)
                    throw new Error(
                        "Cannot divide by zero."
                    );

                return {
                    result: a / b
                };

            default:
                throw new Error(
                    `Unknown operation "${operation}".`
                );

        }

    }

}

module.exports = CalculatorTool;