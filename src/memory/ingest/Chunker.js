/**
 * Memecah dokumen panjang menjadi potongan yang layak di-embed.
 *
 * Pemotongan mengikuti batas alami teks — judul, paragraf, lalu
 * kalimat — bukan jumlah karakter mentah. Potongan yang terbelah
 * di tengah kalimat menghasilkan embedding yang kabur dan kutipan
 * yang sulit dibaca manusia.
 */
class Chunker {

    constructor({
        maxChars = 1200,
        minChars = 200,
        overlap = 150
    } = {}) {

        this.maxChars = maxChars;

        this.minChars = minChars;

        // Tumpang tindih menjaga kalimat di perbatasan tetap punya
        // konteks di salah satu potongan.
        this.overlap = overlap;

    }

    chunk(text) {

        const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();

        if (!clean) {
            return [];
        }

        const blocks = this.splitByHeading(clean);

        const chunks = [];

        let ordinal = 0;

        for (const block of blocks) {

            for (const piece of this.splitBlock(block.content)) {

                chunks.push({
                    ordinal: ordinal++,
                    heading: block.heading,
                    content: piece.content,
                    start: block.start + piece.start,
                    end: block.start + piece.end
                });

            }

        }

        return chunks;

    }

    /**
     * Pisahkan berdasarkan judul Markdown atau baris judul pendek
     * yang berdiri sendiri, supaya tiap potongan membawa konteks
     * bagian tempatnya berasal.
     */
    splitByHeading(text) {

        const lines = text.split("\n");

        const blocks = [];

        let heading = null;
        let buffer = [];
        let blockStart = 0;
        let cursor = 0;

        const flush = () => {

            const content = buffer.join("\n").trim();

            if (content) {
                blocks.push({ heading, content, start: blockStart });
            }

            buffer = [];

        };

        for (const line of lines) {

            const markdownHeading = line.match(/^(#{1,6})\s+(.{1,120})$/);

            const isBareHeading =
                !markdownHeading &&
                line.trim().length > 0 &&
                line.trim().length <= 80 &&
                /^[A-Z0-9][^.!?]*$/.test(line.trim()) &&
                buffer.length > 0;

            if (markdownHeading || isBareHeading) {

                flush();

                heading = (markdownHeading ? markdownHeading[2] : line).trim();

                blockStart = cursor;

            }
            else {

                if (buffer.length === 0) {
                    blockStart = cursor;
                }

                buffer.push(line);

            }

            cursor += line.length + 1;

        }

        flush();

        return blocks.length ? blocks : [{ heading: null, content: text, start: 0 }];

    }

    splitBlock(block) {

        if (block.length <= this.maxChars) {
            return [{ content: block, start: 0, end: block.length }];
        }

        const paragraphs = block.split(/\n\s*\n/);

        const pieces = [];

        let current = "";
        let currentStart = 0;
        let cursor = 0;

        const push = () => {

            const content = current.trim();

            if (content) {
                pieces.push({
                    content,
                    start: currentStart,
                    end: currentStart + content.length
                });
            }

        };

        for (const paragraph of paragraphs) {

            // Paragraf tunggal yang lebih besar dari batas dipecah
            // per kalimat; kalau tetap terlalu panjang, dipotong keras.
            if (paragraph.length > this.maxChars) {

                push();

                current = "";

                for (const sentence of this.splitSentences(paragraph)) {

                    if (current.length + sentence.length > this.maxChars) {
                        push();
                        current = this.tail(current);
                        currentStart = cursor;
                    }

                    current += sentence;

                }

            }

            else if (current.length + paragraph.length > this.maxChars) {

                push();

                current = this.tail(current);

                currentStart = cursor;

                current += `${paragraph}\n\n`;

            }

            else {

                if (!current) {
                    currentStart = cursor;
                }

                current += `${paragraph}\n\n`;

            }

            cursor += paragraph.length + 2;

        }

        push();

        return pieces.filter(piece => piece.content.length >= Math.min(this.minChars, 1));

    }

    splitSentences(text) {

        // Pemisah kalimat sederhana; tanda baca tetap ikut agar
        // potongan bisa dibaca utuh.
        const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];

        const result = [];

        for (const part of parts) {

            if (part.length <= this.maxChars) {
                result.push(part);
                continue;
            }

            // Kalimat raksasa (tabel, dump log) dipotong keras.
            for (let i = 0; i < part.length; i += this.maxChars) {
                result.push(part.slice(i, i + this.maxChars));
            }

        }

        return result;

    }

    /** Ambil ekor potongan sebelumnya sebagai tumpang tindih. */
    tail(text) {

        if (!this.overlap || text.length <= this.overlap) {
            return "";
        }

        const tail = text.slice(-this.overlap);

        const boundary = tail.search(/[.!?]\s/);

        return boundary >= 0 ? `${tail.slice(boundary + 2)}` : tail;

    }

}

module.exports = Chunker;
