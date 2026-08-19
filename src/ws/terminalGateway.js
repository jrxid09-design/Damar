const { WebSocketServer } = require("ws");

const terminals = require("../runtime/terminal/TerminalRuntime");
const telemetry = require("../services/telemetryService");

/**
 * Gateway WebSocket — HANYA I/O terminal (bukan lifecycle).
 *
 * Lifecycle (create/list/delete/rename) tetap REST. WS cuma pipa byte
 * dua arah untuk satu sesi: pty→klien (output) & klien→pty
 * (input/resize/signal). Saat attach, scrollback diputar ulang
 * (snapshot) supaya klien baru & pengguna melihat layar yang sama —
 * inilah yang membuat terminal benar-benar "dibagi".
 *
 * URL : ws://host:port/api/v1/console/terminals/:id/stream?token=...
 * Auth: AETHER_TOKEN (bila diset) via query token / header Authorization.
 *
 * Frame (JSON):
 *   server→klien : {t:"snapshot",data,meta} · {t:"data",data} · {t:"exit",code}
 *   klien→server : {t:"input",data} · {t:"resize",cols,rows} · {t:"signal",name}
 */

const PATH_RE = /^\/api\/v1\/console\/terminals\/([^/]+)\/stream$/;

let wss = null;

function attach(server) {
    if (wss) return;
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        let url;
        try { url = new URL(req.url, "http://localhost"); }
        catch { return reject(socket, 400); }

        const match = url.pathname.match(PATH_RE);
        if (!match) return;   // biarkan handler upgrade lain (mis. SSE tak pakai upgrade)

        // Auth: sama seperti bidang kendali REST.
        if (process.env.AETHER_TOKEN) {
            const token = url.searchParams.get("token") ||
                (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
            if (token !== process.env.AETHER_TOKEN) return reject(socket, 401);
        }

        const session = terminals.get(match[1]);
        if (!session) return reject(socket, 404);

        wss.handleUpgrade(req, socket, head, ws => bind(ws, session));
    });

    telemetry.info("[terminal] WebSocket gateway aktif: /api/v1/console/terminals/:id/stream");
}

function reject(socket, code) {
    try { socket.write(`HTTP/1.1 ${code} \r\n\r\n`); socket.destroy(); } catch { /* abaikan */ }
}

function bind(ws, session) {
    const send = obj => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

    // Putar ulang layar saat ini + metadata.
    send({ t: "snapshot", data: session.read(), meta: session.meta() });

    const onData = d => send({ t: "data", data: d });
    const onExit = code => send({ t: "exit", code });
    session.on("data", onData);
    session.on("exit", onExit);

    ws.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === "input") session.write(msg.data ?? "");
        else if (msg.t === "resize") session.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
        else if (msg.t === "signal") session.signal(msg.name || "SIGINT");
    });

    const cleanup = () => { session.off("data", onData); session.off("exit", onExit); };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
}

module.exports = { attach };
