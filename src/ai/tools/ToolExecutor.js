const toolGuard = require("../../core/safety/toolGuard");
const Authorization = require("./Authorization");
const ArgumentValidator = require("./ArgumentValidator");

/**
 * Titik tunggu eksekusi setiap pemanggilan tool oleh model.
 *
 * URUTAN GERBANG (invariant A — disclosure ≠ execution):
 *   1. IDENTITAS wajib ada (fail-closed → 'user')
 *   2. AUTHORIZATION.assertExecution — peran/trust/destruktif-kanal
 *   3. ToolGuard (killSwitch → riskPolicy → loopGuard → pathPolicy)
 *      untuk tool yang TIDAK terbukti dijaga registry intinya
 *
 * Flag `bridged` tidak lagi berdiri sendiri (G7): ia harus dibuktikan
 * — registry inti benar-benar memegang id itu DAN catatannya menandai
 * guardedInternally (dipasang oleh aiRuntimeService.bridgePluginTools,
 * bukan oleh objek sembarang). MCP tidak pernah memenuhinya.
 */
class ToolExecutor {

    constructor(registry) {

        this.registry = registry;

    }

    async execute(call, exec = null) {

        // INVARIANT G: identitas selalu ada — tanpa identitas eksplisit
        // pemanggil jatuh ke peran terendah (fail-closed).
        const identity = Authorization.identity(exec ?? {});

        const tool = this.registry.get(call.name);

        if (!tool) {

            throw ArgumentValidator.make(
                ArgumentValidator.CODES.TOOL_NOT_FOUND,
                `Tool '${call.name}' not found.`
            );

        }

        // 1+2. Otorisasi eksekusi — SEBELUM sentuhan apa pun.
        Authorization.assertExecution(tool, identity);

        // 3. ToolGuard untuk yang tak terbukti dijaga registry intinya.
        const bridged = Authorization.proveBridgedGuarded(tool);

        if (!bridged) {
            toolGuard.before(call.name, call.arguments ?? {}, tool);
        }

        let result;

        try {
            result = await tool.execute(call.arguments, { exec: identity });
        }
        catch (error) {

            if (!bridged) {
                toolGuard.failed(call.name, error, identity);
            }

            throw error;

        }

        if (!bridged) {
            await toolGuard.after(call.name, call.arguments ?? {}, result);
        }

        return {

            toolCallId: call.id,

            name: call.name,

            result

        };

    }

}

module.exports = ToolExecutor;
