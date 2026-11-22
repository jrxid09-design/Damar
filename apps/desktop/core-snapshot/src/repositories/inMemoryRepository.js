const { MAX_HISTORY_MESSAGES } = require("../config/constants");

const conversations = new Map();

class InMemoryRepository {
  get(sessionId) {
    return conversations.get(sessionId) || [];
  }

  save(sessionId, message) {
    const history = this.get(sessionId);

    history.push({
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString(),
    });

    conversations.set(sessionId, history);
  }

  trim(sessionId, limit = MAX_HISTORY_MESSAGES) {
    const history = this.get(sessionId);

    while (history.length > limit) {
      history.shift();
    }

    conversations.set(sessionId, history);
  }

  clear(sessionId) {
    conversations.delete(sessionId);
  }
}

module.exports = new InMemoryRepository();