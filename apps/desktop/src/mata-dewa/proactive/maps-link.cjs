'use strict';
// Google Maps link resolution for watch-point creation (Owner mandate,
// 2026-11-24). The Owner adds a watch point by pasting a Maps link; CORE
// resolves it - the UI never guesses coordinates, and a link that cannot be
// resolved fails with a typed error. Coordinates are NEVER fabricated.
// Handled link families:
//   - short links (goo.gl/maps, maps.app.goo.gl) and full google.com/maps
//     URLs carrying @lat,lng or a place path -> one point (name editable).
//   - Google My Maps links -> the map's public KML export is parsed and
//     every placemark becomes a watch point (points keep their map names;
//     areas become their centroid, labeled kind 'area'). This is the bulk
//     path for infrastructure-asset watch points (dozens of assets at once:
//     towers, warehouses, sites - any user's own assets).
// The original URL is stored as the watch point's provenance (sourceUrl).
// Resolution is Owner-initiated (a paste in the Dashboard), not autonomous
// egress: every hop is restricted to Google Maps hosts over https.

const ALLOWED_HOSTS = new Set(['goo.gl', 'maps.app.goo.gl', 'google.com', 'www.google.com', 'maps.google.com', 'www.google.co.id', 'google.co.id']);
const MAX_HOPS = 6;
const num = (v) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null; };
const validPair = (lat, lon) => lat !== null && lon !== null && Math.abs(lat) <= 90;

function coordsFromUrl(u) {
  const s = String(u);
  let m = /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/.exec(s);
  if (m && validPair(num(m[1]), num(m[2]))) return { lat: Number(m[1]), lon: Number(m[2]) };
  m = /[?&](?:q|query|ll|center|destination)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/.exec(s);
  if (m && validPair(num(m[1]), num(m[2]))) return { lat: Number(m[1]), lon: Number(m[2]) };
  return null;
}
function nameFromUrl(u) {
  const m = /\/maps\/place\/([^/@?]+)/.exec(String(u));
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).slice(0, 80) || null; } catch { return null; }
}
function myMapsId(u) {
  const m = /[?&]mid=([\w-]{8,})/.exec(String(u));
  return m ? m[1] : null;
}
const xmlText = (block, tag) => { const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(block); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null; };
function parseKml(kml) {
  const text = String(kml || '').slice(0, 2 * 1024 * 1024);
  const mapTitle = xmlText(text, 'name');
  const points = [];
  const re = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let pm;
  while ((pm = re.exec(text)) && points.length < 500) {
    const block = pm[1];
    const name = (xmlText(block, 'name') || 'Titik pantau').slice(0, 80);
    const pt = /<Point>[\s\S]*?<coordinates>\s*(-?\d+\.\d+),(-?\d+\.\d+)/.exec(block);
    if (pt && validPair(num(pt[2]), num(pt[1]))) { points.push({ name, lat: Number(pt[2]), lon: Number(pt[1]), kind: 'point' }); continue; }
    const ring = /<coordinates>\s*([^<]+)<\/coordinates>/.exec(block);
    if (ring) {
      const verts = ring[1].trim().split(/\s+/).map(tok => tok.split(',').map(Number)).filter(v => Number.isFinite(v[0]) && Number.isFinite(v[1]));
      if (verts.length >= 3) {
        const uniq = verts.slice(0, -1).length && verts[0][0] === verts[verts.length - 1][0] && verts[0][1] === verts[verts.length - 1][1] ? verts.slice(0, -1) : verts;
        const lat = uniq.reduce((s, v) => s + v[1], 0) / uniq.length, lon = uniq.reduce((s, v) => s + v[0], 0) / uniq.length;
        if (validPair(lat, lon)) points.push({ name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, kind: 'area' });
      }
    }
  }
  return { mapTitle, points };
}

// httpGet(url) -> { status, location?, body? } and must NOT follow redirects.
async function resolveMapsLink(rawUrl, { httpGet } = {}) {
  if (typeof httpGet !== 'function') throw new Error('httpGet required');
  let url = String(rawUrl || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'NOT_A_MAPS_LINK' }; }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) return { ok: false, error: 'NOT_A_MAPS_LINK' };
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // My Maps can be recognized at any hop (short link -> viewer URL).
    const mid = myMapsId(current);
    if (mid) {
      const kmlUrl = 'https://www.google.com/maps/d/kml?mid=' + encodeURIComponent(mid) + '&forcekml=1';
      const res = await httpGet(kmlUrl).catch(() => null);
      if (!res || res.status !== 200 || !res.body || !String(res.body).includes('<kml')) return { ok: false, error: 'MYMAPS_NOT_ACCESSIBLE' };
      const { mapTitle, points } = parseKml(res.body);
      if (!points.length) return { ok: false, error: 'KML_EMPTY' };
      return { ok: true, kind: 'mymaps', mapTitle, points, sourceUrl: url };
    }
    const direct = coordsFromUrl(current);
    if (direct) return { ok: true, kind: 'point', points: [{ name: nameFromUrl(current) || 'Titik pantau', lat: direct.lat, lon: direct.lon, kind: 'point' }], sourceUrl: url };
    if (hop === MAX_HOPS) break;
    const res = await httpGet(current).catch(() => null);
    if (!res) return { ok: false, error: 'REDIRECT_FAILED' };
    if (res.status >= 300 && res.status < 400 && res.location) {
      let next; try { next = new URL(res.location, current); } catch { return { ok: false, error: 'REDIRECT_FAILED' }; }
      if (next.protocol !== 'https:' || !ALLOWED_HOSTS.has(next.hostname)) return { ok: false, error: 'REDIRECT_FAILED' };
      current = next.toString();
      continue;
    }
    if (res.status === 200 && res.body) {
      const inPage = coordsFromUrl(res.body) || (() => { const m = /\[null,null,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]/.exec(res.body); return m && validPair(num(m[1]), num(m[2])) ? { lat: Number(m[1]), lon: Number(m[2]) } : null; })();
      if (inPage) return { ok: true, kind: 'point', points: [{ name: nameFromUrl(current) || 'Titik pantau', lat: inPage.lat, lon: inPage.lon, kind: 'point' }], sourceUrl: url };
      return { ok: false, error: 'NO_COORDS_FOUND' };
    }
    return { ok: false, error: 'REDIRECT_FAILED' };
  }
  return { ok: false, error: 'TOO_MANY_REDIRECTS' };
}

// --- Plus Codes (Open Location Code) + raw coordinates -------------------------------------------
// The add-point form also accepts a pasted Plus Code or a plain "lat, lon"
// pair (Owner order 2026-11-28: paste-only watch-point creation). Decoding
// follows the public Open Location Code specification; a short (compound)
// code is recovered against a reference location (the first configured
// area, else the product's neutral Jakarta default) - the same recovery
// Google Maps itself performs with the locality named after the code.
const OLC_ALPHABET = '23456789CFGHJMPQRVWX';
const OLC_PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];
const olcIdx = ch => OLC_ALPHABET.indexOf(ch);
function olcDecodeDigits(digits) {
  // digits: the full significant digit string (no '+', no padding).
  let lat = -90, lon = -180, latRes = 0, lonRes = 0;
  const pairCount = Math.min(5, Math.floor(digits.length / 2));
  for (let i = 0; i < pairCount; i++) {
    latRes = OLC_PAIR_RES[i]; lonRes = OLC_PAIR_RES[i];
    lat += olcIdx(digits[2 * i]) * latRes;
    lon += olcIdx(digits[2 * i + 1]) * lonRes;
  }
  if (digits.length > 10) {
    for (let i = 10; i < digits.length; i++) {
      latRes /= 5; lonRes /= 4;
      const v = olcIdx(digits[i]);
      lat += Math.floor(v / 4) * latRes;
      lon += (v % 4) * lonRes;
    }
  }
  return { lat: lat + latRes / 2, lon: lon + lonRes / 2 };
}
function decodePlusCode(raw, reference = null) {
  const m = /^([23456789CFGHJMPQRVWX]{2,8})\+([23456789CFGHJMPQRVWX]{2,})$/.exec(String(raw || '').trim().toUpperCase());
  if (!m) return null;
  const head = m[1].replace(/0+$/, ''), tail = m[2];
  if (head.length % 2 || tail.length < 2) return null;
  const digits = head + tail;
  if (digits.length < 4 || [...digits].some(ch => olcIdx(ch) < 0)) return null;
  if (head.length >= 8) {
    const c = olcDecodeDigits(digits);
    return Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 ? c : null;
  }
  // Compound (short) code: its digits are the tail of a full code; recover
  // the prefix cell nearest to the reference location.
  if (!reference || !Number.isFinite(reference.lat) || !Number.isFinite(reference.lon)) return null;
  const p0 = (8 - head.length) / 2; // first pair index the head digits occupy
  if (!Number.isSafeInteger(p0) || p0 < 1) return null;
  let lat = -90, lon = -180;
  const pairCount = Math.min(5, Math.floor(digits.length / 2));
  for (let i = 0; i < pairCount; i++) {
    lat += olcIdx(digits[2 * i]) * OLC_PAIR_RES[p0 + i];
    lon += olcIdx(digits[2 * i + 1]) * OLC_PAIR_RES[p0 + i];
  }
  let latRes = OLC_PAIR_RES[p0 + pairCount - 1], lonRes = latRes;
  if (digits.length > 10) {
    for (let i = 10; i < digits.length; i++) { latRes /= 5; lonRes /= 4; const v = olcIdx(digits[i]); lat += Math.floor(v / 4) * latRes; lon += (v % 4) * lonRes; }
  }
  const cell = 20 * OLC_PAIR_RES[p0];
  lat += Math.round((reference.lat - (lat + latRes / 2)) / cell) * cell;
  lon += Math.round((reference.lon - (lon + lonRes / 2)) / cell) * cell;
  const c = { lat: lat + latRes / 2, lon: lon + lonRes / 2 };
  return Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 ? c : null;
}
function parseCoordsText(raw) {
  const m = /^(-?\d{1,2}(?:\.\d+)?)°?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)°?$/.exec(String(raw || '').trim());
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
// One paste box, three input families: a Maps link (delegates to
// resolveMapsLink), a Plus Code, or raw coordinates.
async function resolvePasteInput(raw, { httpGet, reference = null } = {}) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'INPUT_EMPTY' };
  if (/^https?:\/\//i.test(input)) return resolveMapsLink(input, { httpGet });
  const codeToken = input.split(/\s+/)[0];
  if (codeToken.includes('+')) {
    const c = decodePlusCode(codeToken, reference);
    if (!c) return { ok: false, error: 'PLUS_CODE_INVALID' };
    const locality = input.slice(codeToken.length).trim().replace(/[^\p{L}\p{N} .,'()_-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return { ok: true, kind: 'pluscode', points: [{ name: locality || 'Titik pantau', lat: Math.round(c.lat * 1e6) / 1e6, lon: Math.round(c.lon * 1e6) / 1e6, kind: 'point' }], sourceUrl: null };
  }
  const coords = parseCoordsText(input);
  if (coords) return { ok: true, kind: 'coords', points: [{ name: 'Titik pantau', lat: coords.lat, lon: coords.lon, kind: 'point' }], sourceUrl: null };
  return { ok: false, error: 'INPUT_NOT_RECOGNIZED' };
}

module.exports = { resolveMapsLink, parseKml, coordsFromUrl, ALLOWED_HOSTS, decodePlusCode, parseCoordsText, resolvePasteInput };
