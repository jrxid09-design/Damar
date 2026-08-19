const AIResponse = require("../../models/AIResponse");
const AIStreamChunk = require("../../models/AIStreamChunk");
const AIToolCall = require("../../tools/AIToolCall");

/**
 * Menerjemahkan AIRequest/AIResponse internal Aether
 * ke/dari format /api/chat milik Ollama.
 */
class OllamaMapper {

    toRequest(request) {

        const options = {};

        if (request.temperature != null) {
            options.temperature = request.temperature;
        }

        if (request.maxTokens != null) {
            options.num_predict = request.maxTokens;
        }

        if (request.metadata?.options) {
            Object.assign(options, request.metadata.options);
        }

        const payload = {

            model: request.model,

            messages: this.toMessages(request.messages),

            stream: request.stream === true

        };

        if (Object.keys(options).length > 0) {
            payload.options = options;
        }

        if (request.metadata?.keepAlive != null) {
            payload.keep_alive = request.metadata.keepAlive;
        }

        if (request.metadata?.format) {
            payload.format = request.metadata.format;
        }

        if (request.tools?.length) {

            payload.tools = request.tools.map(tool => ({

                type: "function",

                function: {

                    name: tool.name,

                    description: tool.description,

                    parameters: tool.parameters

                }

            }));

        }

        return payload;

    }

    /**
     * Ollama memakai `images` (base64) untuk input vision dan
     * tidak mengenal `content` berbentuk array. Bentuk pesan
     * multimodal Aether diratakan di sini.
     */
    toMessages(messages = []) {

        return messages.map(message => {

            const mapped = {
                role: message.role,
                content: message.content ?? ""
            };

            if (Array.isArray(message.content)) {

                const text = [];
                const images = [];

                for (const part of message.content) {

                    if (part.type === "text") {
                        text.push(part.text);
                    }

                    else if (part.type === "image") {
                        images.push(part.data ?? part.image);
                    }

                }

                mapped.content = text.join("\n");

                if (images.length) {
                    mapped.images = images;
                }

            }

            if (message.images?.length) {
                mapped.images = message.images;
            }

            if (message.tool_calls?.length) {

                mapped.tool_calls = message.tool_calls.map(call => ({

                    function: {

                        name: call.function?.name ?? call.name,

                        arguments: this.parseArguments(
                            call.function?.arguments ?? call.arguments
                        )

                    }

                }));

            }

            if (message.role === "tool") {

                mapped.tool_name = message.name;

            }

            return mapped;

        });

    }

    toResponse(data, { model } = {}) {

        const message = data?.message ?? {};

        return new AIResponse({

            id: `ollama-${data?.created_at ?? Date.now()}`,

            model: data?.model ?? model ?? null,

            provider: "ollama",

            role: message.role ?? "assistant",

            content: message.content ?? "",

            finishReason: data?.done_reason ?? (data?.done ? "stop" : null),

            usage: {

                promptTokens: data?.prompt_eval_count ?? 0,

                completionTokens: data?.eval_count ?? 0,

                totalTokens:
                    (data?.prompt_eval_count ?? 0) +
                    (data?.eval_count ?? 0),

                reasoningTokens: 0

            },

            toolCalls: this.toToolCalls(message.tool_calls),

            reasoning: message.thinking ?? null,

            metadata: {

                createdAt: data?.created_at,

                // Ollama melaporkan durasi dalam nanodetik.
                totalDurationMs: this.toMs(data?.total_duration),

                loadDurationMs: this.toMs(data?.load_duration),

                promptEvalDurationMs: this.toMs(data?.prompt_eval_duration),

                evalDurationMs: this.toMs(data?.eval_duration),

                tokensPerSecond: this.tokensPerSecond(data)

            },

            raw: data

        });

    }

    toStreamChunk(data, { model } = {}) {

        const message = data?.message ?? {};

        // Chunk terakhir Ollama membawa hitungan token; chunk
        // biasa tidak. null menandakan "belum tersedia".
        const usage = data?.done
            ? {
                promptTokens: data?.prompt_eval_count ?? 0,
                completionTokens: data?.eval_count ?? 0,
                totalTokens:
                    (data?.prompt_eval_count ?? 0) +
                    (data?.eval_count ?? 0),
                reasoningTokens: 0
            }
            : null;

        return new AIStreamChunk({

            id: `ollama-${data?.created_at ?? Date.now()}`,

            model: data?.model ?? model ?? null,

            provider: "ollama",

            role: message.role ?? "assistant",

            delta: message.content ?? "",

            reasoning: message.thinking ?? null,

            toolCalls: this.toToolCalls(message.tool_calls),

            usage,

            finishReason: data?.done_reason ?? null,

            done: data?.done === true,

            raw: data

        });

    }

    /**
     * Tool call Ollama tidak punya id dan argumennya sudah berupa
     * objek (bukan string JSON seperti OpenAI), jadi id-nya
     * disintesis di sini agar loop tool-calling bisa mencocokkan
     * hasil eksekusi dengan panggilannya.
     */
    toToolCalls(toolCalls) {

        if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
            return [];
        }

        return toolCalls.map((call, index) => {

            const fn = call.function ?? {};

            return new AIToolCall({

                id: call.id ?? `ollama-tool-${Date.now()}-${index}`,

                name: fn.name ?? call.name,

                arguments: this.parseArguments(fn.arguments ?? call.arguments)

            });

        });

    }

    parseArguments(args) {

        if (args == null) {
            return {};
        }

        if (typeof args === "object") {
            return args;
        }

        try {
            return JSON.parse(args || "{}");
        }
        catch {
            return {};
        }

    }

    toMs(nanoseconds) {

        if (typeof nanoseconds !== "number") {
            return null;
        }

        return Math.round(nanoseconds / 1e6);

    }

    tokensPerSecond(data) {

        const tokens = data?.eval_count;
        const duration = data?.eval_duration;

        if (!tokens || !duration) {
            return null;
        }

        return Number(((tokens / duration) * 1e9).toFixed(2));

    }

}

module.exports = OllamaMapper;
