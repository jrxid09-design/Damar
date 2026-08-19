const Table = require("cli-table3");

const { c, symbols } = require("./theme");

/**
 * Perintah slash dan alur chat untuk Aether CLI.
 *
 * Chat memakai endpoint streaming yang sama dengan Console, jadi
 * jawaban muncul token demi token — termasuk saat model memanggil
 * tool memori/plugin di daemon.
 */

async function handle(session, input) {

    const [name, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();

    const command = COMMANDS[name.toLowerCase()];

    if (!command) {
        console.log(`  ${symbols.warn} ${c.warn(`Perintah tidak dikenal: /${name}`)} ${c.dim("— /help")}`);
        return;
    }

    return command.run(session, arg);

}

/**
 * Kirim pesan dan render jawaban streaming.
 * Gaya agent-CLI: prefix aktor, langkah tool tercantum sebagai
 * baris status ringkas (✦ tool …) sebelum jawaban mengalir.
 */
async function chat(session, text) {

    session.messages.push({ role: "user", content: text });

    // Payload disusun sebelum placeholder — pesan asisten kosong
    // tidak boleh terkirim sebagai prefill (bikin jawaban kosong).
    const payload = {
        messages: session.messages
            .filter(m => m.content)
            .map(({ role, content }) => ({ role, content })),
        model: session.model ?? undefined
    };

    session.aborter = new AbortController();

    let answer = "";
    let printedHeader = false;

    // Label aktor gaya agent-CLI: amber = Aether (identitas).
    const label = `${c.amber("◆")} ${c.amber.bold("Aether")}`;

    try {

        await session.client.streamChat(
            payload,
            ({ event, data }) => {

                if (event === "chunk" && data.delta) {

                    if (!printedHeader) {
                        process.stdout.write(`  ${label}  `);
                        printedHeader = true;
                    }

                    answer += data.delta;
                    process.stdout.write(c.text(data.delta));

                }

                // Tool dipanggil model → baris status ringkas.
                else if (event === "chunk" && Array.isArray(data.toolCalls) && data.toolCalls.length) {
                    for (const tc of data.toolCalls) {
                        const name = tc.function?.name ?? tc.name ?? "tool";
                        process.stdout.write(`\r  ${c.violet("✦")} ${c.muted(`tool ${name}…`)}\n`);
                    }
                }

                else if (event === "error") {
                    console.log(`\n  ${symbols.err} ${c.danger(data.message)}`);
                }

            },
            session.aborter.signal
        );

        process.stdout.write("\n");

        if (answer) {
            session.messages.push({ role: "assistant", content: answer });
        }

    }

    catch (error) {

        if (error.name === "AbortError") {
            process.stdout.write("\n");
        }
        else {
            console.log(`  ${symbols.err} ${c.danger(error.message)}`);
        }

    }

    finally {
        session.aborter = null;
    }

}

// ---- Perintah -------------------------------------------------------

const COMMANDS = {

    help: {
        desc: "tampilkan daftar perintah",
        run() {

            const rows = Object.entries(COMMANDS)
                .map(([name, cmd]) => `  ${c.accent2("/" + name).padEnd(24)} ${c.muted(cmd.desc)}`)
                .join("\n");

            console.log(`\n${c.text("Perintah:")}\n${rows}\n`);
            console.log(`  ${c.dim("Selain itu, ketik apa saja untuk ngobrol. Ctrl-C membatalkan jawaban.")}\n`);

        }
    },

    status: {
        desc: "ringkasan kesiapan sistem",
        async run(session) {

            const o = await session.client.overview();

            const line = (label, value) =>
                console.log(`  ${c.muted(label.padEnd(14))} ${c.text(value)}`);

            console.log("");
            line("Daemon", `${o.daemon.name} v${o.daemon.version} ${symbols.dot} :${o.daemon.port}`);
            line("CPU", `${o.stats.cpu.usage}%  ${symbols.dot}  RAM ${o.stats.memory.usedPercent}%`);
            line("Provider", `${o.ai.active ?? "?"} ${symbols.dot} model ${o.ai.defaultModel ?? "default"}`);

            for (const provider of o.ai.providers ?? []) {
                const dot = provider.online ? symbols.ok : symbols.err;
                console.log(`     ${dot} ${c.dim(provider.id)}`);
            }

            line("Integrasi", `${o.integrations.summary.online}/${o.integrations.summary.enabled} online`);
            line("Plugin/Tool", `${o.plugins.total} plugin ${symbols.dot} ${o.tools.total} tool`);

            try {
                const mem = await session.client.memoryStats();
                line("Memori", `${mem.memories.total} memori ${symbols.dot} ${mem.entities.total} entitas ${symbols.dot} ${mem.documents.total} dokumen`);
            }
            catch { /* memori opsional */ }

            console.log("");

        }
    },

    models: {
        desc: "daftar model provider aktif",
        async run(session) {

            const data = await session.client.models(session.provider);

            const table = new Table({
                head: [c.muted("model"), c.muted("info")],
                style: { head: [], border: [] },
                chars: borderless()
            });

            for (const model of (data.models ?? []).slice(0, 40)) {

                const info = model.size
                    ? `${(model.size / 1e9).toFixed(1)} GB ${model.parameterSize ?? ""}`
                    : (model.contextLength ? `ctx ${model.contextLength}` : "");

                const name = model.id === data.defaultModel
                    ? c.accent(`${model.id}  ${symbols.ok}`)
                    : c.text(model.id);

                table.push([name, c.dim(info)]);

            }

            console.log("\n" + table.toString() + "\n");
            console.log(`  ${c.dim("Ganti dengan")} ${c.accent2("/model <id>")}\n`);

        }
    },

    model: {
        desc: "set model default: /model <id>",
        async run(session, arg) {

            if (!arg) {
                console.log(`  ${c.muted("Model sekarang:")} ${c.accent(session.model ?? "default")}`);
                return;
            }

            const result = await session.client.selectModel(arg);
            session.model = result.defaultModel;
            console.log(`  ${symbols.ok} ${c.muted("model")} ${symbols.arrow} ${c.accent(session.model)}`);

        }
    },

    provider: {
        desc: "ganti provider: /provider <id>",
        async run(session, arg) {

            if (!arg) {
                const p = await session.client.providers();
                console.log(`  ${c.muted("Aktif:")} ${c.accent(p.active)} ${c.dim("—")} ${p.providers.map(x => x.id).join(", ")}`);
                return;
            }

            const result = await session.client.selectProvider(arg);
            session.provider = result.active;
            console.log(`  ${symbols.ok} ${c.muted("provider")} ${symbols.arrow} ${c.accent(session.provider)}`);

        }
    },

    recall: {
        desc: "cari memori: /recall <kata>",
        async run(session, arg) {

            if (!arg) {
                console.log(`  ${c.warn("Contoh: /recall ulang tahun istri")}`);
                return;
            }

            const result = await session.client.recall({ query: arg, limit: 8 });

            console.log(`\n  ${c.muted("strategi:")} ${result.strategies.join("+") || "—"}`);

            if (result.items.length === 0) {
                console.log(`  ${c.dim("(tidak ada memori cocok)")}\n`);
                return;
            }

            for (const item of result.items) {
                const who = item.entities?.length
                    ? c.dim(` [${item.entities.map(e => e.name).join(", ")}]`)
                    : "";
                console.log(`  ${symbols.dot} ${c.text(item.content)}${who} ${c.dim(`(${item.type})`)}`);
            }

            for (const doc of result.documents ?? []) {
                console.log(`  ${c.accent3("¶")} ${c.muted(doc.title ?? "dokumen")}: ${c.dim(doc.excerpt)}`);
            }

            console.log("");

        }
    },

    remember: {
        desc: "simpan memori: /remember <teks>",
        async run(session, arg) {

            if (!arg) {
                console.log(`  ${c.warn("Contoh: /remember NAS di rumah merek Synology DS923+")}`);
                return;
            }

            const memory = await session.client.remember({
                content: arg,
                type: "semantic",
                source: "cli",
                importance: 0.7
            });

            console.log(`  ${symbols.ok} ${c.muted("disimpan")} ${c.dim(`#${memory.id}`)}`);

        }
    },

    forget: {
        desc: "hapus memori: /forget <id>",
        async run(session, arg) {

            const id = Number(arg);

            if (!id) {
                console.log(`  ${c.warn("Sertakan id memori — lihat /recall")}`);
                return;
            }

            await session.client.forget(id);
            console.log(`  ${symbols.ok} ${c.muted("dihapus")} ${c.dim(`#${id}`)}`);

        }
    },

    tools: {
        desc: "daftar tool terdaftar",
        async run(session) {

            const data = await session.client.tools();

            console.log("");
            for (const tool of data.tools) {
                console.log(`  ${c.accent2(tool.id)}  ${c.dim(tool.description || "")}`);
            }
            console.log(`\n  ${c.dim("Jalankan:")} ${c.accent2('/run <id> {"arg":"nilai"}')}\n`);

        }
    },

    run: {
        desc: "jalankan tool: /run <id> <json>",
        async run(session, arg) {

            const space = arg.indexOf(" ");
            const id = space === -1 ? arg : arg.slice(0, space);
            const jsonPart = space === -1 ? "{}" : arg.slice(space + 1);

            if (!id) {
                console.log(`  ${c.warn("Contoh: /run calculator.calculator {\"operation\":\"add\",\"a\":2,\"b\":3}")}`);
                return;
            }

            let args;
            try {
                args = JSON.parse(jsonPart || "{}");
            }
            catch (error) {
                console.log(`  ${symbols.err} ${c.danger("JSON tidak valid: " + error.message)}`);
                return;
            }

            const result = await session.client.runTool(id, args);

            console.log(`  ${symbols.ok} ${c.dim(`${result.duration} ms`)}`);
            console.log(c.text("  " + JSON.stringify(result.result, null, 2).replace(/\n/g, "\n  ")));

        }
    },

    reset: {
        desc: "kosongkan konteks percakapan",
        run(session) {
            session.messages = [];
            console.log(`  ${symbols.ok} ${c.muted("konteks percakapan dikosongkan")}`);
        }
    },

    clear: {
        desc: "bersihkan layar",
        run() {
            process.stdout.write("\x1Bc");
        }
    },

    exit: {
        desc: "keluar",
        run() {
            return "exit";
        }
    },

    quit: {
        desc: "keluar",
        run() {
            return "exit";
        }
    }

};

/** Karakter border kosong agar tabel cli-table3 tampak bersih. */
function borderless() {
    return {
        top: "", "top-mid": "", "top-left": "", "top-right": "",
        bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
        left: "  ", "left-mid": "", mid: "", "mid-mid": "",
        right: "", "right-mid": "", middle: "  "
    };
}

module.exports = { handle, chat };
