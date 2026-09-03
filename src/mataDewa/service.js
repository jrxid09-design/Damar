/**
 * Mata Dewa Service — runtime spasial headless milik Damar.
 *
 * SATU lifecycle dengan Damar: dibuat saat Damar boot, berhenti saat Damar
 * berhenti. Tidak ada langkah peluncuran pengguna, tidak ada port publik
 * kedua, tidak ada aplikasi kedua. Inti headless tetap berjalan walau mode UI
 * MATA_DEWA sedang tertutup (UI state ≠ core monitoring state).
 *
 * Lifecycle: start → ready / degraded → shutdown → status.
 */

const { ProviderRegistry, PROVIDER_STATE } = require("./registry/providerRegistry");
const { MATA_DEWA_MODE, PROVIDER_ACCESS_MODE } = require("./config");
const { GridIndex } = require("./spatial/gridIndex");
const { isValidPoint, haversineMeters } = require("./spatial/geo");
const { WatchEngine } = require("./watch/watchEngine");
const { AlertEngine } = require("./alert/alertEngine");
const { AssetRegistry } = require("./assets/assetRegistry");
const { SpatialTimeline } = require("./timeline/timeline");
const { HAZARD_TYPE } = require("./watch/lightning");
const { normalizeObservation } = require("./observations/observation");

const SUBSYSTEM_STATE = Object.freeze({
    NEW: "new",
    STARTING: "starting",
    READY: "ready",
    DEGRADED: "degraded",
    SHUTTING_DOWN: "shutting_down",
    TERMINATED: "terminated"
});

/** Mode UI konseptual Damar. */
const UI_MODE = Object.freeze({
    NORMAL: "NORMAL",
    MATA_DEWA: "MATA_DEWA",
    SETTINGS: "SETTINGS",
    CONSOLE: "CONSOLE"
});

/** Mode operasi konseptual Mata Dewa. */
const OPERATING_MODE = Object.freeze({
    ASK: "ASK",     // query spasial sesuai permintaan
    WATCH: "WATCH", // pemantauan persisten terkontrol kebijakan
    ALERT: "ALERT"  // notifikasi kejadian proaktif berbasis bukti
});

class MataDewaService {

    /**
     * @param {{
     *   clock?: { nowMs(): number },
     *   credentialResolver?: Function,
     *   maxObservations?: number,
     *   observationIndexCellM?: number
     * }} options
     */
    constructor(options = {}) {
        this.clock = options.clock ?? { nowMs: () => Date.now() };
        this.state = SUBSYSTEM_STATE.NEW;
        this.mode = MATA_DEWA_MODE.ZERO;
        this.uiMode = UI_MODE.NORMAL;
        this.operatingModes = new Set([OPERATING_MODE.ASK]); // ASK selalu tersedia
        this.maxObservations = Number.isFinite(options.maxObservations)
            ? options.maxObservations : 50000;

        this.registry = new ProviderRegistry({
            clock: this.clock,
            credentialResolver: options.credentialResolver ?? null
        });

        // Indeks spasial observasi terkini (untuk watch/fusion; commit 5/6).
        this.observationIndex = new GridIndex(options.observationIndexCellM ?? 25000);
        /** @type {Map<string, object>} observasi terkini per id */
        this.observations = new Map();

        this.lastPollStatuses = [];
        this.degradationReasons = [];
        this._shutdownRequested = false;

        // Engine headless (dimiliki Damar; watch/alert tetap hidup tanpa UI).
        this.assetRegistry = options.assetRegistry ?? new AssetRegistry();
        this.timeline = options.timeline ?? new SpatialTimeline({ clock: this.clock });
        this.watchEngine = options.watchEngine ?? new WatchEngine({
            assetRegistry: this.assetRegistry,
            clock: this.clock,
            pollIntervalMs: options.watchPollIntervalMs ?? 5 * 60 * 1000,
            hazardWindowMs: options.hazardWindowMs ?? 15 * 60 * 1000,
            onAlert: options.onAlert ?? null
        });
        this.alertEngine = options.alertEngine ?? new AlertEngine({
            clock: this.clock,
            deliver: options.alertDeliver ?? null
        });

        // RF sensing — sumber + sesi hanya dari trusted composition
        // (MD-008 spirit; UDP wajib allowLocalUdp eksplisit, replay offline).
        const { buildRfManager } = require("./rf/rfManager");
        this.rfManager = options.rfManager ?? buildRfManager({
            clock: this.clock,
            allowLocalUdp: options.allowLocalUdp === true
        });

        // Kredensial provider — SATU jahitan ke Secret Vault kanonik Damar.
        // Tidak ada store kedua; konfigurasi hanya menyimpan SecretRef.
        const { MataDewaCredentialStore } = require("./credentials");
        this.credentialStore = options.credentialStore ??
            new MataDewaCredentialStore({
                vault: options.vault ?? null,
                filePath: options.credentialsFilePath ?? null
            });
        // Registry memakai resolver vault (fail-closed tanpa kredensial).
        if (options.credentialResolver) {
            this.registry.credentialResolver = options.credentialResolver;
        } else {
            this.registry.credentialResolver = this.credentialStore.resolveCredential;
        }

        // Kamera publik/berotorisasi (fail-closed; MediaIngress di sisi Damar).
        const { CameraRegistry } = require("./media/cctv");
        this.cameraRegistry = options.cameraRegistry ?? new CameraRegistry();

        // MD-001: batas perintah UI visual-only — Publisher terikat pada
        // event stream Damar yang sudah ada (telemetryService). Renderer
        // menerima navigasi mode lewat SSE yang sama; TIDAK ada server kedua.
        const { createUiCommandPublisher } = require("./uiCommands");
        this.uiCommandPublisher = options.uiCommandPublisher ??
            (options.telemetry ? createUiCommandPublisher(options.telemetry) : null);
    }

    /** Daftarkan provider (keyless/berkunci). Aman dipanggil sebelum start. */
    registerProvider(descriptor) {
        if (this.state === SUBSYSTEM_STATE.TERMINATED) {
            throw new Error("Mata Dewa sudah berhenti — tidak dapat mendaftarkan provider");
        }
        return this.registry.registerProvider(descriptor);
    }

    /**
     * Mulai Mata Dewa. Boot tidak pernah melempar karena provider gagal —
     * kegagalan provider menurunkan status ke DEGRADED, bukan mematikan Damar.
     */
    async start() {
        if (this.state === SUBSYSTEM_STATE.READY || this.state === SUBSYSTEM_STATE.DEGRADED) {
            return this.status();
        }
        if (this.state === SUBSYSTEM_STATE.TERMINATED) {
            throw new Error("Mata Dewa sudah terminated — buat instance baru");
        }
        this.state = SUBSYSTEM_STATE.STARTING;
        this._shutdownRequested = false;
        this.degradationReasons = [];

        // Poll awal HANYA provider tanpa kredensial agar status boot jujur:
        // keyless yang berhasil → READY; yang gagal → DEGRADED. Provider
        // berkunci tidak dipaksa di boot (kredensial mungkin belum terpasang).
        // Provider on-demand tanpa poll (mis. routing) ditandai tersedia
        // oleh registry (pollProvider menandai mereka AVAILABLE).
        const keyless = [...this.registry.providers.values()]
            .filter(p => !p.requiresCredential);
        await Promise.allSettled(keyless.map(p => this.registry.pollProvider(p.id, {})));

        this._refreshMode();

        // Boot berhasil bila SUBSISTEM hidup, walau semua provider absen.
        const anyAvailable = this.registry.listProviders()
            .some(p => p.availability === PROVIDER_STATE.AVAILABLE);
        const anyRegistered = this.registry.size > 0;

        if (!anyRegistered) {
            this.state = SUBSYSTEM_STATE.READY; // inti tetap hidup tanpa provider
        } else {
            this.state = anyAvailable ? SUBSYSTEM_STATE.READY : SUBSYSTEM_STATE.DEGRADED;
            if (!anyAvailable) {
                this.degradationReasons.push("no_provider_available_at_boot");
            }
        }

        // Mesin watch headless menyala bersama Mata Dewa (mode WATCH aktif),
        // tanpa bergantung UI. Kegagalan satu tick tidak mematikan apa pun.
        try { this.watchEngine.start(); }
        catch (error) {
            this.degradationReasons.push(`watch_engine_start_failed: ${error.message}`);
        }

        return this.status();
    }

    _refreshMode() {
        const described = this.registry.listProviders();
        const hasPro = described.some(p => p.credentialTier === "PRO" && p.availability === PROVIDER_STATE.AVAILABLE);
        const hasPlus = described.some(p => p.credentialTier === "PLUS" && p.availability === PROVIDER_STATE.AVAILABLE);
        this.mode = hasPro ? MATA_DEWA_MODE.PRO
            : hasPlus ? MATA_DEWA_MODE.PLUS
            : MATA_DEWA_MODE.ZERO;
        return this.mode;
    }

    /**
     * Daftarkan provider opsional berkunci (PLUS/PRO). Mereka melapor
     * UNAVAILABLE "credentials_absent" secara jujur sampai kredensial
     * terpasang via vault — core tetap hidup keyless.
     */
    registerKeyedProviders() {
        const { registerKeyedProviders } = require("./providers/keyed");
        return registerKeyedProviders(this);
    }

    /**
     * Query spasial sesuai permintaan (mode ASK). Poll tipe yang diminta,
     * simpan ke indeks terbatas, kembalikan observasi + status provider.
     */
    async ask({ types = [], bounds = null } = {}) {
        this._assertOperational();
        const { observations, statuses } = await this.registry.pollTypes(types, { bounds });
        this._ingestObservations(observations);
        this.lastPollStatuses = statuses;
        this._refreshMode();
        return { observations, providerStatuses: statuses, mode: this.mode };
    }

    _ingestObservations(observations) {
        for (const obs of observations) {
            this.observations.set(obs.id, obs);
            if (obs.geometry?.type === "point") {
                this.observationIndex.insert(obs.id, obs.geometry, obs.type);
            }
            this.timeline.record(obs, { kind: "observation" });
        }
        // Cache terbatas: buang yang paling lama diterima bila melebihi batas.
        if (this.observations.size > this.maxObservations) {
            const sorted = [...this.observations.values()]
                .sort((a, b) => a.receivedAt - b.receivedAt);
            const excess = this.observations.size - this.maxObservations;
            for (let i = 0; i < excess; i++) {
                this.observations.delete(sorted[i].id);
                this.observationIndex.remove(sorted[i].id);
            }
        }
    }

    /**
     * Ingest observasi dari sumber LOKAL tepercaya (mis. RF sensing) —
     * jalur kanonik yang SAMA dengan observasi provider, tidak ada
     * jalan pintas. Mengembalikan jumlah yang diterima.
     */
    ingestLocalObservations(observations) {
        const list = Array.isArray(observations) ? observations : [];
        const accepted = [];
        for (const item of list) {
            if (!item || item.schemaVersion === undefined) {
                // input mentah — normalisasi ketat dulu (reject-not-clamp)
                const normalized = normalizeObservation(item, { nowMs: this.clock.nowMs() });
                if (normalized.ok) accepted.push(normalized.observation);
                continue;
            }
            accepted.push(item); // sudah kanonik dari rfManager
        }
        this._ingestObservations(accepted);
        return accepted.length;
    }

    /** Observasi terkini dalam radius dari sebuah titik (memakai indeks). */
    observationsNear(point, radiusM) {
        if (!isValidPoint(point) || !(radiusM >= 0)) return [];
        return this.observationIndex.queryRadius(point, radiusM)
            .map(hit => ({ observation: this.observations.get(hit.id), distanceM: hit.distanceM }))
            .filter(x => x.observation);
    }

    /**
     * Ambil observasi hazard dari provider (jembatan Watch Engine → registry).
     * Kegagalan provider TIDAK menjatuhkan watch (mengembalikan array kosong).
     */
    async fetchHazardObservations(hazardType) {
        try {
            // RF presence: observasi lokal RF sudah di-ingest; jangan
            // dipoll provider (RF bukan provider jaringan — satu batas lokal).
            if (hazardType === "rf_presence") {
                const rfObs = [...this.observations.values()].filter(
                    o => o.type === "rf.presence_estimate" || o.type === "rf.motion_estimate");
                return rfObs;
            }
            const { observations } = await this.registry.pollTypes([hazardType], {});
            this._ingestObservations(observations);
            return observations;
        }
        catch {
            return [];
        }
    }

    /**
     * Jalankan satu putaran watch secara eksplisit (juga dipakai tes/Manager).
     */
    async runWatchOnce() {
        return this.watchEngine.tick(
            (hazardType) => this.fetchHazardObservations(hazardType)
        );
    }

    /**
     * Ubah mode UI konseptual. Ini HANYA mengubah state permukaan — inti
     * headless (watch/alert) tidak bergantung padanya.
     *
     * MD-001: perubahan mode yang sah (dari capability executor Manager /
     * komposisi kanonik) diteruskan ke renderer lewat batas perintah UI
     * visual-only. Penolakan pengiriman tidak menggagalkan state — state
     * inti tetap dicatat, delivery dilaporkan jujur.
     */
    setUiMode(mode) {
        if (!Object.values(UI_MODE).includes(mode)) {
            return { ok: false, reason: `ui mode tidak dikenal: ${mode}` };
        }
        this.uiMode = mode;
        let delivered = false;
        let deliveryReason = null;
        if (this.uiCommandPublisher) {
            const wireMode = mode === UI_MODE.MATA_DEWA ? "mata-dewa" : "normal";
            const sent = this.uiCommandPublisher.publishUiCommand("ui.mode.set", { mode: wireMode });
            delivered = sent.ok === true;
            deliveryReason = sent.ok ? null : (sent.reason ?? "publish_failed");
        }
        return { ok: true, uiMode: this.uiMode, delivered, deliveryReason };
    }

    activateMode() { return this.setUiMode(UI_MODE.MATA_DEWA); }
    deactivateMode() { return this.setUiMode(UI_MODE.NORMAL); }

    _assertOperational() {
        if (this.state === SUBSYSTEM_STATE.TERMINATED || this.state === SUBSYSTEM_STATE.SHUTTING_DOWN) {
            throw new Error("Mata Dewa sedang berhenti");
        }
    }

    /** Status ringkas untuk UI/Manager/health. */
    status() {
        return {
            state: this.state,
            mode: this.mode,
            uiMode: this.uiMode,
            operatingModes: [...this.operatingModes],
            providers: this.registry.listProviders(),
            providerCount: this.registry.size,
            observationCount: this.observations.size,
            assetCount: this.assetRegistry.size,
            watch: {
                running: this.watchEngine.isRunning,
                lastRunAtMs: this.watchEngine.lastRunAtMs,
                lastRunStats: this.watchEngine.lastRunStats,
                activeEvents: this.watchEngine.listActiveEvents().length
            },
            alerts: this.alertEngine.stats,
            rf: this.rfManager ? this.rfManager.status() : null,
            degradationReasons: this.degradationReasons.slice(),
            lastPollStatuses: this.lastPollStatuses.slice()
        };
    }

    health() {
        return {
            state: this.state,
            healthy: this.state === SUBSYSTEM_STATE.READY || this.state === SUBSYSTEM_STATE.DEGRADED,
            mode: this.mode,
            degraded: this.state === SUBSYSTEM_STATE.DEGRADED
        };
    }

    /**
     * Berhenti bersama Damar. Idempoten; menghentikan mesin watch (commit 6)
     * dan membersihkan indeks. Tidak pernah melempar saat shutdown.
     */
    async shutdown() {
        if (this.state === SUBSYSTEM_STATE.TERMINATED) return { terminated: true };
        if (this._shutdownRequested) return { terminated: false, already: true };
        this._shutdownRequested = true;
        this.state = SUBSYSTEM_STATE.SHUTTING_DOWN;
        try {
            if (this.watchEngine && typeof this.watchEngine.stop === "function") {
                try { await this.watchEngine.stop(); } catch { /* watch opsional */ }
            }
            // RF: hentikan sumber UDP (replay tidak punya handle terbuka).
            if (this.rfManager && typeof this.rfManager.stop === "function") {
                try { this.rfManager.stop(); } catch { /* rf opsional */ }
            }
            this.observationIndex.clear();
            this.observations.clear();
            this.state = SUBSYSTEM_STATE.TERMINATED;
            return { terminated: true };
        }
        catch {
            this.state = SUBSYSTEM_STATE.TERMINATED;
            return { terminated: true };
        }
    }
}

module.exports = {
    MataDewaService,
    SUBSYSTEM_STATE,
    UI_MODE,
    OPERATING_MODE,
    MATA_DEWA_MODE,
    PROVIDER_ACCESS_MODE
};
