const path = require("node:path");

const JsonStore = require("../../core/config/JsonStore");
const telemetry = require("../../services/telemetryService");

/**
 * TOOL STATS — ingatan operasional ringan atas eksekusi tool.
 *
 * BUKAN memori percakapan: hanya agregat bergulir per tool —
 * sukses/gagal, latensi rata-rata bergerak, kategori error terakhir.
 * Dipakai ranker secara KONSERVATIF (bobot kecil, baru berlaku setelah
 * cukup sampel) supaya satu kegagalan tidak membuat agent menghindari
 * tool yang sehat.
 *
 * Persisten via JsonStore (atomic rename), ditulis JARANG (debounce)
 * agar jalur eksekusi tidak membayar I/O per panggilan.
 */

const MAX_TOOLS = 500;
const PRUNE_DAYS = 30;
const FLUSH_MS = 30_000;
const MAX_LATENCY_SAMPLES = 20;

class ToolStats {

    constructor({ filePath = null } = {}) {

        this.store = new JsonStore(
            filePath ?? path.join(process.cwd(), "data", "tool-stats.json"),
            { tools: {} }
        );

        this.dirty = false;

        this.pending = null;

        this.timer = null;

    }

    _all() {
        return this.store.read().tools ?? {};
    }

    /** Rekam satu eksekusi. Kategori error dipisah dari pesan mentahnya. */
    record(name, ok, ms = 0, errorCategory = null) {

        const all = this._all();

        const m = all[name] ?? {
            ok: 0, fail: 0, totalMs: 0,
            samples: [], lastErrorCategory: null, updatedAt: null
        };

        if (ok) m.ok += 1; else m.fail += 1;

        m.totalMs += Math.max(0, Number(ms) || 0);

        // Sampel latensi bergulir — avg tidak dibuat bias oleh riwayat lama.
        m.samples = [...(m.samples ?? []), Math.max(0, Number(ms) || 0)]
            .slice(-MAX_LATENCY_SAMPLES);

        // OUTCOME bergulir (H5): keandalan dihitung dari N eksekusi
        // TERAKHIR, bukan akumulasi seumur hidup — outage provider atau
        // streak gagal tidak menghukum tool selamanya.

        if (!ok && errorCategory) m.lastErrorCategory = errorCategory;

        // Outcome ringkas untuk reliability bergulir.
        m.outcomes = [...(m.outcomes ?? []), ok ? 1 : 0].slice(-MAX_LATENCY_SAMPLES);

        m.updatedAt = new Date().toISOString();

        all[name] = m;

        this._prune(all);

        // Tulis dibatasi: jalur eksekusi tidak boleh membayar I/O
        // JSON per panggilan tool. Keadaan terbaru tetap terbaca dari
        // cache store; berkas menyusul paling lambat FLUSH_MS.
        this.pending = all;

        if (!this.timer) {

            this.timer = setTimeout(() => this.flush(), FLUSH_MS);

            this.timer.unref?.();

        }

    }

    /** Paksa tulis ke disk (dipakai test & shutdown). */
    flush() {

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (!this.pending) return;

        try {
            this.store.write({ tools: this.pending });
            this.pending = null;
        }
        catch (error) {
            telemetry.warn(`[tool-stats] gagal menulis: ${error.message}`);
        }

    }

    /** Buang tool yang lama tak terlihat dan batasi jumlah entri. */
    _prune(all) {

        const keys = Object.keys(all);

        if (keys.length <= MAX_TOOLS) return;

        const cutoff = Date.now() - PRUNE_DAYS * 86_400_000;

        for (const key of keys) {

            if (keys.length <= MAX_TOOLS) break;

            const updated = Date.parse(all[key]?.updatedAt ?? "") ?? 0;

            if (updated < cutoff) delete all[key];

        }

    }

    /**
     * Keandalan 0..1 dari outcome N TERAKHIR (rolling), atau null bila
     * sampel belum cukup. Lifetime counters tetap tersimpan untuk
     * audit, tapi TIDAK lagi menentukan ranking.
     */
    reliability(name, minSamples = 5) {

        const m = this._all()[name];

        if (!m) return null;

        const outcomes = m.outcomes ?? [];

        if (outcomes.length < minSamples) return null;

        return outcomes.reduce((a, b) => a + b, 0) / outcomes.length;

    }

    /** Latensi rata-rata bergerak (ms) atau null. */
    avgMs(name) {

        const m = this._all()[name];

        const samples = m?.samples ?? [];

        if (!samples.length) return null;

        return samples.reduce((a, b) => a + b, 0) / samples.length;

    }

    lastErrorCategory(name) {
        return this._all()[name]?.lastErrorCategory ?? null;
    }

    snapshot() {

        return Object.entries(this._all()).map(([name, m]) => {

            const total = m.ok + m.fail;

            return {
                name,
                calls: total,
                ok: m.ok,
                fail: m.fail,
                reliability: total ? +(m.ok / total).toFixed(3) : null,
                avgMs: m.samples?.length
                    ? Math.round(m.samples.reduce((a, b) => a + b, 0) / m.samples.length)
                    : null,
                lastErrorCategory: m.lastErrorCategory ?? null,
                updatedAt: m.updatedAt
            };

        });

    }

    reset() {
        this.store.write({ tools: {} });
    }

}

module.exports = new ToolStats();

