const promptManager = require("./prompts/promptManager");

(async () => {
  const prompt = await promptManager.get();

  console.log(prompt);
})();