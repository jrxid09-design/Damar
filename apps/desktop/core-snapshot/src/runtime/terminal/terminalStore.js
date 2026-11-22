const path = require("node:path");

const JsonStore = require("../../core/config/JsonStore");

/**
 * Persistensi metadata terminal (per-mesin, gitignored).
 *
 * Catatan penting (ceiling yang disengaja): proses pty TIDAK bisa
 * hidup melintasi restart daemon. Yang disimpan hanya metadata
 * (id/nama/shell/cwd) agar UI bisa MENAWARKAN buka-ulang tab di cwd
 * yang sama. Persistensi proses sejati butuh supervisor terpisah
 * (tmux/ConPTY reattach) — jalur peningkatan, di luar v1.
 */
module.exports = new JsonStore(
    path.join(__dirname, "..", "..", "..", "configs", "terminals.json"),
    { terminals: [] }
);
