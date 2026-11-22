const ChatMessage = require("./ChatMessage");

module.exports = {

    ChatMessage,

    // Alias historis.
    AIMessage: ChatMessage,

    AIRequest: require("./AIRequest"),

    AIResponse: require("./AIResponse"),

    AIStreamChunk: require("./AIStreamChunk"),

    AITool: require("./AITool"),

    AIToolCall: require("./AIToolCall"),

    AIToolResult: require("./AIToolResult")

};
