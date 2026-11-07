/**
 * Backend pty LOKAL (node-pty). Satu-satunya backend konkret saat ini.
 *
 * Seam untuk masa depan: backend lain (Docker/SSH/Remote) cukup
 * mengekspor bentuk yang sama — { id, available, spawn(opts) } yang
 * mengembalikan handle mirip-pty: { pid, onData, onExit, write, resize, kill }.
 * TerminalRuntime memilih backend via descriptor.target, jadi menambah
 * backend baru TIDAK mengubah manajer.
 */

let _pty;
function lib() {
    if (_pty === undefined) {
        try { _pty = require("node-pty"); }
        catch { _pty = null; }
    }
    return _pty;
}

module.exports = {

    id: "local",

    get available() {
        return lib() !== null;
    },

    /** @returns handle mirip-pty (node-pty IPty). */
    spawn({ shellPath, args = [], cwd, cols = 120, rows = 30, env = {}, useConpty } = {}) {
        const pty = lib();
        if (!pty) throw new Error("node-pty belum diinstall (npm install node-pty).");
        const opts = {
            name: "xterm-256color",
            cols, rows, cwd,
            env: { ...env, TERM: "xterm-256color" }
        };
        // Windows: default winpty (ConPTY memicu spam "AttachConsole failed"
        // saat kill di daemon headless). TAPI elevasi gsudo butuh ConPTY —
        // winpty gagal CreateProcess gsudo. Jadi pemanggil boleh minta ConPTY
        // khusus (mis. terminal admin).
        if (process.platform === "win32") {
            opts.useConpty = typeof useConpty === "boolean" ? useConpty : false;
        }
        return pty.spawn(shellPath, args, opts);
    }

};
