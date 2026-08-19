const openRouterProvider = require("./openRouterProvider");
const ollamaProvider = require("./ollamaProvider");

switch (process.env.AI_PROVIDER) {
  case "ollama":
    module.exports = ollamaProvider;
    break;

  case "openrouter":
  default:
    module.exports = openRouterProvider;
}