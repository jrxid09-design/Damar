const aetherAgent = require("./adapters/aetherAgent");
const hermesAdapter = require("./adapters/hermesAdapter");
const openClawAdapter = require("./adapters/openClawAdapter");

switch (process.env.AGENT_PROVIDER) {
  case "hermes":
    module.exports = hermesAdapter;
    break;

  case "openclaw":
    module.exports = openClawAdapter;
    break;

  case "aether":
  default:
    module.exports = aetherAgent;
}