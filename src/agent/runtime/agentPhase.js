class AgentPhase {

    async run(state) {
        throw new Error(
            `${this.constructor.name} must implement run().`
        );
    }

}

module.exports = AgentPhase;