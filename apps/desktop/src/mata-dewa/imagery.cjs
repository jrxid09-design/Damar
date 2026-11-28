'use strict';
// Satellite imagery for Mata Dewa watch locations, adapted from gods-eye-view's
// Recent Imagery layer (MIT, see THIRD_PARTY_NOTICES.md): the granule catalog is
// NASA CMR (keyless) for the Harmonized Landsat and Sentinel-2 (HLS) products,
// and the picture itself is a NASA Worldview Snapshot (WVS) of the matching GIBS
// layer for the granule's own day. This is dated, latest-pass public imagery,
// never a live feed: every surface that shows it also shows its date.
//   S30: Sentinel-2 via HLS, collection C2021957295-LPCLOUD, GIBS layer
//        HLS_S30_Nadir_BRDF_Adjusted_Reflectance (30 m)
//   L30: Landsat 8/9 via HLS, collection C2021957657-LPCLOUD, GIBS layer
//        HLS_L30_Nadir_BRDF_Adjusted_Reflectance (30 m)

const PRODUCTS = Object.freeze({
  S30: Object.freeze({ label: 'Sentinel-2 (HLS S30)', sensor: 'Sentinel-2', collection: 'C2021957295-LPCLOUD', gibsLayer: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance' }),
  L30: Object.freeze({ label: 'Landsat 8/9 (HLS L30)', sensor: 'Landsat 8/9', collection: 'C2021957657-LPCLOUD', gibsLayer: 'HLS_L30_Nadir_BRDF_Adjusted_Reflectance' }),
});
const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.umm_json';
const WVS = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';
const fail = code => Object.assign(Error(code), { code });
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// A small box around the location (about 12 km across): one HLS tile always
// covers it, and the snapshot stays readable at asset scale.
function boxFor(loc, halfKm = 6) {
  const dLat = halfKm / 111, dLon = halfKm / (111 * Math.max(0.2, Math.cos(loc.lat * Math.PI / 180)));
  return { w: Math.max(-180, loc.lon - dLon), e: Math.min(180, loc.lon + dLon), s: Math.max(-90, loc.lat - dLat), n: Math.min(90, loc.lat + dLat) };
}

function cmrUrl(product, box, startIso, endIso) {
  const spec = PRODUCTS[product]; if (!spec) throw fail('IMAGERY_PRODUCT_UNKNOWN');
  return CMR + '?collection_concept_id=' + spec.collection +
    '&bounding_box=' + [box.w, box.s, box.e, box.n].map(v => v.toFixed(4)).join(',') +
    '&temporal=' + encodeURIComponent(startIso) + ',' + encodeURIComponent(endIso) +
    '&sort_key=-start_date&page_size=25';
}

// CMR umm_json -> scenes, newest first. Field mapping follows gods-eye-view's
// parseCmrUmm: id from the concept id / GranuleUR, time from the range begin,
// cloud cover from the CLOUD_COVERAGE additional attribute.
function parseCmrUmm(json, product) {
  const out = [];
  for (const item of Array.isArray(json?.items) ? json.items : []) {
    const umm = item?.umm || {}, meta = item?.meta || {};
    const begin = umm.TemporalExtent?.RangeDateTime?.BeginningDateTime;
    if (typeof begin !== 'string' || !Number.isFinite(Date.parse(begin))) continue;
    const attr = Array.isArray(umm.AdditionalAttributes) ? umm.AdditionalAttributes.find(a => a?.Name === 'CLOUD_COVERAGE') : null;
    const cloud = num(attr?.Values?.[0]) ?? num(umm.CloudCover);
    out.push({ id: String(meta['concept-id'] || umm.GranuleUR || meta['native-id'] || ''), product,
      datetime: new Date(Date.parse(begin)).toISOString(), cloudCoverPct: cloud === null ? null : Math.round(cloud) });
  }
  return out.sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime));
}

// Worldview Snapshot URL for one scene day (EPSG:4326 BBOX order: south,west,north,east).
function snapshotUrl(product, day, box, width = 640, height = 640) {
  const spec = PRODUCTS[product]; if (!spec) throw fail('IMAGERY_PRODUCT_UNKNOWN');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw fail('IMAGERY_DAY_INVALID');
  const bbox = [box.s, box.w, box.n, box.e].map(v => String(Number(v.toFixed(6)))).join(',');
  return WVS + '?REQUEST=GetSnapshot&LAYERS=' + spec.gibsLayer + '&CRS=EPSG:4326&TIME=' + day + '&BBOX=' + bbox +
    '&WIDTH=' + Math.round(width) + '&HEIGHT=' + Math.round(height) + '&FORMAT=image/jpeg';
}

const DAY_MS = 86400000;
// Latest scenes for one location across both HLS products, newest first.
// ctx.fetch is the egress-guarded fetch (allowlist + caps) from the caller.
async function latestScenes(loc, ctx, { days = 45, now = Date.now } = {}) {
  const box = boxFor(loc), end = new Date(now()).toISOString(), start = new Date(now() - days * DAY_MS).toISOString();
  const scenes = [];
  for (const product of ['S30', 'L30']) {
    try { scenes.push(...parseCmrUmm(JSON.parse(await ctx.fetch(cmrUrl(product, box, start, end), { maxBytes: 2 * 1024 * 1024 })), product)); } catch {}
  }
  if (!scenes.length) throw fail('IMAGERY_NO_SCENES');
  return scenes.sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime)).slice(0, 5)
    .map(s => ({ ...s, day: s.datetime.slice(0, 10), label: PRODUCTS[s.product].label, sensor: PRODUCTS[s.product].sensor }));
}

// One dated snapshot (JPEG bytes) of the location for a scene day.
async function fetchChip(loc, { day, product = 'S30' } = {}, ctx) {
  const buf = await ctx.fetch(snapshotUrl(product, day, boxFor(loc)), { binary: true, timeoutMs: 30000, maxBytes: 6 * 1024 * 1024 });
  if (!Buffer.isBuffer(buf) || buf.length < 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) throw fail('IMAGERY_SNAPSHOT_INVALID');
  return buf;
}

module.exports = { PRODUCTS, boxFor, cmrUrl, parseCmrUmm, snapshotUrl, latestScenes, fetchChip };
