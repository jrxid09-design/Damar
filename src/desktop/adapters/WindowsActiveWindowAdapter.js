/**
 * WINDOWS ACTIVE WINDOW ADAPTER — satu-satunya adapter nyata V0.
 *
 * Sengaja kecil dan dependency-light: polling metadata jendela latar
 * depan (judul + PID) lewat PowerShell bawaan Windows — TANPA
 * dependensi eksternal, TANPA tangkapan layar, TANPA input injection.
 *
 * Lifecycle ketat (B10):
 * - self-scheduling setTimeout SETELAH poll sebelumnya selesai;
 *   maksimal SATU poll in-flight (spawn baru tidak pernah tumpang-
 *   tindih dengan yang berjalan);
 *   stop() membatalkan timer DAN menghentikan child hidup; stderr
 *   selalu dikonsumsi agar fixture tak tersumbat; handle child
 *   dibersihkan saat selesai — tidak ada akumulasi zombie.
 * - output PowerShell divalidasi (processId integer >= 0, title
 *   string) — keluaran cacat menjadi diagnostik, bukan observasi.
 *
 * Script PowerShell KONSTANTA kompilasi-time; tidak ada shell=true,
 * tidak ada fragmen yang dikendalikan pemanggil.
 *
 * Integrasi UI Automation masa depan (accessibility tree → elemen
 * semantik fokus → dokumen/seleksi) menempel DI SINI sebagai adapter
 * terpisah; V0 hanya menyediakan titik jangkar observasi ini.
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { DESKTOP_EVENT, ENTITY_TYPE, RELATIONSHIP } = require("../types");

const ADAPTER_ID = "windows-active-window";
const POLL_MS_DEFAULT = 1000;
const POLL_MS_MINIMUM = 250;

const POWERSHELL_SCRIPT = [
    "Add-Type -Namespace W -Name U -MemberDefinition '" +
        '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' +
        '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder t,int c);' +
        '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);' +
    "';",
    "$h=[W.U]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;",
    "[void][W.U]::GetWindowText($h,$sb,512);$p=0;[void][W.U]::GetWindowThreadProcessId($h,[ref]$p);",
    "Write-Output (@{title=$sb.ToString();processId=$p}|ConvertTo-Json -Compress)"
].join("");

const SPAWN_ARGS = Object.freeze(["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT]);

class WindowsActiveWindowAdapter {

    /**
     * `deps` untuk pengujian: spawnImpl, setTimeoutImpl, clearTimeoutImpl.
     */
    constructor({
        emit,
        clock = () => Date.now(),
        pollMs = POLL_MS_DEFAULT,
        instanceNonce = null,
        deps = {}
    } = {}) {
        if (typeof emit !== "function") {
            throw new Error("WindowsActiveWindowAdapter butuh sink emit.");
        }
        this._emit = emit;
        this._clock = clock;
        this._pollMs = Math.max(POLL_MS_MINIMUM, Number(pollMs) || POLL_MS_DEFAULT);
        this._nonce = instanceNonce ?? crypto.randomBytes(6).toString("hex");
        this._seq = 0;

        this._spawn = deps.spawnImpl ?? spawn;
        // Platform dapat di-inject untuk pengujian lifecycle lintas-platform.
        this._platform = deps.platform ?? process.platform;
        this._setTimeout = deps.setTimeoutImpl ??
            ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
        this._clearTimeout = deps.clearTimeoutImpl ?? clearTimeout;

        this._running = false;
        this._inFlight = false;
        this._timer = null;
        this._child = null;
        this._diagnostics = [];

        /** Metadata-only: judul + PID. Tanpa tangkapan layar, tanpa kontrol. */
        this.capabilities = Object.freeze(["active_window_metadata"]);
    }

    get adapterId() { return ADAPTER_ID; }
    get instanceNonce() { return this._nonce; }
    get isRunning() { return this._running; }
    get inFlight() { return this._inFlight; }
    get liveChild() { return this._child; }
    get liveTimer() { return this._timer; }
    /** Interval polling efektif setelah penegakan minimum (B11). */
    get effectivePollMs() { return this._pollMs; }
    getDiagnostics() { return this._diagnostics.map((d) => ({ ...d })); }

    start() {
        if (this._running) {
            throw new Error(`[${ADAPTER_ID}] start ganda ditolak.`);
        }
        if (this._platform !== "win32") {
            const err = new Error(`[${ADAPTER_ID}] hanya didukung di Windows.`);
            err.code = "UNSUPPORTED_PLATFORM";
            throw err;
        }
        this._running = true;
        this._schedule();
    }

    stop() {
        if (!this._running && !this._timer && !this._child) return;
        this._running = false;
        if (this._timer) {
            this._clearTimeout(this._timer);
            this._timer = null;
        }
        if (this._child) {
            try { this._child.kill(); } catch { /* sudah mati */ }
            this._child = null;
        }
        this._inFlight = false;
    }

    // ---- internal -------------------------------------------------------

    _schedule() {
        if (!this._running || this._timer || this._inFlight) return;
        this._timer = this._setTimeout(() => {
            this._timer = null;
            this._poll();
        }, this._pollMs);
    }

    _poll() {
        // Penjaga single-flight: poll baru tidak pernah menumpuk.
        if (!this._running || this._inFlight) return;
        this._inFlight = true;

        let child;
        try {
            child = this._spawn("powershell.exe", SPAWN_ARGS, {
                windowsHide: true,
                timeout: 5000
            });
        } catch {
            this._inFlight = false;
            this._schedule();
            return;
        }

        this._child = child;
        let out = "";
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            this._inFlight = false;
            this._child = null;
            if (this._running) this._schedule();
        };

        child.stdout?.on("data", (d) => { out += String(d); });
        child.stderr?.on("data", () => { /* dikonsumsi & diabaikan */ });
        child.on("error", () => finish());
        child.on("close", () => {
            const wasRunning = this._running;
            const captured = out;
            finish();
            if (!wasRunning) return;          // stop() → hasil dibuang
            this._maybeActivate(captured);
        });
    }

    _maybeActivate(rawOutput) {

        let info;
        try {
            const lines = String(rawOutput ?? "").trim().split(/\r?\n/).filter(Boolean);
            info = JSON.parse(lines.pop() ?? "");
        } catch {
            this._diagnose("ADAPTER_OUTPUT_UNPARSEABLE", "keluaran bukan JSON sah");
            return;
        }

        // Validasi keluaran: processId integer >= 0, title string.
        if (!info || !Number.isInteger(info.processId) || info.processId < 0 ||
            typeof info.title !== "string") {
            this._diagnose("ADAPTER_OUTPUT_INVALID",
                "processId harus integer >= 0 dan title harus string");
            return;
        }

        const signature = `${info.processId}|${info.title}`;
        if (signature === this._lastSignature) return;   // idempoten alami
        this._lastSignature = signature;

        const appId = `win-proc-${info.processId}`;
        const windowId = `win-fg-${info.processId}`;
        this._seq += 1;

        this._emit({
            type: DESKTOP_EVENT.WINDOW_ACTIVATED,
            observationId: `${ADAPTER_ID}:${this._nonce}:${String(this._seq).padStart(4, "0")}`,
            timestamp: this._clock(),
            source: { adapterId: ADAPTER_ID },
            subject: windowId,
            entities: [
                { id: appId, type: ENTITY_TYPE.APPLICATION, label: `pid:${info.processId}`, confidence: 0.8 },
                {
                    id: windowId,
                    type: ENTITY_TYPE.WINDOW,
                    label: info.title.slice(0, 512),
                    attributes: { processId: info.processId },
                    confidence: 0.9
                }
            ],
            relationships: [
                { from: windowId, relation: RELATIONSHIP.ACTIVE_IN, to: appId }
            ],
            payload: {}
        });
    }

    _diagnose(reasonCode, detail) {
        this._diagnostics.push({ at: this._clock(), reasonCode, detail });
        if (this._diagnostics.length > 100) this._diagnostics.shift();
    }

}

module.exports = { WindowsActiveWindowAdapter, ADAPTER_ID, POWERSHELL_SCRIPT, SPAWN_ARGS, POLL_MS_MINIMUM };
