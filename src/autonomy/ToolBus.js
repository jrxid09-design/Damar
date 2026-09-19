const { ToolRegistry } = require("../core/tools");

const telemetry = require("../services/telemetryService");

/**
 * TOOLBUS � legacy compatibility façade ONLY (W8 legacy second-path
 * remediation, owner decision ROUTE_THROUGH_CANONICAL_AUTHORITY).
 *
 * WHAT TOOLBUS IS NOW:
 *   discovery        find registered tool NAMES for routing/selection
 *   description      what a tool claims to do (advisory, never authority)
 *   metrics          reliability accounting for selection heuristics
 *
 * WHAT TOOLBUS IS NOT (and must never become again):
 *   - it is NOT an execution owner and NOT a dispatcher;
 *   - it evaluates NO authority and mints NO authority;
 *   - it holds NO handler reference: `resolve()` returns inert metadata only;
 *   - it calls NO tool, terminal, process, shell or device executor;
 *   - a legacy tool request is NOT an ActionIntent, and a legacy tool result
 *     is NOT a verified result.
 *
 * LEGACY TOOL REQUEST != ACTION INTENT
 * TOOLBUS != AUTHORITY
 * TOOL REGISTRY != AUTHORITY
 * TOOL AVAILABILITY != AUTHORITY
 * LEGACY TOOL RESULT != VERIFIED RESULT
 *
 * Every execution attempt therefore fails closed with a typed refusal. The
 * canonical route for any consequential action is:
 *
 *   caller -> canonical Manager / action ingress -> ActionIntent -> Authority
 *          -> Capability Registry/Graph -> canonical actuation path
 *          -> Verification -> Audit
 *
 * Historically this bus framed ToolRegistry/toolGuard and invoked handlers
 * directly; that independent execution authority is REMOVED. Concrete canonical
 * capability/actuator registrations (and any manager-owned legacy ingress that
 * mints a canonical request on behalf of an authenticated principal) belong to
 * W8-IW1, not to this module.
 */

/** Typed fail-closed refusal for any legacy execution attempt. */
const LEGACY_EXECUTION_REFUSED =
    "ditolak otorisasi: ToolBus bukan pemilik otoritas eksekusi; permintaan tool legacy harus melalui jalur kanonik (Manager -> ActionIntent -> Authority -> Capability -> actuation kanonik)";

class ToolBus {

    constructor() {
        this.metrics = new Map();   // name → {calls, ok, fail, totalMs, lastError}
    }

    /** Seluruh tool yang bisa DIJANGKAU untuk routing (registry AI + inti). */
    discover(filter = "") {

        const out = [];

        // Tool AI (model-facing) — termasuk skill buatan forge.
        try {
            const aiRuntime = require("../services/aiRuntimeService");
            for (const t of aiRuntime.tools()) {
                out.push({ name: t.name, description: t.description ?? "", source: "ai" });
            }
        }
        catch { /* runtime belum siap */ }

        // Tool inti (plugin) — id "plugin.tool".
        try {
            for (const d of ToolRegistry.describe()) {
                out.push({ name: d.id, description: d.description ?? "", source: "plugin" });
            }
        }
        catch { /* registry belum siap */ }

        const q = String(filter ?? "").toLowerCase();
        return q ? out.filter(t => t.name.includes(q) || (t.description ?? "").toLowerCase().includes(q)) : out;

    }

    /**
     * Cari METADATA satu tool: AI dulu, lalu plugin inti.
     *
     * Returns inert, non-executable metadata ONLY: the returned record is a
     * notification that a name exists, never a handle that can run anything.
     * No handler, closure, executor or `execute` function is exposed here.
     */
    resolve(name) {

        // Ruas terakhir sebuah nama: "system.time.currentTime" → "currentTime",
        // "filesystem__readFile" → "readFile". Tool hidup dengan DUA gaya
        // nama — plugin dijembatani sebagai "pluginId.namaTool", tool AI
        // memakai namanya sendiri.
        const tail = String(name ?? "").split(/__|\./).pop();

        try {
            const tools = require("../services/aiRuntimeService").tools();
            const hit = tools.find(t => t.name === name)
                ?? tools.find(t => String(t.name).split(/__|\./).pop() === tail);
            if (hit) return { kind: "ai", name: hit.name, description: hit.description ?? "" };
        }
        catch { /* belum siap */ }

        try {
            const desc = ToolRegistry.describe();
            const d = desc.find(x => x.id === name)
                ?? desc.find(x => String(x.id).split(/__|\./).pop() === tail);
            if (d) return { kind: "plugin", name: d.id, description: d.description ?? "" };
        }
        catch { /* belum siap */ }

        return null;

    }

    /**
     * Legacy compatibility entry point — REFUSES, unconditionally.
     *
     * The shape of the result is preserved for legacy callers
     * ({ok, result, error, tool, executedTool, via, attempts, durationMs}) so
     * callers degrade honestly instead of crashing, but NO handler is invoked
     * and no authority is evaluated or minted here.
     *
     * @returns {Promise<{ok: boolean, result: null, error: string, tool: string,
     *   executedTool: null, via: null, attempts: Array, durationMs: number}>}
     */
    async execute({ name, args = {}, timeoutMs = 60000, retries = 1, context = null, allowSubstitute = true } = {}) {

        void args; void timeoutMs; void retries; void context; void allowSubstitute;

        const started = Date.now();
        const refusal = this.refuse(name, Date.now() - started);
        this.record(name, false, refusal.durationMs, refusal.error);
        return refusal;

    }

    /** The single, typed, fail-closed refusal record for a legacy request. */
    refuse(name, durationMs = 0) {

        const toolName = typeof name === "string" ? name : String(name);

        return {
            ok: false,
            result: null,
            error: LEGACY_EXECUTION_REFUSED,
            tool: toolName,
            executedTool: null,
            via: null,
            attempts: [{ tool: toolName, ok: false, error: LEGACY_EXECUTION_REFUSED, refused: "no-legacy-execution-authority" }],
            durationMs
        };

    }

    /** Statistik eksekusi untuk trust score & routing (§13/§39). */
    record(name, ok, ms, error) {

        const m = this.metrics.get(name) ?? { calls: 0, ok: 0, fail: 0, totalMs: 0, lastError: null };

        m.calls++; m.totalMs += ms;
        ok ? m.ok++ : m.fail++;
        if (!ok) m.lastError = error;

        this.metrics.set(name, m);

        // Ingatan operasional persisten — dipakai ranker seleksi
        // secara konservatif (lihat ai/tools/ToolStats.js).
        try {
            require("../ai/tools/ToolStats").record(name, ok, ms);
        }
        catch { /* pencatatan tak boleh menggagalkan eksekusi */ }

        // Pencatatan observability TIDAK memiliki otoritas: sink yang gagal
        // tidak boleh mengubah hasil (yang sudah fail-closed) maupun melempar
        // keluar dari bus.
        try { telemetry.publish("toolbus:exec", { tool: name, ok, ms }); }
        catch { /* sink observability gagal - hasil tidak berubah */ }

    }

    snapshot() {
        return [...this.metrics.entries()].map(([name, m]) => ({
            name,
            calls: m.calls,
            ok: m.ok,
            fail: m.fail,
            avgMs: m.calls ? Math.round(m.totalMs / m.calls) : 0,
            reliability: m.calls ? +(m.ok / m.calls).toFixed(3) : null,
            lastError: m.lastError
        }));
    }

    /** Health check sebuah tool — metadata only, tidak pernah mengeksekusi. */
    health(name) {
        const m = this.metrics.get(name);
        const resolved = this.resolve(name);
        return {
            name,
            registered: Boolean(resolved),
            reliability: m?.calls ? +(m.ok / m.calls).toFixed(3) : null,
            calls: m?.calls ?? 0,
            lastError: m?.lastError ?? null
        };
    }

}

module.exports = new ToolBus();
