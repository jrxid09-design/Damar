const memoryConfig = require("../config/memory");

let repository;

switch (memoryConfig.provider) {
  case "sqlite":
    repository = require("./sqliteMemoryRepository");
    break;

  case "memory":
    repository = require("./inMemoryRepository");
    break;

  default:
    throw new Error(
      `Unsupported memory provider: ${memoryConfig.provider}`
    );
}

module.exports = repository;