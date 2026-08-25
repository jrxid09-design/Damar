const sessionService = require("../services/sessionService");
const response = require("../utils/response");

class SessionController {
  async getAll(req, res, next) {
    try {
      const sessions = await sessionService.getAll();

      return response.success(
        res,
        "Sessions retrieved successfully",
        sessions
      );
    } catch (err) {
      next(err);
    }
  }

  async getMessages(req, res, next) {
    try {
      const history = await sessionService.getMessages(
        req.params.sessionId
      );

      return response.success(
        res,
        "Messages retrieved successfully",
        history
      );
    } catch (err) {
      next(err);
    }
  }

  async delete(req, res, next) {
    try {
      await sessionService.delete(
        req.params.sessionId
      );

      return response.success(
        res,
        "Session deleted successfully",
        null
      );
    } catch (err) {
      next(err);
    }
  }

  async debug(req, res, next) {
    try {
      const rows = await sessionService.debug();

      return response.success(
  res,
  "Messages retrieved successfully",
  rows
);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new SessionController();