const fs = require("fs").promises;
const path = require("path");

class FilePromptProvider {
  async get(name = "default") {
    const filePath = path.join(
      __dirname,
      "../prompts",
      `${name}.md`
    );

    return fs.readFile(filePath, "utf8");
  }
}

module.exports = new FilePromptProvider();