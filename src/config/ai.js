module.exports = {
  provider: process.env.AI_PROVIDER,
  model: process.env.OPENROUTER_MODEL,

  temperature: 0.7,
  // No product token cap (Owner rule 2026-11-28): null = max_tokens is not
  // sent at all; set a number here only as the user's own choice.
  maxTokens: null,
};