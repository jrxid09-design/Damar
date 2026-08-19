import { api } from "./api.js";

/**
 * Klien terminal: lifecycle lewat REST, I/O lewat WebSocket.
 * (Batas sesuai desain: WS hanya byte I/O; create/list/rename/close = REST.)
 */
export const terminalApi = {

    list() { return api.request("/terminals"); },
    create(body) { return api.request("/terminals", { method: "POST", body }); },
    rename(id, name) { return api.request(`/terminals/${id}`, { method: "PATCH", body: { name } }); },
    close(id, force) { return api.request(`/terminals/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }); },

    /** Attach WS ke satu sesi. Kembalikan pengendali kirim. */
    stream(id, { onSnapshot, onData, onExit, onClose } = {}) {
        const wsBase = api.baseUrl.replace(/^http/i, "ws");
        const token = api.token ? `?token=${encodeURIComponent(api.token)}` : "";
        const ws = new WebSocket(`${wsBase}/api/v1/console/terminals/${id}/stream${token}`);

        ws.onmessage = ev => {
            let f;
            try { f = JSON.parse(ev.data); } catch { return; }
            if (f.t === "snapshot") onSnapshot?.(f);
            else if (f.t === "data") onData?.(f.data);
            else if (f.t === "exit") onExit?.(f.code);
        };
        ws.onclose = () => onClose?.();

        const send = obj => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

        return {
            ws,
            input: d => send({ t: "input", data: d }),
            resize: (cols, rows) => send({ t: "resize", cols, rows }),
            signal: name => send({ t: "signal", name }),
            close: () => { try { ws.close(); } catch { /* abaikan */ } }
        };
    }

};
