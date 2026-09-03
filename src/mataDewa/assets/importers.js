/**
 * Impor data spasial lokal/generik: KML, KMZ, CSV, GeoJSON → SpatialAsset.
 *
 * HUKUM:
 *  - Hanya impor lokal/berotorisasi pengguna. Tidak ada pengambilan URL My
 *    Maps jarak jauh yang di-hard-code; sumber pribadi tetap di mesin pengguna
 *    (jalur di-ignore: private-data/, *.private.kml|kmz|csv|geojson).
 *  - Validasi keras: koordinat, geometri, id duplikat, bounds, metadata,
 *    provenance sumber.
 *  - Fixture di repo memakai data SINTETIS saja.
 */

const { isValidPoint } = require("../spatial/geo");
const { normalizeAsset } = require("./assetRegistry");

const SUPPORTED = Object.freeze(["kml", "kmz", "csv", "geojson"]);

/** Parse koordinat lintang/bujur dari string dengan toleransi format lokal. */
function parseCoord(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value !== "string") return NaN;
    const trimmed = value.trim().replace(/^["']|["']$/g, "");
    if (!trimmed) return NaN;
    const normalized = trimmed.replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : NaN;
}

/** CSV sederhana dengan header lat/lon (nama fleksibel) + kolom metadata lain. */
function parseCsv(text) {
    const rows = [];
    const lines = String(text ?? "").split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return rows;
    const split = (line) => {
        // Dukung kutip sederhana (tanpa kutip di dalam kutip).
        const out = [];
        let cur = "";
        let inQuote = false;
        for (const ch of line) {
            if (ch === '"') inQuote = !inQuote;
            else if (ch === "," && !inQuote) { out.push(cur); cur = ""; }
            else cur += ch;
        }
        out.push(cur);
        return out.map(s => s.trim());
    };
    const headers = split(lines[0]).map(h => h.toLowerCase());
    const latIdx = headers.findIndex(h => ["lat", "latitude", "y"].includes(h));
    const lonIdx = headers.findIndex(h => ["lon", "lng", "long", "longitude", "x"].includes(h));
    if (latIdx === -1 || lonIdx === -1) return rows;
    for (const line of lines.slice(1)) {
        const cells = split(line);
        const lat = parseCoord(cells[latIdx]);
        const lon = parseCoord(cells[lonIdx]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const metadata = {};
        headers.forEach((h, i) => {
            if (i !== latIdx && i !== lonIdx && cells[i] !== undefined && cells[i] !== "") {
                metadata[h] = cells[i];
            }
        });
        rows.push({
            id: metadata.id ?? undefined,
            type: metadata.type ?? undefined,
            location: { lat, lon },
            metadata
        });
    }
    return rows;
}

/** KML → placemarks (Document/Placemark/Point/coordinates). */
function parseKml(text) {
    const placemarks = [];
    const pmRegex = /<Placemark[\s\S]*?<\/Placemark>/gi;
    const coordRegex = /<coordinates>([\s\S]*?)<\/coordinates>/i;
    const nameRegex = /<name>([\s\S]*?)<\/name>/i;
    const descRegex = /<description>([\s\S]*?)<\/description>/i;

    for (const match of String(text ?? "").matchAll(pmRegex)) {
        const block = match[0];
        const coordMatch = coordRegex.exec(block);
        if (!coordMatch) continue;
        // Ambil koordinat pertama (poligon → centroid kasar diabaikan untuk
        // v1: gunakan titik pertama sebagai representasi).
        const first = coordMatch[1].trim().split(/\s+/)[0];
        const [lonStr, latStr] = first.split(",");
        const lat = parseCoord(latStr);
        const lon = parseCoord(lonStr);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const name = nameRegex.exec(block)?.[1]?.trim();
        const description = descRegex.exec(block)?.[1]?.replace(/<[^>]+>/g, "").trim();
        const metadata = {};
        if (name) metadata.name = name;
        if (description) metadata.description = description;
        placemarks.push({ location: { lat, lon }, metadata, type: metadata.name ? undefined : undefined });
    }
    return placemarks;
}

/** KMZ = zip berisi KML. Butuh zip entries — dukung via bytes + inflasi tanpa dependensi eksternal tidak realistis; v1 menerima KML diekstrak atau KMZ dengan entry pertama KML via parser zip minimal (stored only). */
function parseKmz(buffer) {
    // Pencarian KML di dalam KMZ: cari marker XML dalam bytes (many KMZ use deflate).
    const text = Buffer.from(buffer).toString("latin1");
    const start = text.indexOf("<?xml");
    if (start === -1) {
        throw new Error("KMZ tidak berisi KML yang dapat dikenali (entry deflate tidak didukung — ekstrak ke KML lalu impor)");
    }
    const end = text.indexOf("</kml>", start);
    if (end === -1) throw new Error("KML dalam KMZ tidak lengkap");
    return parseKml(Buffer.from(text.slice(start, end + 6), "latin1").toString("utf8"));
}

/** GeoJSON → features. */
function parseGeoJson(input) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    const features = data?.type === "FeatureCollection"
        ? (data.features ?? [])
        : data?.type === "Feature" ? [data] : [];
    const out = [];
    for (const feature of features) {
        const geom = feature?.geometry;
        let location = null;
        if (geom?.type === "Point" && Array.isArray(geom.coordinates)) {
            location = { lat: parseCoord(geom.coordinates[1]), lon: parseCoord(geom.coordinates[0]) };
        } else if (geom?.type === "Polygon" && Array.isArray(geom.coordinates?.[0]?.[0])) {
            const c = geom.coordinates[0][0];
            location = { lat: parseCoord(c[1]), lon: parseCoord(c[0]) };
        }
        if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) continue;
        const props = feature?.properties ?? {};
        out.push({
            id: props.id ?? undefined,
            type: props.type ?? undefined,
            location,
            metadata: { ...props }
        });
    }
    return out;
}

/**
 * Impor aset dari teks/bytes ke registry.
 * @param {AssetRegistry} registry
 * @param {{ format:"kml"|"kmz"|"csv"|"geojson", data:string|Buffer, source?:string, accessClass?:string }} input
 * @returns {{ imported: object[], rejected: {index:number, reason:string}[], duplicates:number }}
 */
function importAssets(registry, input) {
    const format = String(input?.format ?? "").toLowerCase();
    if (!SUPPORTED.includes(format)) {
        throw new Error(`format tidak didukung: ${format} (didukung: ${SUPPORTED.join(", ")})`);
    }

    let raw = [];
    if (format === "csv") raw = parseCsv(String(input.data));
    else if (format === "kml") raw = parseKml(String(input.data));
    else if (format === "kmz") raw = parseKmz(input.data);
    else raw = parseGeoJson(input.data);

    const imported = [];
    const rejected = [];
    let duplicates = 0;
    const seen = new Set();

    raw.forEach((item, index) => {
        if (!isValidPoint(item.location)) {
            rejected.push({ index, reason: "koordinat tidak valid" });
            return;
        }
        // Bounds kasar dunia sudah dicek isValidPoint; cek duplikat id.
        const idCandidate = item.id;
        if (idCandidate && (seen.has(idCandidate) || registry.get(idCandidate))) {
            duplicates += 1;
            rejected.push({ index, reason: `id duplikat: ${idCandidate}` });
            return;
        }
        if (idCandidate) seen.add(idCandidate);
        const result = registry.upsert({
            ...item,
            accessClass: input.accessClass ?? "AUTHORIZED_USER",
            source: input.source ?? `local_import:${format}`
        });
        if (result.ok) imported.push(result.asset);
        else rejected.push({ index, reason: result.reason });
    });

    return { imported, rejected, duplicates };
}

module.exports = {
    SUPPORTED,
    parseCsv,
    parseKml,
    parseKmz,
    parseGeoJson,
    parseCoord,
    importAssets
};
