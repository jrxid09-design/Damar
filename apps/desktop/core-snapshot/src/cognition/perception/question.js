"use strict";

function validQuestionText(value, maxChars) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxChars;
}

module.exports = { validQuestionText };
