/**
 * ADAPTER event foundation → amplop ACC (§92/§93).
 *
 * ACC hanya MEMBACA stream telemetri yang sudah ada; tidak ada modul
 * foundation yang diubah. Tipe telemetri tak dikenal diabaikan
 * (diagnostik hitungan saja).
 */

const { makeEnvelope } = require("../core/envelope");

/** Peta nama event produksi → kelas ACC. */
const MAPPING = {
    "tool:completed": ({ payload }) =>
        /fail|error|denied/i.test(String(payload?.error ?? ""))
            ? null   // kegagalan sudah tercakup tool:failed / toolbus:exec
            : [{ type: "TOOL_SUCCEEDED", provenance: "OBSERVATION",
                 subject: payload?.name ?? payload?.tool ?? null,
                 payload: { tool: payload?.name ?? payload?.tool } }],
    "tool:failed": () => [
        { type: "TOOL_FAILED", provenance: "OBSERVATION", subject: null,
          payload: {} }
    ],
    "toolbus:exec": ({ payload }) => [payload?.ok
        ? { type: "TOOL_SUCCEEDED", provenance: "OBSERVATION",
            subject: payload?.tool ?? null, payload: { tool: payload?.tool, ms: payload?.ms } }
        : { type: "TOOL_FAILED", provenance: "OBSERVATION",
            subject: payload?.tool ?? null, payload: { tool: payload?.tool } }],
    "ai:fallback": () => [
        { type: "PROVIDER_DEGRADED", provenance: "SYSTEM_EVENT",
          payload: { surprise: 0.5 } }
    ]
};

function mapTelemetryEvent(event) {

    const fn = MAPPING[event?.type];
    if (!fn) return [];

    const produced = fn(event) ?? [];

    return produced
        .filter(Boolean)
        .map(spec => makeEnvelope({
            type: spec.type,
            source: "foundation.adapter",
            provenance: spec.provenance,
            subject: spec.subject ?? null,
            payload: spec.payload ?? {},
            confidence: 1
        }));

}

/**
 * Pasang langganan sekali. Mengembalikan detach(). ACC off → tidak
 * dipasang sama sekali (§109: nol jejak).
 */
function attach(telemetryService, onEnvelopes) {

    if (!telemetryService?.on) return () => {};

    const handler = (event) => {
        try {
            for (const envelope of mapTelemetryEvent(event)) {
                onEnvelopes(envelope);
            }
        }
        catch { /* adapter tidak boleh menjatuhkan runtime */ }
    };

    telemetryService.on("event", handler);

    return () => telemetryService.off?.("event", handler);

}

module.exports = { attach, mapTelemetryEvent };
