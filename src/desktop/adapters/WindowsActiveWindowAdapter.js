/**
 * WINDOWS ACTIVE WINDOW ADAPTER — satu-satunya adapter nyata V0.
 *
 * Sengaja kecil dan dependency-light: polling metadata jendela latar
 * depan (judul + PID) lewat PowerShell bawaan Windows — TANPA
 * dependensi eksternal, TANPA tangkapan layar, TANPA input injection.
 *
 * Kontrak lifecycle sama dengan FakeDesktopAdapter: start()/stop()
 * eksplisit, emit hanya saat berjalan. Polling berhenti total saat
 * stop() — tidak ada loop yang tertinggal (no continuous capture).
 *
 * Integrasi UI Automation masa depan (accessibility tree → elemen
 * semantik fokus → dokumen/seleksi) menempel DI SINI sebagai adapter
 * terpisah; V0 hanya menyediakan titik jangkar observasi ini.
 */

const { spawn } = require("node:child_process");
const { DESKTOP_EVENT, ENTITY_TYPE, RELATIONSHIP } = require("../types");

const ADAPTER_ID = "windows-active-window";
const POLL_MS_DEFAULT = 1000;

class WindowsActiveWindowAdapter {

    constructor({ emit, clock = () => Date.now(), pollMs = POLL_MS_DEFAULT } = {}) {
        if (typeof emit !== "function") {
            throw new Error("WindowsActiveWindowAdapter butuh sink emit.");
        }
        this._emit = emit;
        this._clock = clock;
        this._pollMs = Math.max(250, Number(pollMs) || POLL_MS_DEFAULT);
        this._timer = null;
        this._running = false;
        this._lastSignature = null;
        this._obsSeq = 0;

        /** Metadata-only: judul + PID. Tanpa tangkapan layar, tanpa kontrol. */
        this.capabilities = Object.freeze([
            "active_window_metadata"
        ]);
    }

    get adapterId() { return ADAPTER_ID; }
    get isRunning() { return this._running; }

    start() {
        if (this._running) {
            throw new Error(`[${ADAPTER_ID}] start ganda ditolak.`);
        }
        if (process.platform !== "win32") {
            const err = new Error(`[${ADAPTER_ID}] hanya didukung di Windows.`);
            err.code = "UNSUPPORTED_PLATFORM";
            throw err;
        }
        this._running = true;
        this._timer = setInterval(() => this._poll(), this._pollMs);
        this._timer.unref?.();
    }

    stop() {
        if (!this._running) return;
        this._running = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    // ---- internal -------------------------------------------------------

    _poll() {
        // Add-Type sekali per proses powershell; keluarkan JSON kecil:
        // { title, processId }. Metadata saja — bukan konten jendela.
        const script =
            "Add-Type -Namespace W -Name U -MemberDefinition '" +
            "[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();" +
            "[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder t,int c);" +
            "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);' ;" +
            "$h=[W.U]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;" +
            "[void][W.U]::GetWindowText($h,$sb,512);$pid2=0;[void][W.U]::GetWindowThreadProcessId($h,[ref]$pid2);" +
            "Write-Output (@{title=$sb.ToString();processId=$pid2}|ConvertTo-Json -Compress)";

        let child;
        try {
            child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
                windowsHide: true,
                timeout: 5000
            });
        } catch {
            return; // degrade anggun: gagal poll bukan fatal
        }

        let out = "";
        child.stdout?.on("data", (d) => { out += String(d); });
        child.on("error", () => { /* abaikan */ });
        child.on("close", () => {
            if (!this._running) return;   // stop() sudah dipanggil → buang hasil
            try {
                const info = JSON.parse(out.trim().split(/\r?\n/).pop());
                this._maybeActivate(info);
            } catch {
                /* output tidak parse-able → lewati siklus ini */
            }
        });
    }

    _maybeActivate({ title, processId }) {
        const signature = `${processId}|${title}`;
        if (signature === this._lastSignature) return;   // idempoten alami
        this._lastSignature = signature;

        const appId = `win-proc-${processId}`;
        const windowId = `win-fg-${processId}`;
        const label = String(title ?? "");

        this._emit({
            type: DESKTOP_EVENT.WINDOW_ACTIVATED,
            observationId: `${ADAPTER_ID}-obs-${++this._obsSeq}`,
            timestamp: this._clock(),
            source: { adapterId: ADAPTER_ID, trusted: true, provenance: `adapter:${ADAPTER_ID}` },
            subject: windowId,
            entities: [
                { id: appId, type: ENTITY_TYPE.APPLICATION, label: `pid:${processId}`, confidence: 0.8 },
                { id: windowId, type: ENTITY_TYPE.WINDOW, label, attributes: { processId }, confidence: 0.9 }
            ],
            relationships: [
                { from: windowId, relation: RELATIONSHIP.ACTIVE_IN, to: appId }
            ],
            payload: {}
        });
    }

}

module.exports = { WindowsActiveWindowAdapter, ADAPTER_ID };
