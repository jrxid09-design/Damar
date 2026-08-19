module.exports = Object.freeze({

    // Plugin lifecycle
    PLUGIN_LOADED: "plugin.loaded",
    PLUGIN_UNLOADED: "plugin.unloaded",

    // Tool lifecycle
    TOOL_STARTED: "tool.started",
    TOOL_COMPLETED: "tool.completed",
    TOOL_FAILED: "tool.failed",

    // Skill lifecycle
    SKILL_STARTED: "skill.started",
    SKILL_COMPLETED: "skill.completed",
    SKILL_FAILED: "skill.failed",

    // Planning
    PLAN_CREATED: "plan.created",
    PLAN_EXECUTED: "plan.executed",

    // Memory
    MEMORY_CREATED: "memory.created",
    MEMORY_UPDATED: "memory.updated",

    // Reflection
    REFLECTION_COMPLETED: "reflection.completed"

});