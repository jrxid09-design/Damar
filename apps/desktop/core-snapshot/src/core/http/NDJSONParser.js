/**
 * Parser untuk response bergaya NDJSON / JSON-lines
 * (satu objek JSON utuh per baris) — format yang dipakai
 * sebagian backend lokal untuk streaming, berbeda dari SSE milik OpenAI.
 */
class NDJSONParser {

    static async *parse(stream) {

        const reader = stream.getReader();

        const decoder = new TextDecoder();

        let buffer = "";

        try {

            while (true) {

                const { value, done } = await reader.read();

                if (done) {

                    yield* this.parseLine(buffer);

                    break;

                }

                buffer += decoder.decode(value, {
                    stream: true
                });

                const lines = buffer.split(/\r?\n/);

                // Baris terakhir mungkin belum lengkap.
                buffer = lines.pop() ?? "";

                for (const line of lines) {

                    yield* this.parseLine(line);

                }

            }

        }

        finally {

            reader.releaseLock?.();

        }

    }

    static *parseLine(line) {

        const text = line.trim();

        if (!text) {
            return;
        }

        try {

            yield JSON.parse(text);

        }

        catch {

            // Baris rusak / potongan yang tidak valid dilewati
            // supaya stream tidak ikut mati.

        }

    }

}

module.exports = NDJSONParser;
