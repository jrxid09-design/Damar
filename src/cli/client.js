/**
 * Klien HTTP untuk bidang kendali daemon Damar.
 *
 * Sengaja cerminan dari apps/console/renderer/lib/api.js — CLI
 * dan Console memakai kontrak yang sama, jadi keduanya bergerak
 * bersama saat API berubah.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Cari token daemon dari instalasi Damar — CLI global dipakai di
 * folder mana pun, tapi .env daemon tetap di folder instalasinya.
 */
function readTokenFromInstall() {
    try {
        const envPath = path.join(__dirname, "..", "..", ".env");
        const m = fs.readFileSync(envPath, "utf8").match(/^DAMAR_TOKEN=(.+)$/m);
        return m ? m[1].trim() : "";
    }
    catch {
        return "";
    }
}

class DaemonClient {

    constructor({ baseUrl, token } = {}) {

        // Default port mengikuti peran: sesi CLI memakai daemon CLI
        // (3001) supaya bisa berjalan bersama daemon Console (3000).
        const fallback =
            process.env.DAMAR_URL
            ?? (String(process.env.DAMAR_ROLE || "").toLowerCase() === "cli"
                ? "http://localhost:3001"
                : "http://localhost:3000");

        this.baseUrl = String(baseUrl ?? fallback).replace(/\/+$/, "");

        // Token: argumen > env. Bila tidak ada, coba .env instalasi
        // Damar (CLI dipakai global dari folder mana pun — token
        // daemon lokal masih bisa ditemukan di sana).
        this.token = token ?? process.env.DAMAR_TOKEN ?? readTokenFromInstall();

        // Kandidat daemon untuk auto-deteksi bila default gagal:
        // daemon CLI dulu, lalu daemon Console. Memungkinkan `damar`
        // dipakai di mana saja tanpa pengaturan.
        this.fallbackUrls = [
            "http://localhost:3001",
            "http://localhost:3000"
        ].filter(u => u !== this.baseUrl);

    }

    get root() {
        return `${this.baseUrl}/api/v1/console`;
    }

    headers(extra = {}) {

        // Menyebut diri: daemon melayani Console dan CLI lewat endpoint
        // yang sama, jadi hanya klien yang tahu ini terminal.
        const headers = { "x-damar-channel": "cli", ...extra };

        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        return headers;

    }

    async request(path, { method = "GET", body = null, timeout = 20000 } = {}) {

        const controller = new AbortController();

        const timer = setTimeout(() => controller.abort(), timeout);

        try {

            const response = await fetch(`${this.root}${path}`, {
                method,
                headers: this.headers(
                    body ? { "Content-Type": "application/json" } : {}
                ),
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok || payload?.success === false) {
                throw new Error(
                    payload?.message ?? `HTTP ${response.status} ${response.statusText}`
                );
            }

            return payload?.data ?? payload;

        }

        catch (error) {

            if (error.name === "AbortError") {
                throw new Error("Permintaan melebihi batas waktu.");
            }

            if (error instanceof TypeError) {
                throw new Error(`Tidak bisa menghubungi daemon di ${this.baseUrl}`);
            }

            throw error;

        }

        finally {
            clearTimeout(timer);
        }

    }

    // ---- Endpoint yang dipakai CLI ------------------------------

    overview()          { return this.request("/overview", { timeout: 25000 }); }
    stats()             { return this.request("/stats"); }
    providers()         { return this.request("/ai/providers", { timeout: 25000 }); }
    selectProvider(id)  { return this.request("/ai/provider", { method: "POST", body: { id } }); }
    models(provider)    { return this.request(`/ai/models${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, { timeout: 25000 }); }
    selectModel(model)  { return this.request("/ai/model", { method: "POST", body: { model } }); }
    tools()             { return this.request("/tools"); }
    runTool(id, args)   { return this.request(`/tools/${encodeURIComponent(id)}/execute`, { method: "POST", body: { args }, timeout: 60000 }); }
    recall(body)        { return this.request("/memory/recall", { method: "POST", body, timeout: 30000 }); }
    remember(body)      { return this.request("/memory", { method: "POST", body }); }
    forget(id)          { return this.request(`/memory/${id}`, { method: "DELETE" }); }
    memoryStats()       { return this.request("/memory/stats", { timeout: 25000 }); }
    integrations()      { return this.request("/integrations"); }

    // ---- Owner Trust (Wave 5 Lane 4) ----
    trustStatus()       { return this.request("/owner-trust/status", { timeout: 25000 }); }
    trustBootstrapBegin(body) { return this.request("/owner-trust/bootstrap/begin", { method: "POST", body, timeout: 25000 }); }
    trustBootstrapComplete(body) { return this.request("/owner-trust/bootstrap/complete", { method: "POST", body, timeout: 25000 }); }
    trustBindConsole()  { return this.request("/owner-trust/bind-console", { method: "POST", body: {} }); }
    trustLinkPolicy(enabled) { return this.request("/owner-trust/link-policy", { method: "POST", body: { enabled } }); }

    /**
     * Chat streaming. Memanggil onChunk untuk tiap potongan SSE.
     * Body fetch di Node adalah ReadableStream web; SSE diurai
     * manual seperti di Console.
     */
    async streamChat(payload, onChunk, signal = null) {

        const response = await fetch(`${this.root}/ai/stream`, {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/json" }),
            body: JSON.stringify(payload),
            signal
        });

        if (!response.ok) {
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.message ?? `HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let buffer = "";

        while (true) {

            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            const frames = buffer.split(/\r?\n\r?\n/);

            buffer = frames.pop() ?? "";

            for (const frame of frames) {

                let event = "message";
                const dataLines = [];

                for (const line of frame.split(/\r?\n/)) {
                    if (line.startsWith("event:")) {
                        event = line.slice(6).trim();
                    }
                    else if (line.startsWith("data:")) {
                        dataLines.push(line.slice(5).trim());
                    }
                }

                if (dataLines.length === 0) {
                    continue;
                }

                try {
                    onChunk({ event, data: JSON.parse(dataLines.join("\n")) });
                }
                catch {
                    // Frame tak utuh — abaikan, jangan putus stream.
                }

            }

        }

    }

    /** Probe cepat: daemon hidup atau tidak. */
    async ping() {

        try {
            await this.request("/stats", { timeout: 2500 });
            return true;
        }
        catch {
            // Default gagal → coba daemon lain di mesin ini sebelum
            // menyerah, agar `damar` "baru pakai tanpa setting".
            // 401/403 = daemon HIDUP (hanya butuh token) — tetap dianggap ada.
            for (const url of this.fallbackUrls ?? []) {
                try {
                    const probe = await fetch(`${url}/api/v1/console/stats`, {
                        signal: AbortSignal.timeout(1500),
                        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
                    });
                    if (probe.ok || probe.status === 401 || probe.status === 403) {
                        this.baseUrl = url;
                        return true;
                    }
                }
                catch { /* lanjut */ }
            }
            return false;
        }

    }

}

module.exports = DaemonClient;
