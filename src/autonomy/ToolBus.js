const { ToolRegistry } = require("../core/tools");

const toolGuard = require("../core/safety/toolGuard");
const telemetry = require("../services/telemetryService");

/**
 * TOOLBUS — satu antarmuka eksekusi untuk SEMUA kapabilitas (§7).
 *
 * Setiap pemanggilan tool — dari model, agent, misi, atau loop otonomi
 * — melewati bus ini dan mendapat:
 *   discovery        → cari tool bila nama persis tak dikenal
 *   validasi skema   → argumen wajib tak boleh kosong
 *   timeout          → per-panggilan, bukan global
 *   retry            → error transien dicoba ulang dengan backoff
 *   substitusi       → tool alternatif bila utama gagal permanen (§34)
 *   metrik + log     → durasi/status tercatat utk trust score (§39)
 *
 * ToolBus TIDAK menggantikan ToolRegistry/toolGuard — ia membingkai
 * keduanya: registry tetap penyimpanan, guard tetap penjaga. Bus
 * menambahkan lapisan ketahanan di atasnya.
 */

/** Kandidat substitusi per domain tool (§34). */
const SUBSTITUTES = {
    browse: ["get", "post"],
    get: ["browse"],
    download: ["terminal_run"],
    terminal_run: ["terminal_restart"],
    memory_recall: ["memory_related", "memory_documents"],
    memory_related: ["memory_recall"],
    code_test: ["code_check_syntax"],
    code_definition: ["code_references", "code_graph_query"],
    see_camera: ["list_cameras", "describe_image"],
    osint_investigate: ["osint_email", "osint_username", "browse"],
    opencode_run: ["code_plan"]
};

/** Error yang layak dicoba ulang (transien). */
const RETRYABLE = /timeout|etimedout|econnreset|econnrefused|temporarily|rate.?limit|502|503|504|busy|hung up|aborted|fetch failed/i;

class ToolBus {

    constructor() {
        this.metrics = new Map();   // name → {calls, ok, fail, totalMs, lastError}
    }

    /** Seluruh tool yang bisa dieksekusi bus (registry AI + inti). */
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

    /** Cari satu tool executable: AI dulu, lalu plugin inti. */
    resolve(name) {

        // Ruas terakhir sebuah nama: "system.time.currentTime" → "currentTime",
        // "filesystem__readFile" → "readFile". Tool hidup dengan DUA gaya
        // nama — plugin dijembatani sebagai "pluginId.namaTool", tool AI
        // memakai namanya sendiri — dan pencocokan yang hanya persis
        // membuat keduanya tak saling kenal. Itu yang membuat "jam" gagal
        // menemukan currentTime lalu jatuh ke agent yang lambat.
        const tail = String(name ?? "").split(/__|\./).pop();

        try {
            const tools = require("../services/aiRuntimeService").tools();
            const hit = tools.find(t => t.name === name)
                ?? tools.find(t => String(t.name).split(/__|\./).pop() === tail);
            if (hit) return { kind: "ai", tool: hit, execute: (args, ctx) => hit.execute(args ?? {}, ctx) };
        }
        catch { /* belum siap */ }

        try {
            const desc = ToolRegistry.describe();
            const d = desc.find(x => x.id === name)
                ?? desc.find(x => String(x.id).split(/__|\./).pop() === tail);
            if (d) {
                return { kind: "plugin", tool: d, execute: (args) => ToolRegistry.execute(d.id, args ?? {}, { source: "autonomy" }) };
            }
        }
        catch { /* belum siap */ }

        return null;

    }

    /**
     * Eksekusi satu tool dengan ketahanan penuh.
     *
     * @param {object} opts
     * { name, args, timeoutMs, retries, context: {agent,mission,goal},
     *   allowSubstitute }
     * @returns {Promise<{ok, result?, error?, tool, attempts, durationMs, via?}>}
     */
    async execute({ name, args = {}, timeoutMs = 60000, retries = 1, context = null, allowSubstitute = true }) {

        const started = Date.now();
        const attempts = [];

        let outcome = await this.tryOnce(name, args, timeoutMs, context);
        attempts.push({ tool: name, ok: outcome.ok, error: outcome.error });

        // Retry untuk error transien.
        let tries = 0;
        while (!outcome.ok && tries < retries && RETRYABLE.test(outcome.error ?? "")) {
            tries++;
            await sleep(300 * tries);
            outcome = await this.tryOnce(name, args, timeoutMs, context);
            attempts.push({ tool: name, ok: outcome.ok, retry: tries });
        }

        // Substitusi: coba alternatif untuk kegagalan permanen.
        // Argumen milik tool ASLI — substitusi hanya boleh jalan bila
        // argumen itu sah untuk tool penggantinya (parameter wajib
        // terpenuhi); kalau tidak, biarkan gagal daripada mengeksekusi
        // tool lain dengan arti yang melenceng.
        let via = null;
        if (!outcome.ok && allowSubstitute) {
            for (const alt of (SUBSTITUTES[name] ?? [])) {

                const altResolved = this.resolve(alt);

                // Kompatibilitas dinilai validator otoritatif.
                const altCheck = altResolved
                    ? require("../ai/tools/ArgumentValidator").validate(altResolved.tool, args)
                    : { ok: false };

                if (!altCheck.ok) {
                    attempts.push({ tool: alt, ok: false, substitute: true, skipped: "args-incompatible" });
                    continue;
                }

                const sub = await this.tryOnce(alt, args, timeoutMs, context);
                attempts.push({ tool: alt, ok: sub.ok, substitute: true });
                if (sub.ok) {
                    outcome = sub;
                    via = alt;
                    break;
                }
            }
        }

        // Akuntansi jujur (H6): keberhasilan B (substitusi) TIDAK boleh
        // dikreditkan ke A. Masing-masing dicatat atas namanya sendiri;
        // hasil agregat tetap dilaporkan dengan via=substitution.
        if (via && outcome.ok) {
            this.record(name, false, Date.now() - started, "SUBSTITUTED");
            this.record(via, true, Date.now() - started, null);
        }
        else {
            this.record(name, outcome.ok, Date.now() - started, outcome.error);
        }

        return {
            ok: outcome.ok,
            result: outcome.result ?? null,
            error: outcome.error ?? null,
            tool: name,
            executedTool: via ?? name,
            via: via ? "substitution" : null,
            attempts,
            durationMs: Date.now() - started
        };

    }

    async tryOnce(name, args, timeoutMs, context) {

        const resolved = this.resolve(name);

        if (!resolved) {
            return { ok: false, error: `tool tidak ditemukan: ${name}` };
        }

        // GERBANG OTORISASI TUNGGAL (invariant J) — C1 FIXED:
        //
        // ToolBus TIDAK PERNAH memproduksi identitas. Dulu
        // `context?.role ?? "system"` menjadikan wrapper model-facing
        // (tool_exec) terowongan privilese: admin ditolak langsung
        // terminal_run tetapi lolos lewat tool_exec.
        //
        // Aturan sekarang:
        //   - identitas WAJIB datang dari pemanggil tepercaya
        //     (ExecutionContext asli: ToolExecutor/GoalEngine internal);
        //   - identitas hilang → Authorization.identity() jatuh ke
        //     'user' (fail-closed), BUKAN system;
        //   - delegasi hanya MENYEMPITKAN: wrapper boleh menandai
        //     via/worker, tidak boleh menaikkan peran.
        //
        // L1/CLOSURE — OTORISASI SEBELUM VALIDASI ARGUMEN: pemanggil
        // di luar set/peran menerima PERMISSION_DENIED tanpa sempat
        // belajar schema argumen tool yang dilarangnya.
        const Authorization = require("../ai/tools/Authorization");

        // Grant kanonik otonom (symbol in-process, tak bisa dipalsukan
        // JSON/model/HTTP) = batas runtime positif-teridentifikasi;
        // kontrak resolveDelegator sama seperti agentHub.delegatedRoleOf:
        // peran efektifnya 'system', TETAP terkunci capabilitySet-nya.
        const execCtx = context?.exec ?? null;
        const grantIsCanonical =
            Authorization.isCanonicalInternalGrant(execCtx);

        // M-1: identitas dengan restriction malformed = ditolak
        // terstruktur (fail-closed), bukan melempar keluar dari bus.
        let identity;
        try {
            identity = Authorization.identity({
                ...(execCtx ?? {}),
                role: execCtx?.role ??
                    (grantIsCanonical ? "system" : context?.role),   // tanpa default istimewa lain
                channel: execCtx?.channel ?? context?.channel ?? "toolbus",
                sessionId: execCtx?.sessionId ?? context?.sessionId ?? `toolbus:${context?.mission ?? "adhoc"}`,
                workerId: execCtx?.workerId ?? context?.agent ?? null,
                missionId: context?.mission ?? null
            });
        }
        catch (identityError) {
            return { ok: false, error: `ditolak otorisasi: ${identityError.message}` };
        }

        try {
            Authorization.assertExecution(resolved.tool, identity);
        }
        catch (error) {
            return { ok: false, error: `ditolak otorisasi: ${error.message}` };
        }

        // Validasi OTORITATIF via ArgumentValidator V2 (satu validator,
        // rekursif; dulu required-only duplikat di sini).
        const verdict = require("../ai/tools/ArgumentValidator")
            .validate(resolved.tool, args);

        if (!verdict.ok) {
            return { ok: false, error: verdict.error.message };
        }

        const validatedArgs = verdict.args;

        // Rem kebuntuan scoped + rantai keselamatan untuk yang tak
        // terbukti dijaga registry intinya (buktikan via Authorization).
        const bridgedProven = Authorization.proveBridgedGuarded(resolved.tool);

        if (resolved.kind === "ai" && !bridgedProven) {
            try {
                toolGuard.before(name, args, resolved.tool, { sessionId: context?.sessionId });
            }
            catch (error) {
                return { ok: false, error: `ditolak kebijakan: ${error.message}` };
            }
        }

        try {

            // M3/CLOSURE: identitas giliran diteruskan ke tool AI —
            // nested turn (mis. think_deeply) mewarisi role+capabilitySet
            // pemanggil; restriction tidak jatuh di dalam bus.
            const value = await withTimeout(
                resolved.execute(validatedArgs, { exec: identity }),
                timeoutMs,
                `ToolBus timeout ${name} (${timeoutMs}ms)`
            );

            // toolGuard.after untuk jalur AI-native (konsisten rantai
            // keselamatan; plugin sudah dijaga ToolRegistry).
            if (resolved.kind === "ai" && !resolved.tool.bridged) {
                try { await toolGuard.after(name, validatedArgs, value); }
                catch (guardError) { return { ok: false, error: `ditolang verifikasi: ${guardError.message}` }; }
            }

            return { ok: true, result: value };

        }
        catch (error) {
            try { toolGuard.failed(name, error); } catch { /* opsional */ }
            return { ok: false, error: error.message ?? String(error) };
        }

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

        telemetry.publish("toolbus:exec", { tool: name, ok, ms });

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

    /** Health check sebuah tool — eksekusi ringan/deskripsi (§39). */
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

const VERR_IS = (e) => Boolean(e);

function validateRequired(tool, args) {

    const params = tool?.parameters;

    if (!params || typeof params !== "object") return null;

    // Bentuk AITool: { type:"object", properties:{...}, required:[...] }
    // Bentuk plugin describe: { nama: { required: true } }
    if (Array.isArray(params.required)) {
        for (const key of params.required) {
            if (args?.[key] === undefined || args?.[key] === null || args?.[key] === "") {
                return `parameter wajib '${key}' kosong untuk ${tool.name ?? "?"}`;
            }
        }
    }
    else if (params.properties && typeof params.properties === "object") {
        // plugin: required ditandai dalam definisi parameter
    }

    return null;

}

function withTimeout(promise, ms, message) {

    if (!ms || ms <= 0) return promise;

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => reject(new Error(message)), ms);

        promise
            .then(v => { clearTimeout(timer); resolve(v); })
            .catch(e => { clearTimeout(timer); reject(e); });

    });

}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = new ToolBus();
