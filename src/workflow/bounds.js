"use strict";

const WORKFLOW_SCHEMA_VERSION = "workflow.v1";
const STEP_SCHEMA_VERSION = "workflow.step.v1";

const BOUNDS = Object.freeze({
    MAX_WORKFLOWS: 256,
    MAX_STEPS_PER_WORKFLOW: 128,
    MAX_WORKFLOW_ID_BYTES: 256,
    MAX_STEP_ID_BYTES: 256,
    MAX_PRIVILEGES: 64,
});

module.exports = { WORKFLOW_SCHEMA_VERSION, STEP_SCHEMA_VERSION, BOUNDS };
