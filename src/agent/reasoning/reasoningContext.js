class ReasoningContext {

  constructor(state) {

    this.systemPrompt = state.context.systemPrompt;

    this.history = [...state.context.history];

    if (state.observations?.length) {

      this.history.push({
        role: "system",
        content:
          "Tool Results:\n\n" +
          JSON.stringify(
            state.observations,
            null,
            2
          )
      });

    }

  }

}

module.exports = ReasoningContext;