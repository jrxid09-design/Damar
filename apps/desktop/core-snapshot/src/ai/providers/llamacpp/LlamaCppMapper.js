const AIResponse = require("../../models/AIResponse");
const AIStreamChunk = require("../../models/AIStreamChunk");
const AIToolCall = require("../../tools/AIToolCall");

/**
 * Penerjemah antara format pesan Damar (gaya OpenAI) dan format
 * node-llama-cpp (ChatHistoryItem + ChatModelFunctions).
 *
 * Bagian tersulit: memasangkan setiap panggilan tool asisten dengan
 * HASILNYA. Damar menyimpan keduanya sebagai pesan terpisah
 * (assistant.tool_calls lalu role:"tool"), sedangkan node-llama-cpp
 * menuntut panggilan + hasil menyatu dalam satu item response model.
 */
class LlamaCppMapper {

    /** Argumen tool: string JSON → objek; objek → apa adanya. */
    parseArguments(args) {
        if (args == null) return {};
        if (typeof args === "object") return args;
        try { return JSON.parse(args || "{}"); } catch { return {}; }
    }

    /** Ratakan content (bisa array multimodal) jadi teks. */
    textOf(content) {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(p => (typeof p === "string" ? p : p?.text ?? "")).filter(Boolean).join("\n");
        }
        return content == null ? "" : String(content);
    }

    /**
     * messages Damar → ChatHistoryItem[] node-llama-cpp.
     *
     * Pesan role:"tool" TIDAK menjadi item sendiri — ia diserap ke item
     * model milik panggilan tool yang mendahuluinya.
     */
    toHistory(messages = []) {

        const out = [];

        for (let i = 0; i < messages.length; i++) {

            const m = messages[i];

            if (m.role === "system") { out.push({ type: "system", text: this.textOf(m.content) }); continue; }
            if (m.role === "user") { out.push({ type: "user", text: this.textOf(m.content) }); continue; }
            if (m.role === "tool") continue;                 // sudah/akan diserap

            if (m.role === "assistant") {

                const response = [];
                const teks = this.textOf(m.content);
                if (teks) response.push(teks);

                for (const call of m.tool_calls ?? []) {
                    const name = call.function?.name ?? call.name;
                    const params = this.parseArguments(call.function?.arguments ?? call.arguments);
                    const result = this._resultFor(messages, call.id, name);
                    response.push({ type: "functionCall", name, params, result });
                }

                // Item model tak boleh kosong; minimal string kosong.
                out.push({ type: "model", response: response.length ? response : [""] });
            }
        }

        return out;
    }

    /** Cari hasil (role:"tool") untuk sebuah panggilan tool. */
    _resultFor(messages, callId, name) {
        for (const m of messages) {
            if (m.role !== "tool") continue;
            const cocok = (callId && m.tool_call_id === callId) || (!callId && m.name === name);
            if (cocok) {
                const raw = this.textOf(m.content);
                try { return JSON.parse(raw); } catch { return raw; }
            }
        }
        return null;                                         // hasil belum ada — model belum dijalankan
    }

    /** tools Damar → ChatModelFunctions node-llama-cpp. */
    toFunctions(tools = []) {
        if (!Array.isArray(tools) || !tools.length) return undefined;
        const fns = {};
        for (const t of tools) {
            const params = t.parameters && typeof t.parameters === "object"
                ? t.parameters
                : { type: "object", properties: {} };
            fns[t.name] = { description: t.description || "", params };
        }
        return fns;
    }

    _finishReason(stopReason, functionCalls) {
        if (functionCalls?.length) return "tool_calls";
        if (stopReason === "maxTokens") return "length";
        return "stop";
    }

    _toolCalls(functionCalls = []) {
        return functionCalls.map((fc, i) => new AIToolCall({
            id: `llamacpp-${Date.now()}-${i}`,
            name: fc.functionName,
            arguments: fc.params ?? {}
        }));
    }

    /** Hasil generate() → AIResponse. */
    toResponse({ response, functionCalls, stopReason }, { model } = {}) {
        return new AIResponse({
            id: `llamacpp-${Date.now()}`,
            model: model ?? null,
            provider: "llamacpp",
            role: "assistant",
            content: response ?? "",
            finishReason: this._finishReason(stopReason, functionCalls),
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 },
            toolCalls: this._toolCalls(functionCalls),
            reasoning: null,
            metadata: { stopReason },
            raw: { response, functionCalls, stopReason }
        });
    }

    /** Potongan teks streaming → AIStreamChunk. */
    toStreamChunk(delta, { model, done = false, finishReason = null, toolCalls = [] } = {}) {
        return new AIStreamChunk({
            id: `llamacpp-${Date.now()}`,
            model: model ?? null,
            provider: "llamacpp",
            role: "assistant",
            delta: delta ?? "",
            finishReason,
            done,
            toolCalls,
            raw: null
        });
    }
}

module.exports = LlamaCppMapper;
