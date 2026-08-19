require("../database/migrate");

const repository = require("./sqliteMemoryRepository");

async function test() {
  await repository.save("default", {
    role: "user",
    content: "Halo SQLite",
  });

  const history = await repository.get("default");

  console.log(history);
}

test().catch(console.error);