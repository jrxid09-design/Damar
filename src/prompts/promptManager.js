const fs = require("fs").promises;
const path = require("path");
const filePromptProvider = require("./providers/filePromptProvider");

class PromptManager {
  async get(name = "default") {
    const filePath = path.join(
      __dirname,
      "prompts",
      `${name}.md`
    );

    try {
      await fs.access(filePath);
    } catch {
      throw new Error(`Prompt '${name}' not found.`);
    }

    return filePromptProvider.get(name);
  }
}

module.exports = new PromptManager();