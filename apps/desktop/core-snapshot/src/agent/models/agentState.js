class AgentState {

    constructor(context) {

        this.context = context;

        this.plan = null;

        this.execution = null;

        this.response = null;

        this.memories = [];

        this.observations = [];

        this.metadata = {};

    }

}

module.exports = AgentState;