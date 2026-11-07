const repository = require("../repositories/memoryRepository");
const { MAX_HISTORY_MESSAGES } = require("../config/constants");

class MemoryManager {
  async getHistory(sessionId) {
    return repository.get(sessionId);
  }

  async addMessage(sessionId, role, content) {
    await repository.save(sessionId, {
      role,
      content,
    });

    await repository.trim(sessionId, MAX_HISTORY_MESSAGES);
  }

  async clear(sessionId) {
    await repository.clear(sessionId);
  }
}

module.exports = new MemoryManager();