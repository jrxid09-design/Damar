const response = require("../utils/response");

const agentHub = require("../services/agentHub");
const orchestrator = require("../services/orchestrator");

class OrchestratorController {

    async agents(req, res, next) {

        try {
            return response.success(res, "Agents", {
                agents: await agentHub.health()
            });
        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Jalankan orkestrasi dan pancarkan prosesnya lewat SSE:
     * planning → plan → step:start/step:done (per langkah) → final.
     */
    async orchestrate(req, res) {

        const { request } = req.body ?? {};

        if (!request || !String(request).trim()) {
            return response.error(res, "Field 'request' wajib diisi.", 400);
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });

        const send = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        let aborted = false;
        res.on("close", () => { aborted = true; });

        try {

            // N2: identitas terautentikasi pemohon menjadi identitas
            // delegasi — orkestrasi tidak boleh melebar ke 'system'.
            await orchestrator.run(String(request), (event) => {
                if (!aborted) {
                    send(event.type, event);
                }
            }, { exec: req.authIdentity ?? null });

            if (!aborted) {
                send("done", { ok: true });
            }

        }

        catch (error) {

            if (!aborted) {
                send("error", { message: error.message });
            }

        }

        finally {
            res.end();
        }

    }

}

module.exports = new OrchestratorController();
