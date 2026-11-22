"use strict";
/**
 * SANDBOX ENTRY POINT — executed inside the spawned Node child with the
 * Node permission model active (default-deny fs/child-process/worker).
 * Loads the validated tool module, runs its default export with the tool
 * arguments, prints the JSON result to stdout (the ONLY channel to the parent).
 * Parent environment is NOT inherited — only DAMAR_SANDBOX + explicit
 * scoped material passed by the governed executor.
 */
const path = require("node:path");

const toolModulePath = path.resolve(process.env.SANDBOX_TOOL_MODULE ?? "");
const toolArgs = JSON.parse(process.env.SANDBOX_TOOL_ARGS ?? "{}");

(async () => {
    // validate the module path is inside the sandbox (no parent traversal)
    if (!toolModulePath || toolModulePath.includes("..")) {
        process.stderr.write("SANDBOX: tool module path traversal rejected");
        process.exit(2);
    }
    // load the validated tool (module system + permission model restrict fs)
    const toolModule = require(toolModulePath);
    const toolFn = typeof toolModule === "function" ? toolModule
        : typeof toolModule.default === "function" ? toolModule.default
        : typeof toolModule.execute === "function" ? toolModule.execute
        : null;
    if (typeof toolFn !== "function") {
        process.stderr.write("SANDBOX: tool module does not export a function");
        process.exit(3);
    }
    const result = await toolFn(toolArgs);
    process.stdout.write(JSON.stringify({ ok: true, output: result ?? null }));
    process.exit(0);
})().catch(err => {
    process.stderr.write(`SANDBOX_TOOL_ERROR: ${String(err?.message ?? err).slice(0, 300)}`);
    process.exit(1);
});
