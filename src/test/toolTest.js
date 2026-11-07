const toolExecutor = require("../tools/executor/toolExecutor");
require("../tools");

async function run() {
  const result = await toolExecutor.execute(
    "getCurrentTime",
    {}
  );

  console.log(result);
}

run();