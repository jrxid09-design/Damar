const ExecutionPlan = require("../models/executionPlan");

class RulePlanner {

    plan(context) {

        const message = context.message.toLowerCase();

        const plan = new ExecutionPlan({
            thought: "Rule-based planning"
        });

        if (message.includes("jam")) {

            plan.addStep({
                tool: "getCurrentTime",
                arguments: {}
            });

        }

        return plan;
    }

}

module.exports = new RulePlanner();