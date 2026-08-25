const response = require("../utils/response");
const systemService = require("../services/systemService");

module.exports = {
  home(req, res) {
    response.success(
      res,
      "Welcome to Aether",
      systemService.getSystemInfo()
    );
  },

  health(req, res) {
    response.success(res, "Server is healthy", {
      uptime: process.uptime(),
    });
  },

  version(req, res) {
    response.success(res, "Application version", {
      version: systemService.getSystemInfo().version,
    });
  },
};