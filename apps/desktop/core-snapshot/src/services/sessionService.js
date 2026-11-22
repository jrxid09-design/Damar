const repository = require("../repositories/sessionRepository");

class SessionService {

  async getAll() {
    return repository.getAll();
  }

  async getMessages(sessionId) {
    return repository.getMessages(sessionId);
  }

  async delete(sessionId) {
    return repository.delete(sessionId);
  }
  async debug() {
  return repository.debug();
}

}

module.exports = new SessionService();