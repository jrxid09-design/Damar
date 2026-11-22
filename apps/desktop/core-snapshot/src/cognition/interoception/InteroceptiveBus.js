const { makeEnvelope } = require("../core/envelope");

/**
 * INTEROCEPTION (§23–§25) — kondisi operasional internal Damar.
 *
 * Setiap sampel WAJIB membedakan VALUE / STALE / UNKNOWN / ERROR
 * (§24/§80): sensor mati ≠ sehat.
 *
 * Adapter dapat disuntik; adapter robotik (baterai/motor/IMU) tinggal
 * ditambahkan nanti tanpa mengubah bus.
 */

class InteroceptiveBus {

    constructor({ config, clock }) {
        this.config = config;
        this.clock = clock;
        this.adapters = new Map();      // name → fn(ctx) → sample|sample[]
        this.lastSamples = new Map();   // metric → {at, record}
    }

    registerAdapter(name, providerFn) {
        if (typeof providerFn !== "function") {
            throw new Error("ACC: adapter interosepsi wajib fungsi");
        }
        this.adapters.set(String(name).slice(0, 60), providerFn);
        return this;
    }

    /**
     * Tarik semua adapter → envelope INTEROCEPTIVE_SAMPLE (SYSTEM_SENSOR)
     * + derivasi RESOURCE_PRESSURE bila ambang terlampaui (§25).
     */
    collect() {

        const nowMs = this.clock.nowMs();
        const envelopes = [];

        const ctx = { clock: this.clock };

        for (const [name, fn] of this.adapters) {

            let samples;
            try {
                samples = fn(ctx);
            }
            catch (error) {
                // Kegagalan adapter = data, bukan dianggap sehat (§24).
                samples = [{
                    metric: `adapter.${name}`,
                    state: "ERROR",
                    error: String(error?.message ?? error).slice(0, 120)
                }];
            }

            for (const raw of Array.isArray(samples) ? samples : [samples]) {
                const record = this.normalize(raw, name, nowMs);
                if (!record) continue;

                this.lastSamples.set(record.metric, { at: nowMs, record });
                envelopes.push(makeEnvelope({
                    type: "INTEROCEPTIVE_SAMPLE",
                    source: "acc.interoception",
                    provenance: "SYSTEM_SENSOR",
                    payload: record,
                    clock: this.clock
                }));

                // Homeostasis → tekanan fungsional (§25).
                if (record.metric === "process.memFreeFrac" &&
                    record.state === "VALUE" &&
                    record.value < this.config.interoception.resourcePressureThresholds.memFreeFracLow) {
                    envelopes.push(makeEnvelope({
                        type: "RESOURCE_PRESSURE",
                        source: "acc.interoception",
                        provenance: "SYSTEM_SENSOR",
                        payload: { metric: record.metric, value: record.value,
                                   resourceImpact: 0.6 },
                        clock: this.clock
                    }));
                }
            }
        }

        return envelopes;

    }

    /** Normalisasi + deteksi STALE berdasarkan usia sampel terakhir. */
    normalize(raw, adapterName, nowMs) {

        if (!raw || typeof raw !== "object") return null;

        const metric = String(raw.metric ?? "").slice(0, 120);
        if (!metric) return null;

        const last = this.lastSamples.get(metric);

        let state = raw.state;
        if (!["VALUE", "STALE", "UNKNOWN", "ERROR"].includes(state)) {
            state = Number.isFinite(raw.value) ? "VALUE" : "UNKNOWN";
        }

        // Sampel yang sama persis & sudah lama → STALE (§24):
        // jangan konversi "tidak ada data baru" menjadi "sehat".
        if (state === "VALUE" && last &&
            nowMs - last.at > this.config.interoception.staleAfterMs &&
            JSON.stringify(last.record.value ?? null) === JSON.stringify(raw.value ?? null)) {
            state = "STALE";
        }

        return {
            metric,
            value: Number.isFinite(raw.value) ? raw.value : null,
            unit: raw.unit ?? null,
            state,
            source: `adapter.${adapterName}`,
            freshnessMs: last ? nowMs - last.at : 0
        };

    }

}

/** Adapter proses bawaan — best-effort lintas platform (§23). */
function defaultProcessAdapters() {
    const os = require("node:os");
    return [
        ["process", () => {
            const total = os.totalmem() || 0;
            const free = os.freemem() || 0;
            const load = (os.loadavg?.() ?? [null])[0];
            const out = [];
            if (total > 0) {
                out.push({ metric: "process.memFreeFrac",
                           value: free / total, unit: "fraction" });
            } else {
                out.push({ metric: "process.memFreeFrac", state: "UNKNOWN" });
            }
            out.push(Number.isFinite(load)
                ? { metric: "process.loadAvg1", value: load, unit: "load" }
                : { metric: "process.loadAvg1", state: "UNKNOWN" });
            return out;
        }]
    ];
}

module.exports = { InteroceptiveBus, defaultProcessAdapters };
