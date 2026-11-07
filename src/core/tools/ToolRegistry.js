const { BaseRegistry } =
    require("../registry");

const toolGuard = require("../safety/toolGuard");

/**
 * Registry tool lintas plugin.
 *
 * Di codebase ini ada dua gaya penulisan tool:
 *
 *   1. Gaya datar  — `this.name` / `this.description` /
 *      `this.parameters`, dengan `execute(context, args)`.
 *      Dipakai mayoritas plugin (http, filesystem, calculator,
 *      system.time).
 *
 *   2. Gaya BaseTool — metadata di `this.metadata`, dengan
 *      `run(args, context)`.
 *
 * Registry menerima keduanya dan menormalkannya, sehingga plugin
 * lama tidak perlu ditulis ulang hanya untuk bisa terdaftar.
 */
class ToolRegistry extends BaseRegistry {

    register(pluginId, tool) {

        const name = this.nameOf(tool);

        if (!name) {

            throw new Error(
                `Tool from plugin "${pluginId}" has no name.`
            );

        }

        return super.register(
            `${pluginId}.${name}`,
            tool
        );

    }

    nameOf(tool) {

        return tool?.metadata?.name ?? tool?.name ?? null;

    }

    /** Metadata ternormalisasi — inilah bentuk yang dilihat UI dan LLM. */
    describeTool(id, tool) {

        return {

            id,

            pluginId: id.includes(".") ? id.slice(0, id.indexOf(".")) : null,

            name: this.nameOf(tool),

            description:
                tool?.metadata?.description ??
                tool?.description ??
                "",

            parameters:
                tool?.metadata?.parameters ??
                tool?.parameters ??
                {}

        };

    }

    describe() {

        return this.entries().map(
            ([id, tool]) => this.describeTool(id, tool)
        );

    }

    async execute(id, args = {}, context = null) {

        const tool = this.get(id);

        if (!tool) {

            throw new Error(
                `Tool '${id}' not found.`
            );

        }

        // Rantai keselamatan bersama (§33, §34, §37, §38, §140).
        // Dijalankan setelah tool ditemukan supaya deklarasi
        // risikonya sendiri terbaca.
        toolGuard.before(id, args, tool);

        let result;

        try {

            // BaseTool membungkus hasil dalam ToolResult lewat run().
            if (typeof tool.run === "function") {
                result = await tool.run(args, context);
            }
            else if (typeof tool.execute === "function") {
                result = await tool.execute(context, args);
            }
            else {
                throw new Error(
                    `Tool '${id}' is not executable.`
                );
            }

        }
        catch (error) {

            toolGuard.failed(id, error);

            throw error;

        }

        await toolGuard.after(id, args, result);

        return result;

    }

}

module.exports = new ToolRegistry();
