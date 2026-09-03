/**
 * Provider CelesTrak orbital elements (TLE) — keyless, publik.
 *
 * Sumber: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * Diverifikasi live (HTTP 200) saat adopsi. Tanpa kunci. Mata Dewa menyimpan
 * TLE mentah sebagai atribut; propagasi SGP4 ke posisi dilakukan di sisi
 * renderer (satellite.js) atau saat dibutuhkan, bukan di sini, agar inti
 * headless tetap ringan.
 */

const { fetchText } = require("./http");
const { PROVIDER_ACCESS_MODE } = require("../config");
const { ACCESS_CLASS } = require("../spatial/accessClass");
const { OBSERVATION_TYPE } = require("../observations/observation");

const BASE_URL = "https://celestrak.org/NORAD/elements/gp.php";
const DEFAULT_GROUP = "stations";

/** Parse TLE 3-baris menjadi observasi (epoch diambil dari line1 kolom epoch). */
function parseTleEpoch(line1) {
    // Kolom 19-32 (1-based): YYDDD.DDDDDDDD
    const match = /^\d \d{5}\S \d{6}\S{2} (\d{2})(\d{3}\.\d{8})/.exec(line1 ?? "");
    if (!match) return null;
    const year = 2000 + Number(match[1]); // cukup untuk TLE modern (>=2000)
    const dayOfYear = Number(match[2]);
    if (!Number.isFinite(dayOfYear)) return null;
    return Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86400000;
}

function toObservation(name, line1, line2) {
    const epochMs = parseTleEpoch(line1);
    const noradMatch = /^\d (\d{5})/.exec(line2 ?? line1 ?? "");
    const noradId = noradMatch ? noradMatch[1] : null;
    if (!epochMs) return null;
    return {
        id: noradId ? `tle_${noradId}` : undefined,
        type: OBSERVATION_TYPE.SATELLITE,
        // Posisi BUMI tidak tersedia tanpa propagasi — gunakan epoch TLE sebagai
        // jejak orbital; renderer mempropagasi. Tandai geometry sebagai orbit.
        geometry: { type: "orbit", tle: { line1, line2 } },
        observedAt: epochMs,
        confidence: 0.9,
        quality: 0.85,
        accessClass: ACCESS_CLASS.PUBLIC,
        attributes: {
            name: name ?? null,
            noradId,
            tle: { line1, line2 }
        },
        attribution: "CelesTrak (Dr. T.S. Kelso)",
        license: "public (CelesTrak terms of use)"
    };
}

function parseTleCatalog(text) {
    const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i].replace(/^0 /, "");
        const line1 = lines[i + 1];
        const line2 = lines[i + 2];
        if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) continue;
        const obs = toObservation(name, line1, line2);
        if (obs) out.push(obs);
    }
    return out;
}

function createCelestrakProvider({ group = DEFAULT_GROUP } = {}) {
    return {
        id: "celestrak-tle",
        label: "CelesTrak Orbital Elements",
        types: [OBSERVATION_TYPE.SATELLITE],
        accessMode: PROVIDER_ACCESS_MODE.PUBLIC_NO_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        coverage: { kind: "global" },
        freshnessMs: 2 * 60 * 60 * 1000,
        quality: 0.85,
        attribution: "CelesTrak (Dr. T.S. Kelso)",
        license: "public (CelesTrak terms of use)",
        fallbacks: [],
        async poll() {
            const url = `${BASE_URL}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
            const text = await fetchText(url);
            return parseTleCatalog(text);
        }
    };
}

module.exports = { createCelestrakProvider, parseTleCatalog, parseTleEpoch, BASE_URL };
