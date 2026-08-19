class RuntimeValidator {

    validate(request) {

        if (!request) {
            throw new Error("AIRequest is required.");
        }

        if (!Array.isArray(request.messages)) {
            throw new Error("Messages must be an array.");
        }

        if (request.messages.length === 0) {
            throw new Error("Messages cannot be empty.");
        }

        for (const message of request.messages) {

            if (!message.role) {
                throw new Error("Message role is required.");
            }

            // Pesan assistant yang hanya berisi tool_calls
            // sah punya content kosong/null.
            const hasToolCalls =
                Array.isArray(message.tool_calls) &&
                message.tool_calls.length > 0;

            if (hasToolCalls) {
                continue;
            }

            // Konten boleh string, atau array bagian multimodal
            // (teks + gambar) untuk permintaan vision.
            const validContent =
                typeof message.content === "string" ||
                Array.isArray(message.content);

            if (!validContent) {
                throw new Error(
                    `Message content must be a string or content array (role="${message.role}").`
                );
            }

        }

        return true;

    }

}

module.exports = RuntimeValidator;
