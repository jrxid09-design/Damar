const axios = require("axios");
const aiConfig = require("../config/ai");

class OpenRouterProvider {

  async chat({ systemPrompt, history }) {

    try {

      const payload = {
        model: aiConfig.model,

        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          ...history
        ],

        temperature: aiConfig.temperature,
        max_tokens: aiConfig.maxTokens
      };

      // ===== DEBUG PAYLOAD =====
      console.log("===== OpenRouter Payload =====");
      console.dir(payload, { depth: null });
      console.log("==============================");
      // =========================

      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        payload,
        {
          timeout: aiConfig.timeout,
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      // ===== DEBUG RESPONSE =====
      console.log("===== OpenRouter Response =====");
      console.dir(response.data, { depth: null });
      console.log("===============================");
      // ==========================

      const reply = response.data?.choices?.[0]?.message?.content;

      if (!reply) {
        throw new Error("OpenRouter returned an empty response.");
      }

      return {
        reply,
        provider: "openrouter"
      };

    } catch (error) {

      console.error("===== OpenRouter Error =====");
      console.error(error.response?.data || error.message);
      console.error("============================");

      throw new Error(
        error.response?.data?.error?.message ||
        error.message
      );

    }

  }

}

module.exports = new OpenRouterProvider();