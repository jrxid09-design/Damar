const AIResponse = require("../../models/AIResponse");
const AIStreamChunk = require("../../models/AIStreamChunk");
const AIToolCall = require("../../tools/AIToolCall");

// Kunci JSON-Schema yang aman dikirim ke semua provider. Google
// Gemini (endpoint OpenAI-compatible) MENOLAK kunci di luar ini —
// mis. additionalProperties, $schema, format, default — dengan 400
// Bad Request, padahal OpenRouter/OpenAI membiarkannya. Kita saring
// agar satu skema tool berlaku di semua platform.
const ALLOWED_SCHEMA_KEYS = new Set([
    "type", "description", "properties", "required", "items", "enum"
]);

/** Bersihkan skema parameter tool secara rekursif agar lintas-provider. */
function sanitizeSchema(schema) {

    if (!schema || typeof schema !== "object") {
        return schema;
    }

    const out = {};

    for (const [key, value] of Object.entries(schema)) {

        if (!ALLOWED_SCHEMA_KEYS.has(key)) {
            continue;
        }

        if (key === "properties" && value && typeof value === "object") {
            out.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                out.properties[propKey] = sanitizeSchema(propValue);
            }
        }
        else if (key === "items") {
            out.items = sanitizeSchema(value);
        }
        else {
            out[key] = value;
        }

    }

    // `required` yang menyebut properti tak-ada juga memicu 400 di
    // Gemini — buang yang menggantung.
    if (Array.isArray(out.required) && out.properties) {
        out.required = out.required.filter(name => name in out.properties);
        if (out.required.length === 0) {
            delete out.required;
        }
    }

    return out;

}

class OpenRouterMapper {

    toRequest(request) {

        const payload = {

            model: request.model,

            messages: request.messages,

            temperature: request.temperature,

            max_tokens: request.maxTokens,

            stream: request.stream

        };

        if (request.tools?.length) {

            // Batas keras OpenAI-spec: array `tools` maksimum 128 item.
            // resolveTools() biasanya sudah memangkas via AETHER_TOOL_BUDGET,
            // tapi jalur yang melewati budget (mis. tools di-set eksplisit,
            // atau registry membengkak karena skill baru) bisa menembus 128
            // dan provider menolak dengan "maximum number of items is 128" —
            // seluruh panggilan tool gagal. Cap di sini menjamin batas
            // dihormati apa pun sumbernya.
            payload.tools = request.tools.slice(0, 128).map(tool => {

                const fn = {
                    name: tool.name,
                    description: tool.description
                };

                const params = sanitizeSchema(tool.parameters);

                // Tool tanpa parameter: OMIT `parameters` sama sekali.
                // Skema { type:"object", properties:{} } ditolak Gemini
                // (400) — dan OpenAI-spec membolehkan fungsi tanpa param.
                if (params?.properties && Object.keys(params.properties).length > 0) {
                    fn.parameters = params;
                }

                return { type: "function", function: fn };

            });

        }

        if (request.toolChoice) {

            payload.tool_choice = request.toolChoice;

        }

        return Object.fromEntries(

            Object.entries(payload)

                .filter(([, value]) => value !== undefined)

        );

    }

    toResponse(data) {

        const choice = data.choices?.[0] ?? {};

        const message = choice.message ?? {};

        const toolCalls = (message.tool_calls ?? []).map(call =>

            new AIToolCall({

                id: call.id,

                name: call.function.name,

                arguments: JSON.parse(

                    call.function.arguments || "{}"

                )

            })

        );

        return new AIResponse({

            id: data.id,

            model: data.model,

            provider: "openrouter",

            role: message.role ?? "assistant",

            content: message.content ?? "",

            finishReason: choice.finish_reason,

            usage: {

                promptTokens:
                    data.usage?.prompt_tokens ?? 0,

                completionTokens:
                    data.usage?.completion_tokens ?? 0,

                totalTokens:
                    data.usage?.total_tokens ?? 0,

                reasoningTokens:
                    data.usage?.completion_tokens_details?.reasoning_tokens ?? 0

            },

            toolCalls,

            reasoning:
                message.reasoning ?? null,

            metadata: {

                created: data.created,

                fingerprint:
                    data.system_fingerprint,

                serviceTier:
                    data.service_tier

            },

            raw: data

        });

    }

    toStreamChunk(data) {

        const choice = data.choices?.[0] ?? {};

        const delta = choice.delta ?? {};

        // Reasoning model mengirim proses berpikir terpisah dari
        // jawaban (OpenRouter: delta.reasoning; OpenAI-compatible
        // lain kadang delta.reasoning_content). Ini data, bukan
        // noise — diteruskan apa adanya, null bila tidak ada.
        const reasoning =
            delta.reasoning ??
            delta.reasoning_content ??
            null;

        // Beberapa provider menyertakan usage di chunk terakhir
        // (stream_options.include_usage). Bila tidak ada, null —
        // bukan nol — supaya penrima bisa membedakan "belum
        // diketahui" dari "memang kosong".
        const usage = data.usage
            ? {
                promptTokens:
                    data.usage.prompt_tokens ?? 0,
                completionTokens:
                    data.usage.completion_tokens ?? 0,
                totalTokens:
                    data.usage.total_tokens ?? 0,
                reasoningTokens:
                    data.usage.completion_tokens_details
                        ?.reasoning_tokens ?? 0
            }
            : null;

        return new AIStreamChunk({

            id: data.id,

            model: data.model,

            provider: "openrouter",

            role: delta.role ?? "assistant",

            delta: delta.content ?? "",

            reasoning,

            toolCalls: delta.tool_calls ?? [],

            usage,

            finishReason: choice.finish_reason,

            done: choice.finish_reason != null,

            raw: data

        });

    }

}

module.exports = OpenRouterMapper;