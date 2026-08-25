const path = require("node:path");
const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");

/**
 * usageService — catat pemakaian AI per-provider per-hari: jumlah request,
 * token (bila diketahui), error, dan status "limit habis hari ini".
 *
 * Dipakai untuk: graf pemakaian harian di Console, pra-alert saat mendekati
 * limit provider gratis, dan penanda agar Aether beralih dari provider yang
 * kuota hariannya habis. Disimpan lokal (gitignored).
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "usage.json"),
    { days: {} }
);

const WARN_AT = 40;      // pra-alert perkiraan untuk provider cloud (per hari)
const KEEP_DAYS = 60;

const dayKey = () => new Date().toISOString().slice(0, 10);

function bucket(data, provider) {
    const days = data.days || (data.days = {});
    const d = days[dayKey()] || (days[dayKey()] = { providers: {} });
    return d.providers[provider] || (d.providers[provider] = {
        requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, limited: false, warned: false
    });
}

function prune(data) {
    const keys = Object.keys(data.days || {}).sort();
    while (keys.length > KEEP_DAYS) delete data.days[keys.shift()];
}

function alert(text) {
    try { require("./notifyService").send(text); } catch { /* opsional */ }
}

function record(provider, { promptTokens = 0, completionTokens = 0 } = {}) {
    const name = provider || "unknown";
    const data = store.read();
    const p = bucket(data, name);
    p.requests += 1;
    p.promptTokens += Number(promptTokens) || 0;
    p.completionTokens += Number(completionTokens) || 0;

    if (name !== "lokal" && !p.warned && p.requests >= WARN_AT && !p.limited) {
        p.warned = true;
        alert(`⚠️ Pemakaian "${name}" hari ini sudah ${p.requests} request — mendekati limit harian model gratis. Siapkan provider cadangan.`);
    }

    prune(data);
    store.write(data);
}

function recordError(provider) {
    const data = store.read();
    bucket(data, provider || "unknown").errors += 1;
    store.write(data);
}

/** Tandai provider limit-habis hari ini. Return true bila baru berubah. */
function markLimited(provider) {
    const name = provider || "unknown";
    const data = store.read();
    const p = bucket(data, name);
    const was = p.limited;
    p.limited = true;
    p.errors += 1;
    store.write(data);
    if (!was) {
        telemetry.warn(`[usage] provider ${name} limit harian habis.`);
        alert(`⛔ Limit harian provider "${name}" habis. Aether beralih ke provider lain. Lihat pemakaian di Console → Models.`);
    }
    return !was;
}

function isLimited(provider) {
    return store.read().days?.[dayKey()]?.providers?.[provider]?.limited === true;
}

function today() {
    return store.read().days?.[dayKey()]?.providers || {};
}

/** Deret n hari terakhir untuk graf: [{date, providers, totalTokens, totalRequests}]. */
function history(n = 14) {
    const days = store.read().days || {};
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const providers = days[key]?.providers || {};
        let totalTokens = 0, totalRequests = 0;
        for (const p of Object.values(providers)) {
            totalTokens += (p.promptTokens || 0) + (p.completionTokens || 0);
            totalRequests += p.requests || 0;
        }
        out.push({ date: key, providers, totalTokens, totalRequests });
    }
    return out;
}

module.exports = { record, recordError, markLimited, isLimited, today, history, WARN_AT };
