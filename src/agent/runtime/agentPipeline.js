class AgentPipeline {

    constructor(phases = []) {
        this.phases = phases;
    }

    add(phase) {
        this.phases.push(phase);
        return this;
    }

    async execute(state) {
    for (const phase of this.phases) {
        console.log("================================");
        console.log("Phase:", phase);
        console.log("Type :", phase?.constructor?.name);
        console.log("run  :", typeof phase?.run);

        if (typeof phase?.run !== "function") {
            throw new Error(
                `${phase?.constructor?.name ?? "Unknown"} does not implement run()`
            );
        }

        await phase.run(state);
    }

    return state;

    return state;
}

}

module.exports = AgentPipeline;