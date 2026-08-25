const { body } = require("express-validator");

exports.chatValidation = [
  body("sessionId")
    .trim()
    .notEmpty()
    .withMessage("Session ID is required"),

  body("prompt")
  .optional()
  .trim()
  .isLength({ min: 1 })
  .withMessage("Prompt cannot be empty"),

  body("message")
    .trim()
    .notEmpty()
    .withMessage("Message is required")
    .isLength({ min: 2 })
    .withMessage("Message must be at least 2 characters"),
];