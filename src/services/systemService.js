const config = require("../config/env");

module.exports = {
  getSystemInfo() {
    return {
      name: config.appName,
      version: config.version,
      environment: config.environment,
      status: "online",
      uptime: process.uptime(),
    };
  },
};