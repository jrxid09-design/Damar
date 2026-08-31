"use strict";

// Public media package surface is deliberately inert.  The application-owned
// subsystem implementation lives in subsystem.js and is imported only by the
// runtime composition root.  Keeping this index free of constructors prevents
// ordinary production modules from minting a second media trust domain.
const { CODES, MediaIngressError } = require("./errors");

module.exports = Object.freeze({ CODES, MediaIngressError });
