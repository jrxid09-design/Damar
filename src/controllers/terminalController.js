const response = require("../utils/response");

const terminals = require("../runtime/terminal/TerminalRuntime");

class TerminalController {

    list(req, res, next) {
        try {
            return response.success(res, "Terminals", {
                available: terminals.available,
                shells: terminals.availableShells(),
                terminals: terminals.list(),
                saved: terminals.saved()
            });
        }
        catch (error) { next(error); }
    }

    create(req, res, next) {
        try {
            const {
                shell, cwd, name, cols, rows,
                owner, purpose, terminalType, createdBy, restartPolicy, persistent, target, elevated
            } = req.body ?? {};
            return response.success(res, "Terminal dibuat", terminals.create({
                shell, cwd, name, cols, rows,
                owner, purpose, terminalType, createdBy, restartPolicy, persistent, target, elevated
            }), 201);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    read(req, res, next) {
        try {
            const s = terminals.get(req.params.id);
            if (!s) return response.error(res, "Terminal tidak ada.", 404);
            return response.success(res, "Output", { meta: s.meta(), output: s.read() });
        }
        catch (error) { next(error); }
    }

    input(req, res, next) {
        try {
            terminals.write(req.params.id, req.body?.data ?? "");
            return response.success(res, "OK", { ok: true });
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    signal(req, res, next) {
        try {
            terminals.signal(req.params.id, req.body?.name ?? "SIGINT");
            return response.success(res, "Sinyal terkirim", { ok: true });
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    resize(req, res, next) {
        try {
            const { cols, rows } = req.body ?? {};
            return response.success(res, "Resize", terminals.resize(req.params.id, cols, rows));
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async execute(req, res, next) {
        try {
            const { command, expect, timeoutMs } = req.body ?? {};
            if (!command) return response.error(res, "Field 'command' wajib.", 400);
            return response.success(res, "Selesai", await terminals.execute(req.params.id, command, { expect, timeoutMs }));
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    rename(req, res, next) {
        try {
            return response.success(res, "Diubah", terminals.rename(req.params.id, req.body?.name ?? ""));
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    remove(req, res, next) {
        try {
            const force = req.query.force === "true" || req.body?.force === true;
            return response.success(res, "Ditutup", { closed: terminals.close(req.params.id, { force }) });
        }
        catch (error) {
            // Terminal SYSTEM terlindungi → 409 agar UI bisa tawarkan "force".
            return response.error(res, error.message, error.code === "SYSTEM_PROTECTED" ? 409 : 400);
        }
    }

}

module.exports = new TerminalController();
