class SSEParser {

    static async *parse(stream) {

        const reader = stream.getReader();

        const decoder = new TextDecoder();

        let buffer = "";

        while (true) {

            const { value, done } = await reader.read();

            if (done) {

                if (buffer.trim().length > 0) {

                    yield* this.parseBuffer(buffer);

                }

                break;

            }

            buffer += decoder.decode(value, {

                stream: true

            });

            const events = buffer.split(/\r?\n\r?\n/);

            buffer = events.pop() ?? "";

            for (const event of events) {

                yield* this.parseBuffer(event);

            }

        }

    }

    static *parseBuffer(event) {

        const lines = event.split(/\r?\n/);

        for (const line of lines) {

            const text = line.trim();

            if (!text.startsWith("data:")) {

                continue;

            }

            const data = text.slice(5).trim();

            if (!data || data === "[DONE]") {

                continue;

            }

            try {

                yield JSON.parse(data);

            }

            catch (error) {

                console.warn("Invalid SSE JSON:", data);

            }

        }

    }

}

module.exports = SSEParser;