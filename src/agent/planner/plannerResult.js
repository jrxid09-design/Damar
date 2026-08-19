const ExecutionPlan = require("../models/executionPlan");

class PlannerResult {

  constructor(plan) {
    this.plan =
      plan instanceof ExecutionPlan
        ? plan
        : new ExecutionPlan(plan);
  }

}

module.exports = PlannerResult;