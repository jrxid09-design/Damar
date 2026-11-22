"use strict";

class BusError extends Error {
  constructor(code, message, details) {
    super(`[${code}] ${message || code}`);
    this.name = "BusError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { BusError };
