"use strict";

function gainForClass(cls) {
    return cls === "LOCAL" ? 0.7 : cls === "INTERACTIVE" ? 0.5 : cls === "REMOTE" ? 0.3 : 0.25;
}

module.exports = { gainForClass };
