"use strict";
/** Noop tool for sandbox smoke tests — returns its arguments. */
module.exports = function noopTool(args) {
    return { noop: true, args: args ?? {} };
};
