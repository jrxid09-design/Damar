/**
 * Plugin Mata Dewa — tool LLM di jalur Tool Intelligence Damar.
 *
 * Tool di sini bersifat READ-ONLY (query/inspect). Tool yang menulis state
 * (watch create/remove, asset import) sengaja TIDAK diekspos ke LLM — mereka
 * mengalir lewat Action Intent → Authority → Actuation → Verification agar
 * tidak ada bypass otoritas dari jalur percakapan.
 */

const mataDewa = require("../../mataDewa");
const { executeDaemonAction, CAPABILITY_FAMILIES } = require("../../mataDewa/actions/executors");

class BaseTool {
    constructor(metadata = {}) {
        this.metadata = metadata;
    }
    async run(args = {}) {
        try {
            const result = await this.execute(args);
            return { ok: true, ...result };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    }
}

function service() {
    return mataDewa.getService();
}

class MataDewaStatusTool extends BaseTool {
    constructor() {
        super({
            name: "mataDewa_status",
            description: "Status Mata Dewa: mode, provider, watch, alert (read-only).",
            parameters: {}
        });
    }
    async execute() {
        const s = service();
        return { status: s.status() };
    }
}

class MataDewaHazardQueryTool extends BaseTool {
    constructor() {
        super({
            name: "mataDewa_hazard_query",
            description: "Query bahaya/observasi spasial di sekitar titik (lat, lon, radiusM). Membedakan 'tidak ada data' dari 'tidak terjadi apa-apa'.",
            parameters: {
                lat: { type: "number", required: true },
                lon: { type: "number", required: true },
                radiusM: { type: "number", required: false }
            }
        });
    }
    async execute(args) {
        return executeDaemonAction(CAPABILITY_FAMILIES.HAZARD_QUERY, args, service());
    }
}

class MataDewaTimelineQueryTool extends BaseTool {
    constructor() {
        super({
            name: "mataDewa_timeline_query",
            description: "Riwayat spasial terbatas di sekitar titik: apa yang berubah, apakah ini sudah ada sebelumnya.",
            parameters: {
                lat: { type: "number", required: true },
                lon: { type: "number", required: true },
                radiusM: { type: "number", required: false }
            }
        });
    }
    async execute(args) {
        return executeDaemonAction(CAPABILITY_FAMILIES.TIMELINE_QUERY, args, service());
    }
}

class MataDewaProvidersTool extends BaseTool {
    constructor() {
        super({
            name: "mataDewa_providers",
            description: "Daftar provider spasial + ketersediaan/kelas akses mereka (read-only).",
            parameters: {}
        });
    }
    async execute() {
        return { providers: service().registry.listProviders() };
    }
}

class MataDewaAssetsNearTool extends BaseTool {
    constructor() {
        super({
            name: "mataDewa_assets_near",
            description: "Aset terpantau dekat titik (read-only). Data privat tidak pernah diekspos keluar jalur ini.",
            parameters: {
                lat: { type: "number", required: true },
                lon: { type: "number", required: true },
                radiusM: { type: "number", required: false }
            }
        });
    }
    async execute(args) {
        const s = service();
        const hits = s.assetRegistry.near({ lat: Number(args.lat), lon: Number(args.lon) }, Number(args.radiusM ?? 25000));
        return { assets: hits.map(h => ({ id: h.asset.id, type: h.asset.type, distanceM: Math.round(h.distanceM) })) };
    }
}

module.exports = [
    new MataDewaStatusTool(),
    new MataDewaHazardQueryTool(),
    new MataDewaTimelineQueryTool(),
    new MataDewaProvidersTool(),
    new MataDewaAssetsNearTool()
];
