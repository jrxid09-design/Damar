// graphify OpenCode plugin (V2 API)
// Injects a knowledge graph reminder before the first shell tool call when the graph exists.
//
// IMPORTANT: keep the reminder string free of backticks and $(...) constructs.
// The hook prepends `echo "<reminder>" ; <cmd>` to the user's bash command;
// backticks inside the double-quoted echo trigger bash command substitution,
// which both corrupts tool output and silently executes the very graphify
// command we are only suggesting. Plain words render fine in opencode's TUI.
import { existsSync } from "fs";
import { join } from "path";

const REMINDER =
  "[graphify] knowledge graph at graphify-out/. For focused questions, run graphify query with your question (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context.";

export default {
  id: "graphify",
  setup(ctx) {
    let reminded = false;
    const directory = ctx.location?.directory ?? process.cwd();

    ctx.tool.hook("execute.before", (event) => {
      if (reminded) return;
      // v2 renamed the bash tool to "shell"; accept both.
      if (event.tool !== "shell" && event.tool !== "bash") return;
      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;

      // ';' not '&&' — Windows PowerShell 5.1 rejects '&&' as a statement
      // separator, breaking the first bash command of the session (#1646).
      event.input = { ...event.input, command: `echo "${REMINDER}" ; ${event.input.command}` };
      reminded = true;
    });
  },
};