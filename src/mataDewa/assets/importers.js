"use strict";

/**
 * Impor data spasial lokal/generik: KML, KMZ, CSV, GeoJSON → SpatialAsset.
 *
 * MD-003 HARDENING — batas terpusat (importLimits.js), tolak jangan potong:
 *  - SEMUA parser bounded (file, fitur, field, kedalaman, elemen, waktu).
 *  - KML: parser XML bounded khusus — DOCTYPE/ENTITY ditolak KERAS
 *    (anti XXE), hanya lima entitas XML pradefinisi yang diurai; tidak
 *    ada regex terhadap file hostil; kedalaman & jumlah elemen dibatasi.
 *  - KMZ: pembaca ZIP sungguhan (jszip, MIT, murni JS — sudah ada di
 *    pohon dependensi) dengan batas entry/bytes/rasio, penolakan path
 *    absolut, "..", pemisah dinormalisasi, duplikat path, dan hanya
 *    entry .kml yang diterima. TIDAK ADA ekstraksi ke filesystem.
 *  - CSV: parser bounded (kutip ganda, koma/baris baru tertanam),
 *    batas baris/kolom/sel; sel raksasa → tolak.
 *  - GeoJSON: tipe terdukung eksplisit (Point/LineString/Polygon),
 *    MULTI* ditolak jujur bila tidak didukung; koordinat finite, rentang
 *    valid, jumlah vertex/ring dibatasi; cincin poligon wajib tertutup;
 *    prototype-dangerous ditolak.
 *  - Tidak ada eksekusi getter saat kanonikalisasi data hostil (baca
 *    via Object.getOwnPropertyDescriptor, mirror pola payload bus).
 */

const { isValidPoint } = require("../spatial/geo");
const { normalizeAsset } = require("./assetRegistry");
const { resolveImportLimits } = require("./importLimits");

const SUPPORTED = Object.freeze(["kml", "kmz", "csv", "geojson"]);
const DEFAULT_LIMITS = resolveImportLimits();

// ---- util aman -----------------------------------------------------------

const OWN = Object.prototype.hasOwnProperty;

/** Baca properti data-only (tanpa getter) — anti side-effect hostil. */
function readOwn(value, key) {
    if (!OWN.call(value, key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
        throw new Error(`akses '${key}' memakai getter — data hostil ditolak`);
    }
    return descriptor.value;
}

function protoUnsafe(value) {
    // Object literal/null saja; turunan kelas (dan getter-nya) ditolak.
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto !== Object.prototype && proto !== null;
}

function byteLengthOf(str) {
    return Buffer.byteLength(String(str), "utf8");
}

/** Kelas batas terlampaui → Error dengan penanda konsisten. */
function limitError(reason) {
    return new Error(`IMPORT_LIMIT_EXCEEDED: ${reason}`);
}

// ---- CSV -----------------------------------------------------------------

/**
 * CSV bounded: kutip ganda + koma/baris baru tertanam. Mengembalikan
 * array baris (array sel). Melampaui batas → limitError.
 */
function parseCsvRows(text, limits) {
    const s = String(text ?? "");
    if (byteLengthOf(s) > limits.MAX_FILE_BYTES) {
        throw limitError(`ukuran CSV > ${limits.MAX_FILE_BYTES} bytes`);
    }
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;
    let columnCount = 0;

    const pushCell = () => {
        if (Buffer.byteLength(cell, "utf8") > limits.MAX_CSV_CELL_BYTES) {
            throw limitError(`sel CSV > ${limits.MAX_CSV_CELL_BYTES} bytes`);
        }
        row.push(cell);
        cell = "";
    };
    const pushRow = () => {
        pushCell();
        columnCount = Math.max(columnCount, row.length);
        if (row.length > limits.MAX_CSV_COLUMNS) {
            throw limitError(`kolom CSV > ${limits.MAX_CSV_COLUMNS}`);
        }
        if (row.some(c => c.trim().length > 0)) rows.push(row);
        row = [];
        if (rows.length > limits.MAX_CSV_ROWS) {
            throw limitError(`baris CSV > ${limits.MAX_CSV_ROWS}`);
        }
    };

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inQuotes) {
            if (ch === '"') {
                if (s[i + 1] === '"') { cell += '"'; i++; }
                else inQuotes = false;
            }
            else cell += ch;
        }
        else if (ch === '"') inQuotes = true;
        else if (ch === ",") pushCell();
        else if (ch === "\n") pushRow();
        else if (ch === "\r") { /* CRLF: \n menutup baris */ }
        else cell += ch;
    }
    if (cell.length > 0 || row.length > 0) pushRow();
    void columnCount;
    return rows;
}

/** Parse koordinat lintang/bujur dari string dengan toleransi format lokal. */
function parseCoord(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value !== "string") return NaN;
    const trimmed = value.trim().replace(/^["']|["']$/g, "");
    if (!trimmed || trimmed === "NaN" || trimmed === "Infinity" || trimmed === "-Infinity") return NaN;
    const normalized = trimmed.replace(",", ".");
    if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(normalized)) return NaN;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : NaN;
}

/** CSV → kandidat aset (bounded). */
function parseCsv(text, limitsOverride) {
    const limits = limitsOverride ?? DEFAULT_LIMITS;
    const rows = parseCsvRows(text, limits);
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const latIdx = headers.findIndex(h => ["lat", "latitude", "y"].includes(h));
    const lonIdx = headers.findIndex(h => ["lon", "lng", "long", "longitude", "x"].includes(h));
    if (latIdx === -1 || lonIdx === -1) return [];

    const out = [];
    for (const cells of rows.slice(1)) {
        const lat = parseCoord(cells[latIdx]);
        const lon = parseCoord(cells[lonIdx]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const metadata = {};
        let metadataBytes = 0;
        for (let i = 0; i < Math.min(headers.length, cells.length); i++) {
            if (i === latIdx || i === lonIdx) continue;
            const key = headers[i];
            const value = cells[i];
            if (!key || value === undefined || value === "") continue;
            if (byteLengthOf(key) > limits.MAX_FIELD_BYTES ||
                byteLengthOf(value) > limits.MAX_FIELD_BYTES) {
                throw limitError(`field CSV > ${limits.MAX_FIELD_BYTES} bytes`);
            }
            if (Object.keys(metadata).length >= limits.MAX_METADATA_KEYS) break;
            metadataBytes += byteLengthOf(key) + byteLengthOf(value);
            if (metadataBytes > limits.MAX_METADATA_BYTES) {
                throw limitError(`metadata CSV > ${limits.MAX_METADATA_BYTES} bytes`);
            }
            metadata[key] = value;
        }
        out.push({
            id: metadata.id ?? undefined,
            type: metadata.type ?? undefined,
            location: { lat, lon },
            metadata
        });
    }
    return out;
}

// ---- XML / KML (parser bounded, anti-XXE) --------------------------------

const XML_PREDEFINED_ENTITIES = Object.freeze({
    "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'"
});

function decodeXmlText(text) {
    let out = text;
    for (const [entity, replacement] of Object.entries(XML_PREDEFINED_ENTITIES)) {
        out = out.replaceAll(entity, replacement);
    }
    // Sisa referensi entitas apa pun (&#..; atau &nama;) = TIDak didukung.
    if (/&[#A-Za-z0-9]+;/.test(out)) {
        throw new Error("referensi entitas XML tak dikenal — data hostil ditolak");
    }
    return out;
}

/**
 * Scanner XML bounded untuk subset KML yang kita terima:
 * Document/Folder/Placemark/name/description/Point/coordinates/
 * LineString/Polygon/outerBoundaryIs/innerBoundaryIs/LinearRing.
 * DOCTYPE, ENTITY, PROCESSING-INSTRUCTION aneh, dan komentar besar
 * ditangani: DOCTYPE/ENTITY → TOLAK KERAS (XXE); komentar dilewati
 * dengan batas ukuran total.
 */
function parseXmlElements(text, limits) {
    const totalBytes = byteLengthOf(text);
    if (totalBytes > limits.MAX_FILE_BYTES) {
        throw limitError(`ukuran XML > ${limits.MAX_FILE_BYTES} bytes`);
    }

    // XXE guard: DOCTYPE / ENTITY ditolak sebelum parsing apa pun.
    if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
        throw new Error("DOCTYPE/ENTITY XML ditolak (anti XXE)");
    }

    const elements = [];   // { name, attrs, text, depth, children[] }
    const stack = [];
    let elementCount = 0;
    let i = 0;

    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt === -1) break;
        // Teks sebelum tag.
        if (lt > i && stack.length > 0) {
            const rawText = text.slice(i, lt);
            if (byteLengthOf(rawText) > limits.MAX_STRING_BYTES) {
                throw limitError(`teks XML > ${limits.MAX_STRING_BYTES} bytes`);
            }
            const current = stack[stack.length - 1];
            current.textChunks.push(decodeXmlText(rawText));
        }
        i = lt;
        if (text.startsWith("<!--", i)) {
            const end = text.indexOf("-->", i);
            if (end === -1) throw new Error("komentar XML tidak ditutup");
            i = end + 3;
            continue;
        }
        if (text.startsWith("<?", i)) {
            const end = text.indexOf("?>", i);
            if (end === -1) throw new Error("processing instruction tidak ditutup");
            i = end + 2;
            continue;
        }
        if (text.startsWith("</", i)) {
            const end = text.indexOf(">", i);
            if (end === -1) throw new Error("tag penutup rusak");
            const name = text.slice(i + 2, end).trim();
            const opened = stack.pop();
            if (!opened || opened.name !== name) {
                throw new Error(`struktur XML tidak seimbang (</${name}>)`);
            }
            opened.text = opened.textChunks.join("").trim();
            i = end + 1;
            continue;
        }
        // Tag pembuka (dengan atribut sederhana name="value").
        const gt = text.indexOf(">", i);
        if (gt === -1) throw new Error("tag pembuka tidak ditutup");
        const isSelfClosing = text[gt - 1] === "/";
        const tagBody = text.slice(i + 1, isSelfClosing ? gt - 1 : gt);
        const nameMatch = tagBody.match(/^([A-Za-z_][\w.:-]*)/);
        if (!nameMatch) { i = gt + 1; continue; }   // bukan elemen bernama → lewati

        elementCount++;
        if (elementCount > limits.MAX_XML_ELEMENTS) {
            throw limitError(`elemen XML > ${limits.MAX_XML_ELEMENTS}`);
        }
        const depth = stack.length + 1;
        if (depth > limits.MAX_XML_DEPTH) {
            throw limitError(`kedalaman XML > ${limits.MAX_XML_DEPTH}`);
        }
        const element = {
            name: nameMatch[1],
            attrs: {},
            textChunks: [],
            text: "",
            depth,
            children: []
        };
        // Atribut sederhana — bounded.
        const attrRegex = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
        let attrMatch;
        let attrCount = 0;
        while ((attrMatch = attrRegex.exec(tagBody)) !== null) {
            attrCount++;
            if (attrCount > 16) throw limitError("atribut > 16 per elemen");
            element.attrs[attrMatch[1]] = decodeXmlText(attrMatch[2]);
        }

        if (stack.length > 0) stack[stack.length - 1].children.push(element);
        elements.push(element);
        if (!isSelfClosing) stack.push(element);
        i = gt + 1;
    }

    if (stack.length > 0) {
        throw new Error(`elemen XML tidak ditutup: ${stack[stack.length - 1].name}`);
    }
    return elements;
}

function findChildren(element, name) {
    return (element?.children ?? []).filter(c => c.name === name || c.name.endsWith(`:${name}`));
}

function findDescendants(element, name, results = [], depth = 0) {
    if (depth > 16) return results;
    for (const child of element?.children ?? []) {
        if (child.name === name || child.name.endsWith(`:${name}`)) results.push(child);
        findDescendants(child, name, results, depth + 1);
    }
    return results;
}

function boundedTextField(element, limits, label) {
    if (!element) return undefined;
    const value = decodeXmlText(element.text ?? "");
    if (byteLengthOf(value) > limits.MAX_FIELD_BYTES) {
        throw limitError(`${label} > ${limits.MAX_FIELD_BYTES} bytes`);
    }
    return value || undefined;
}

/** KML → placemarks (parser XML bounded; bukan regex). */
function parseKml(text, limitsOverride) {
    const limits = limitsOverride ?? DEFAULT_LIMITS;
    const all = parseXmlElements(String(text ?? ""), limits);
    // Hanya akar (depth 1) yang dipindai — elemen nested JANGAN dipindai
    // dua kali dari leluhur berbeda.
    const root = all.filter(el => el.depth === 1);
    const placemarkNodes = [];
    for (const top of root) findDescendants(top, "Placemark", placemarkNodes);
    if (placemarkNodes.length > limits.MAX_FEATURES) {
        throw limitError(`Placemark > ${limits.MAX_FEATURES}`);
    }

    const placemarks = [];
    for (const pm of placemarkNodes) {
        const nameEl = findChildren(pm, "name")[0];
        const descEl = findChildren(pm, "description")[0];
        const name = boundedTextField(nameEl, limits, "name KML");
        const description = boundedTextField(descEl, limits, "description KML");

        // Koordinat: Point (pertama) atau representasi pertama Polygon/
        // LineString — bounded jumlah koordinat.
        const coordNodes = findDescendants(pm, "coordinates");
        if (coordNodes.length === 0) continue;
        const coordText = boundedTextField(coordNodes[0], limits, "coordinates KML") ?? "";
        const tuples = coordText.trim().split(/\s+/);
        if (tuples.length > limits.MAX_GEOMETRY_COORDINATES) {
            throw limitError(`koordinat KML > ${limits.MAX_GEOMETRY_COORDINATES}`);
        }
        const first = tuples[0].split(",");
        const lat = parseCoord(first[1]);
        const lon = parseCoord(first[0]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const metadata = {};
        if (name) metadata.name = name;
        if (description) metadata.description = description;
        placemarks.push({ location: { lat, lon }, metadata });
    }
    return placemarks;
}

// ---- KMZ (pembaca ZIP sungguhan, bounded, tanpa ekstraksi disk) ----------

/**
 * Scan RAW central directory ZIP: nama file dibaca langsung dari bytes
 * arsip (sebelum jszip menormalisasi) supaya traversal/absolut/backslash/
 * duplikat tetap terdeteksi pada file hostil.
 */
function scanZipRawEntryNames(buffer) {
    const names = [];
    const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]); // PK\x01\x02
    let offset = 0;
    while (offset + 46 <= buffer.length) {
        const idx = buffer.indexOf(sig, offset);
        if (idx === -1 || idx + 46 > buffer.length) break;
        const nameLen = buffer.readUInt16LE(idx + 28);
        const extraLen = buffer.readUInt16LE(idx + 30);
        const commentLen = buffer.readUInt16LE(idx + 32);
        const name = buffer.slice(idx + 46, idx + 46 + nameLen).toString("utf8");
        names.push(name);
        offset = idx + 46 + nameLen + extraLen + commentLen;
    }
    if (names.length === 0) {
        throw new Error("KMZ bukan arsip ZIP yang sah (central directory tidak ditemukan)");
    }
    return names;
}

/** Normalisasi + validasi nama entry mentah (anti traversal/absolut/dup). */
function validateRawZipName(rawName, seenPaths) {
    const normalized = String(rawName).replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
        throw new Error(`path ZIP absolut ditolak: ${rawName}`);
    }
    const segments = normalized.split("/").filter(s => s !== "" && s !== ".");
    if (segments.some(s => s === "..")) {
        throw new Error(`path traversal ZIP ditolak: ${rawName}`);
    }
    const key = segments.join("/");
    if (!key) return null;
    if (seenPaths.has(key)) {
        throw new Error(`path ZIP duplikat ditolak: ${key}`);
    }
    seenPaths.add(key);
    return key;
}

/**
 * KMZ → KML text. Menggunakan jszip (MIT, murni JS, sudah transitive di
 * pohon dependensi; kini direct dependency yang tercatat). Semua batas
 * ZIP ditegakkan; TIDAK ADA penulisan ke filesystem.
 */
async function parseKmz(buffer, limitsOverride) {
    const limits = limitsOverride ?? DEFAULT_LIMITS;
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
    if (data.length > limits.MAX_ZIP_COMPRESSED_BYTES) {
        throw limitError(`ZIP terkompresi > ${limits.MAX_ZIP_COMPRESSED_BYTES} bytes`);
    }

    // Pertahanan lapis 1: nama MENTAH dari central directory.
    const rawNames = scanZipRawEntryNames(data);
    const seenRaw = new Set();
    for (const rawName of rawNames) validateRawZipName(rawName, seenRaw);

    const JSZip = require("jszip");
    let zip;
    try {
        zip = await JSZip.loadAsync(data, { checkCRC32: false });
    }
    catch {
        throw new Error("KMZ bukan arsip ZIP yang sah");
    }

    const entries = Object.values(zip.files).filter(f => !f.dir);
    if (entries.length > limits.MAX_ZIP_ENTRIES) {
        throw limitError(`entry ZIP > ${limits.MAX_ZIP_ENTRIES}`);
    }

    const seenPaths = new Set();
    let totalExpanded = 0;
    let totalCompressed = 0;
    const kmlEntries = [];

    for (const entry of entries) {
        // Normalisasi pemisah + tolak absolut & traversal.
        const normalized = String(entry.name).replace(/\\/g, "/");
        if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
            throw new Error(`path ZIP absolut ditolak: ${entry.name}`);
        }
        const segments = normalized.split("/").filter(s => s !== "" && s !== ".");
        if (segments.some(s => s === "..")) {
            throw new Error(`path traversal ZIP ditolak: ${entry.name}`);
        }
        const key = segments.join("/");
        if (!key) continue;
        if (seenPaths.has(key)) {
            throw new Error(`path ZIP duplikat ditolak: ${key}`);
        }
        seenPaths.add(key);

        const compressed = Number(entry._data?.compressedSize ?? 0);
        const uncompressed = Number(entry._data?.uncompressedSize ?? 0);
        totalCompressed += compressed;
        if (totalCompressed > limits.MAX_ZIP_COMPRESSED_BYTES) {
            throw limitError(`total terkompresi ZIP > ${limits.MAX_ZIP_COMPRESSED_BYTES}`);
        }
        if (uncompressed > limits.MAX_ZIP_ENTRY_BYTES) {
            throw limitError(`entry ZIP > ${limits.MAX_ZIP_ENTRY_BYTES}: ${key}`);
        }
        if (compressed > 0 && uncompressed / compressed > limits.MAX_ZIP_RATIO) {
            throw limitError(`rasio kompresi ZIP > ${limits.MAX_ZIP_RATIO}: ${key}`);
        }
        totalExpanded += uncompressed;
        if (totalExpanded > limits.MAX_ZIP_EXPANDED_BYTES) {
            throw limitError(`total terekspansi ZIP > ${limits.MAX_ZIP_EXPANDED_BYTES}`);
        }

        if (key.toLowerCase().endsWith(".kml")) {
            kmlEntries.push({ key, entry });
        }
    }

    if (kmlEntries.length === 0) {
        throw new Error("KMZ tidak memuat entry .kml");
    }
    // Utamakan doc.kml bila ada.
    kmlEntries.sort((a, b) => (a.key.toLowerCase().endsWith("doc.kml") ? -1 : 0) -
        (b.key.toLowerCase().endsWith("doc.kml") ? -1 : 0));
    const chosen = kmlEntries[0].entry;
    const text = await chosen.async("string");
    if (Buffer.byteLength(text, "utf8") > limits.MAX_FILE_BYTES) {
        throw limitError(`KML dalam KMZ > ${limits.MAX_FILE_BYTES} bytes`);
    }
    return text;
}

// ---- GeoJSON -------------------------------------------------------------

function validateFiniteCoordinate(value, what, limits) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`koordinat ${what} bukan angka finite`);
    }
    void limits;
    return value;
}

/** Validasi geometri terdukung; kembalikan titik representasi. */
function geoJsonLocation(geometry, limits) {
    if (!geometry || typeof geometry !== "object" || protoUnsafe(geometry)) {
        throw new Error("geometri tidak sah");
    }
    const type = readOwn(geometry, "type");
    const coordinates = readOwn(geometry, "coordinates");

    const depthCheck = (arr, depth) => {
        if (depth > limits.MAX_GEOMETRY_DEPTH) {
            throw limitError(`kedalaman geometri > ${limits.MAX_GEOMETRY_DEPTH}`);
        }
        if (!Array.isArray(arr)) return;
        if (arr.length > limits.MAX_GEOMETRY_COORDINATES) {
            throw limitError(`jumlah koordinat > ${limits.MAX_GEOMETRY_COORDINATES}`);
        }
        for (const item of arr) {
            if (Array.isArray(item)) depthCheck(item, depth + 1);
        }
    };

    if (type === "Point") {
        if (!Array.isArray(coordinates) || coordinates.length < 2) {
            throw new Error("Point butuh minimal 2 koordinat");
        }
        const lon = validateFiniteCoordinate(coordinates[0], "lon", limits);
        const lat = validateFiniteCoordinate(coordinates[1], "lat", limits);
        return { lat, lon };
    }
    if (type === "LineString") {
        depthCheck(coordinates, 1);
        if (!Array.isArray(coordinates) || coordinates.length < 2) {
            throw new Error("LineString butuh minimal 2 posisi");
        }
        const [lon, lat] = coordinates[0];
        return { lat: validateFiniteCoordinate(lat, "lat", limits), lon: validateFiniteCoordinate(lon, "lon", limits) };
    }
    if (type === "Polygon") {
        depthCheck(coordinates, 1);
        if (!Array.isArray(coordinates) || coordinates.length < 1) {
            throw new Error("Polygon butuh minimal 1 ring");
        }
        if (coordinates.length > 64) throw limitError("ring poligon > 64");
        for (const ring of coordinates) {
            if (!Array.isArray(ring) || ring.length < 4) {
                throw new Error("ring poligon butuh minimal 4 posisi (tertutup)");
            }
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                throw new Error("ring poligon tidak tertutup");
            }
        }
        const [lon, lat] = coordinates[0][0];
        return { lat: validateFiniteCoordinate(lat, "lat", limits), lon: validateFiniteCoordinate(lon, "lon", limits) };
    }
    if (typeof type === "string" && type.startsWith("Multi")) {
        throw new Error(`tipe geometri ${type} tidak didukung — ditolak jujur`);
    }
    throw new Error(`tipe geometri tidak didukung: ${String(type)}`);
}

function boundedProperties(props, limits) {
    if (props === undefined || props === null) return {};
    if (typeof props !== "object" || Array.isArray(props) || protoUnsafe(props)) {
        throw new Error("properties GeoJSON tidak sah");
    }
    const out = {};
    let totalBytes = 0;
    for (const key of Object.keys(props)) {
        if (!OWN.call(props, key)) continue;
        const value = readOwn(props, key);
        if (byteLengthOf(key) > limits.MAX_FIELD_BYTES) {
            throw limitError(`kunci properties > ${limits.MAX_FIELD_BYTES} bytes`);
        }
        const str = value === null || value === undefined ? "" : String(value);
        if (byteLengthOf(str) > limits.MAX_FIELD_BYTES) {
            throw limitError(`nilai properties > ${limits.MAX_FIELD_BYTES} bytes`);
        }
        if (Object.keys(out).length >= limits.MAX_METADATA_KEYS) break;
        totalBytes += byteLengthOf(key) + byteLengthOf(str);
        if (totalBytes > limits.MAX_METADATA_BYTES) {
            throw limitError(`metadata properties > ${limits.MAX_METADATA_BYTES} bytes`);
        }
        if (str !== "") out[key] = str;
    }
    return out;
}

/**
 * Ukur kedalaman JSON secara ITERATIF (tanpa rekursi — aman untuk
 * dokumen dalam) dan tolak di atas batas. Hanya menyentuh properti data
 * dari keluaran JSON.parse (tidak bisa memuat getter).
 */
function assertJsonDepth(root, limits) {
    const MAX = limits.MAX_JSON_DEPTH;
    // Setiap entri: [value, depth]. Antriannya dijaga bounded oleh batas
    // kedalaman itu sendiri; dokumen lebar dibatasi MAX_FILE_BYTES.
    const stack = [[root, 1]];
    while (stack.length > 0) {
        const [value, depth] = stack.pop();
        if (depth > MAX) throw limitError(`kedalaman JSON > ${MAX}`);
        if (Array.isArray(value)) {
            for (const item of value) stack.push([item, depth + 1]);
        }
        else if (value !== null && typeof value === "object") {
            for (const key of Object.keys(value)) {
                stack.push([value[key], depth + 1]);
            }
        }
    }
}

/** GeoJSON → kandidat aset (bounded; JSON parse dengan batas ukuran). */
function parseGeoJson(input, limitsOverride) {
    const limits = limitsOverride ?? DEFAULT_LIMITS;
    let data;
    if (typeof input === "string") {
        if (byteLengthOf(input) > limits.MAX_FILE_BYTES) {
            throw limitError(`ukuran GeoJSON > ${limits.MAX_FILE_BYTES} bytes`);
        }
        data = JSON.parse(input);
    }
    else data = input;
    if (protoUnsafe(data)) throw new Error("GeoJSON root tidak sah");
    if (data !== null && typeof data === "object") {
        assertJsonDepth(data, limits);
    }

    const type = data && typeof data === "object" ? readOwn(data, "type") : undefined;
    const features = type === "FeatureCollection"
        ? (readOwn(data, "features") ?? [])
        : type === "Feature" ? [data] : [];

    if (!Array.isArray(features)) throw new Error("features GeoJSON tidak sah");
    if (features.length > limits.MAX_FEATURES) {
        throw limitError(`fitur GeoJSON > ${limits.MAX_FEATURES}`);
    }

    const out = [];
    for (const feature of features) {
        if (!feature || typeof feature !== "object" || protoUnsafe(feature)) {
            throw new Error("fitur GeoJSON tidak sah");
        }
        const geometry = readOwn(feature, "geometry");
        let location;
        try {
            location = geoJsonLocation(geometry, limits);
        }
        catch (error) {
            if (String(error.message).startsWith("IMPORT_LIMIT_EXCEEDED")) throw error;
            continue; // fitur tunggal tidak sah → lewati fitur itu saja
        }
        if (location.lat < -90 || location.lat > 90 || location.lon < -180 || location.lon > 180) {
            continue; // di luar rentang dunia → lewati
        }
        const props = boundedProperties(readOwn(feature, "properties"), limits);
        out.push({
            id: props.id ?? undefined,
            type: props.type ?? undefined,
            location,
            metadata: props
        });
    }
    return out;
}

// ---- ORKESTRASI IMPOR -----------------------------------------------------

/**
 * Impor aset dari teks/bytes ke registry — SEMUA batas ditegakkan.
 * @param {AssetRegistry} registry
 * @param {{ format:"kml"|"kmz"|"csv"|"geojson", data:string|Buffer,
 *           source?:string, accessClass?:string, limits?:object }} input
 * @returns {{ imported: object[], rejected: {index:number, reason:string}[], duplicates:number }}
 */
function importAssets(registry, input) {
    const format = String(input?.format ?? "").toLowerCase();
    if (!SUPPORTED.includes(format)) {
        throw new Error(`format tidak didukung: ${format} (didukung: ${SUPPORTED.join(", ")})`);
    }
    const limits = resolveImportLimits(input?.limits);

    // Data harus berupa string/Buffer biasa — tanpa getter hostil.
    if (input === null || typeof input !== "object" ||
        (typeof input.data !== "string" && !Buffer.isBuffer(input.data))) {
        throw new Error("input.data wajib string atau Buffer");
    }

    const run = (rawCandidates) => {
        const imported = [];
        const rejected = [];
        let duplicates = 0;
        const seen = new Set();

        if (rawCandidates.length > limits.MAX_FEATURES) {
            throw limitError(`fitur > ${limits.MAX_FEATURES}`);
        }

        rawCandidates.forEach((item, index) => {
            if (!isValidPoint(item.location)) {
                rejected.push({ index, reason: "koordinat tidak valid" });
                return;
            }
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
    };

    if (format === "csv") return run(parseCsv(String(input.data), limits));
    if (format === "kml") return run(parseKml(String(input.data), limits));
    if (format === "kmz") {
        // KMZ async → hasil sinkron tidak mungkin; dukung sinkron via
        // deasync tidak diperbolehkan — sediakan parseKmzAsync untuk
        // pemanggil async; sinkron menolak dengan instruksi jelas.
        throw new Error("impor KMZ wajib memakai importAssetsAsync");
    }
    return run(parseGeoJson(input.data, limits));
}

/** Varian async — diperlukan untuk KMZ (ZIP inflate async). */
async function importAssetsAsync(registry, input) {
    const format = String(input?.format ?? "").toLowerCase();
    if (!SUPPORTED.includes(format)) {
        throw new Error(`format tidak didukung: ${format} (didukung: ${SUPPORTED.join(", ")})`);
    }
    const limits = resolveImportLimits(input?.limits);
    if (format !== "kmz") return importAssets(registry, input);

    if (!Buffer.isBuffer(input.data) && typeof input.data !== "string") {
        throw new Error("input.data wajib string atau Buffer");
    }
    const kmlText = await parseKmz(input.data, limits);
    return importAssets(registry, { ...input, format: "kml", data: kmlText, limits });
}

module.exports = {
    SUPPORTED,
    parseCsv,
    parseKml,
    parseKmz,
    parseGeoJson,
    parseCoord,
    parseXmlElements,
    importAssets,
    importAssetsAsync
};
