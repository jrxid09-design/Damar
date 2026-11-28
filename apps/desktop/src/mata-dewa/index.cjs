'use strict';
// Mata Dewa Core module: routes under /api/r9/mata-dewa/* (authenticated by r9-routes before delegation).
//  - Public feeds, public cameras and status: requester or owner, read-only, Owner consent required before any fetch.
//  - Feed keys, own cameras, own-camera snapshots and ALPR: Owner only. Keys and camera credentials are DPAPI-encrypted
//    in the key store (matadewa-<feed>, matadewa-cam-<id>) and never returned.
// Configuration is Core settings `mataDewa.*` (Owner, via Control). Feed results are cached for the configured refresh
// interval and persisted (bounded) to the Core session directory so a restart does not re-hit upstream quotas.
const fs = require('node:fs'), path = require('node:path');
const { FEEDS, FEED_IDS, KEY_FEEDS, CCTV_SOURCES, SETTINGS_DEFAULTS } = require('./feeds.cjs');
const { createProactiveAlerts } = require('./proactive/proactive-alerts.cjs');
const { createBmkgProviders } = require('./proactive/bmkg-providers.cjs');
const { createExternalChannels } = require('./proactive/alert-channels.cjs');
const { resolveMapsLink } = require('./proactive/maps-link.cjs');
const egress = require('./egress.cjs');
const imagery = require('./imagery.cjs');
const { createCameras, PUBLIC_SOURCES } = require('./cameras.cjs');
const { createAlpr, pythonEngine } = require('./alpr.cjs');

const NOTICE = Object.freeze({
  privacy: 'Public feeds only. Aircraft are shown as broadcast on public ADS-B, except aircraft in the FAA LADD/PIA privacy programs, which are withheld. Private and unidentified vessels are anonymous. Only the latest snapshot is kept: no tracks or history.',
  accuracy: 'Third-party observations and model estimates with their own latency and coverage. Not DAMAR sensing, not verified on the ground, not for navigation, flight planning or safety-of-life decisions.',
  consent: 'Enabling Mata Dewa lets DAMAR Core contact only the public hosts listed here over HTTPS. Requests reveal your public IP address and the coordinates of your areas of interest to those services. Keys you add are sent only to their own provider.',
  cctv: 'Your cameras: you are responsible for lawful use. Recording people may require signage, a lawful basis (e.g. GDPR Art. 6), data-minimisation and respect for neighbours\' privacy. Do not point cameras at public space or others\' property beyond what local law permits. Public cameras shown here are official feeds their publishers intend to be viewed; DAMAR shows the latest still only and never records them.',
  alpr: 'Licence-plate recognition processes personal data. Use it only on your own cameras, where local law allows, with signage where required. Plates are read locally, kept for the retention period you set (default 30 days) and then deleted. DAMAR does not look up vehicle owners and never runs ALPR on public cameras.',
});
const codeOf = e => (e instanceof SyntaxError ? 'UPSTREAM_MALFORMED' : /^[A-Z0-9_]{1,64}$/.test(e?.code || '') ? e.code : 'FEED_FAILED');
const fail = (code, status) => Object.assign(Error(code), { status });
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

// Short WebSocket listening window (AISStream). Host must be allowlisted; frames and bytes are capped.
function wsWindow(url, subscription, { windowMs = 8000, maxBytes = 4 * 1024 * 1024, maxMessages = 5000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'wss:' || (u.port && u.port !== '443') || !egress.HOSTS.includes(u.hostname)) return Promise.reject(Object.assign(Error('EGRESS_HOST_NOT_ALLOWED'), { code: 'EGRESS_HOST_NOT_ALLOWED' }));
  if (typeof WebSocketImpl !== 'function') return Promise.reject(Object.assign(Error('WEBSOCKET_UNAVAILABLE'), { code: 'WEBSOCKET_UNAVAILABLE' }));
  return new Promise((resolve, reject) => {
    const out = []; let bytes = 0, done = false, opened = false;
    const ws = new WebSocketImpl(url);
    const end = err => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} err ? reject(err) : resolve(out); };
    const timer = setTimeout(() => end(opened ? null : Object.assign(Error('EGRESS_TIMEOUT'), { code: 'EGRESS_TIMEOUT' })), windowMs);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { opened = true; ws.send(JSON.stringify(subscription)); };
    ws.onmessage = ev => {
      const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      bytes += text.length; if (bytes > maxBytes || out.length >= maxMessages) return end();
      try { const m = JSON.parse(text); if (m && m.error) return end(Object.assign(Error('UPSTREAM_AUTH_REJECTED'), { code: 'UPSTREAM_AUTH_REJECTED' })); out.push(m); } catch {}
    };
    ws.onerror = () => end(Object.assign(Error('EGRESS_NETWORK_ERROR'), { code: 'EGRESS_NETWORK_ERROR' }));
    ws.onclose = () => end();
  });
}

function createMataDewa({ settings, fetch = egress.fetchPublic, ws = wsWindow, now = Date.now, timeoutMs = 10000, keyStore = null, cacheFile = null, profileDir = null, python = null,
  cameras: camerasIn = null, alprEngine = null, alprDir = null, onAlert = null, proactiveAutostart = false, notchChannel = null }) {
  const cache = new Map(), inflight = new Map(), keys = new Map();
  const config = () => settings?.mataDewa?.()?.mataDewa || SETTINGS_DEFAULTS();
  // ---- proactive alerts (Fase 6): autonomous Core engine over these feeds ----
  let gpsReport = null; // latest mobile-node GPS report (in-memory; the node re-reports on its cadence)
  const proactive = createProactiveAlerts({
    getSettings: () => { const c = config(); return { ...c, alerts: { ...(c.alerts || {}), enabled: !!(c.alerts?.enabled && c.consent) } }; },
    getProfile: () => { try { return settings?.presence?.()?.presence || {}; } catch { return {}; } },
    getGps: () => gpsReport,
    providers: {
      quakes: async () => (await load('earthquakes', null, config())).items || [],
      forecast: async (loc) => {
        const text = await fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' + loc.lat.toFixed(4) + '&lon=' + loc.lon.toFixed(4), { timeoutMs, headers: { 'user-agent': egress.userAgent(config().contactUrl) }, maxBytes: 512 * 1024 });
        const ts = (JSON.parse(text).properties?.timeseries) || [];
        return ts.map(e => { const n1 = e.data?.next_1_hours || {}; const inst = e.data?.instant?.details || {}; return { time: e.time, precipitationMm: typeof n1.details?.precipitation_amount === 'number' ? n1.details.precipitation_amount : null, symbol: n1.summary?.symbol_code || null, windKmh: typeof inst.wind_speed === 'number' ? Math.round(inst.wind_speed * 36) / 10 : null }; });
      },
      hotspots: async (loc) => { const v = await load('fires', { lat: loc.lat, lon: loc.lon, radiusKm: loc.radiusKm }, config()).catch(() => null); return ((v && v.items) || []).map(i => ({ lat: i.lat, lon: i.lon, frp: typeof i.frp === 'number' ? i.frp : null, time: i.time || i.acqDate || null })); },
      // scenes: live since the God's Eye parity build (Owner order 2026-11-28): the
      // NASA CMR HLS granule catalog (keyless, egress-allowlisted) feeds the
      // imagery-observation rule - a new dated Sentinel-2 / Landsat pass over an
      // asset point is recorded as an observation, never a damage claim.
      scenes: async (loc) => { if (!config().alerts?.imageryAlerts) return []; return imagery.latestScenes(loc, { fetch: (url, o = {}) => fetch(url, { timeoutMs: 20000, ...o, headers: { 'user-agent': egress.userAgent(config().contactUrl), ...(o.headers || {}) } }) }); },
      // BMKG (official public data): quake list incl. BMKG's own tsunami
      // Potensi wording + village forecast for watch points carrying adm4.
      ...createBmkgProviders({ fetchText: (url) => fetch(url, { timeoutMs, headers: { 'user-agent': egress.userAgent(config().contactUrl) }, maxBytes: 1024 * 1024 }) }),
      // volcanoes: intentionally not wired live yet - no public machine-readable PVMBG feed could be
      // verified (MAGMA Indonesia publishes for humans; its API guesses return 403/404). The rule,
      // the coordinate catalog and the normalizer are implemented and fixture-tested; composing a
      // live provider is a feed-availability decision, like scenes above.
    },
    // DAMAR's OWN external channels: targets from DAMAR's centralized
    // settings, tokens from DAMAR's own vault by name. Unconfigured =
    // status "ready" (siap diaktifkan); nothing is ever borrowed from
    // another system's credentials or channels.
    channels: { ...createExternalChannels({
      getChannelsConfig: () => config().alerts || {},
      resolveSecret: (name) => { try { return keyStore?.load(name) || null; } catch { return null; } },
    }), ...(notchChannel && typeof notchChannel.send === 'function' ? { notch: notchChannel } : {}) },
  });
  { const ac = config().alerts; if (proactiveAutostart && ac?.enabled) proactive.start((ac.tickMinutes || 10) * 60000); }
  const cameras = camerasIn || createCameras({ profileDir, keyStore });
  const alpr = createAlpr({ profileDir, cameras, settings: config, engine: alprEngine || pythonEngine({ basePython: python, ...(alprDir ? { dir: alprDir } : {}) }), now, onAlert });

  // ---- persisted cache (latest snapshot + timestamps), bounded ----
  try { const v = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (v?.version === 1) for (const [k, e] of Object.entries(v.entries || {})) if (e && Number.isFinite(e.at) && FEEDS[k.split('|')[0]]) cache.set(k, e); } catch {}
  let saveTimer = null;
  function persist() {
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const entries = [...cache.entries()].sort((a, b) => b[1].at - a[1].at); let doc;
      while (true) { doc = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }); if (doc.length <= CACHE_MAX_BYTES || !entries.length) break; entries.pop(); }
      try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile + '.tmp', doc); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch {}
    }, 500);
    saveTimer.unref?.();
  }

  const keyId = id => 'matadewa-' + id;
  const hasKey = id => keys.has(id) ? !!keys.get(id) : !!keyStore?.has(keyId(id));
  function keyFor(id) { if (!keys.has(id)) keys.set(id, keyStore?.load(keyId(id)) || null); return keys.get(id); }

  function view(entry, area) {
    const good = entry.ok ? entry : entry.last;
    return { area: area ? { id: area.id, name: area.name, lat: area.lat, lon: area.lon, radiusKm: area.radiusKm } : null,
      state: entry.ok ? 'OK' : good ? 'STALE' : 'ERROR', error: entry.ok ? null : entry.error,
      fetchedAt: good ? new Date(good.at).toISOString() : null, ageSec: good ? Math.round((now() - good.at) / 1000) : null,
      count: good ? good.items.length : 0, withheld: good?.withheld || 0, anonymous: good?.anonymous || 0, items: good ? good.items : [] };
  }

  function load(id, area, cfg) {
    const f = FEEDS[id];
    const key = id + '|' + (area ? [area.lat, area.lon, area.radiusKm].join(',') : id === 'satellites' ? cfg.satelliteGroup : '');
    const c = cache.get(key), ttl = (cfg.refreshSec[id] || f.defaultRefreshSec) * 1000;
    if (c && now() - c.at < (c.ok ? ttl : f.minRefreshSec * 1000)) return Promise.resolve(view(c, area));
    if (inflight.has(key)) return inflight.get(key).then(e => view(e, area));
    const ua = { 'user-agent': egress.userAgent(cfg.contactUrl) };
    const ctx = { fetch: (url, o = {}) => fetch(url, { timeoutMs, ...o, headers: { ...ua, ...(o.headers || {}) } }), ws, key: f.credential ? keyFor(id) : null, now };
    const p = Promise.resolve().then(() => f.load ? f.load(area, cfg, ctx) : ctx.fetch(f.url(area, cfg), { maxBytes: f.maxBytes }).then(t => f.parse(t))).then(items => (
      { ok: true, at: now(), items: [...items], withheld: items.withheld || 0, anonymous: items.anonymous || 0 }
    )).catch(e => ({ ok: false, at: now(), error: codeOf(e), last: c?.ok ? c : c?.last || null }))
      .then(e => { cache.set(key, e); inflight.delete(key); persist(); return e; });
    inflight.set(key, p);
    return p.then(e => view(e, area));
  }

  function status(who) {
    const cfg = config();
    alpr.schedule();
    return { consent: cfg.consent, satelliteGroup: cfg.satelliteGroup, areas: cfg.areas, watchPoints: cfg.watchPoints, notice: NOTICE, egressHosts: [...egress.HOSTS], contactUrl: cfg.contactUrl, userAgent: egress.userAgent(cfg.contactUrl),
      ...(who === 'owner' ? { alertsCfg: cfg.alerts } : {}),
      cctv: { sources: cfg.cctvSources, noticeAt: cfg.cctvNoticeAt, available: Object.entries(PUBLIC_SOURCES).map(([id, s]) => ({ id, label: s.label, region: s.region, attribution: s.attribution, license: s.license, terms: s.terms })), ffmpeg: cameras.ffmpeg() },
      alpr: { noticeAt: cfg.alprNoticeAt, retentionDays: cfg.alprRetentionDays, intervalSec: cfg.alprIntervalSec, ...(who === 'owner' ? { ...alpr.status(), installHosts: alpr.engine?.INSTALL_HOSTS || [] } : { unacknowledgedAlerts: alpr.status().unacknowledgedAlerts }) },
      feeds: FEED_IDS.map(id => { const f = FEEDS[id];
        return { id, label: f.label, enabled: cfg.feeds.includes(id), perArea: f.perArea, host: f.host, attribution: f.attribution, license: f.license, commercial: f.commercial, limits: f.limits,
          refreshSec: cfg.refreshSec[id] || f.defaultRefreshSec, minRefreshSec: f.minRefreshSec,
          credential: f.credential ? { fields: f.credential.fields, signupUrl: f.credential.signupUrl, hasKey: hasKey(id) } : 'none' }; }) };
  }

  async function feed(id) {
    const cfg = config();
    if (!cfg.consent) throw fail('MATA_DEWA_CONSENT_REQUIRED', 409);
    if (!cfg.feeds.includes(id)) throw fail('FEED_DISABLED', 409);
    const f = FEEDS[id];
    if (f.credential && !hasKey(id)) throw Object.assign(fail('FEED_KEY_REQUIRED', 409), { data: { signupUrl: f.credential.signupUrl } });
    const results = await Promise.all(f.perArea ? cfg.areas.map(a => load(id, a, cfg)) : [load(id, null, cfg)]);
    return { feed: id, label: f.label, attribution: f.attribution, license: f.license, host: f.host, results };
  }

  function setKey(id, input) {
    const f = FEEDS[id]; if (!f?.credential) throw fail('FEED_NOT_FOUND', 404);
    if (!keyStore) throw fail('KEY_STORE_UNAVAILABLE', 503);
    const tok = v => typeof v === 'string' && /^[\x21-\x7e]{4,256}$/.test(v);
    if (input.forget === true && Object.keys(input).length === 1) keyStore.forget(keyId(id));
    else if (f.credential.fields.join() === 'apiKey' && Object.keys(input).join() === 'apiKey' && tok(input.apiKey)) keyStore.save(keyId(id), input.apiKey);
    else if (f.credential.fields.join() === 'clientId,clientSecret' && Object.keys(input).sort().join() === 'clientId,clientSecret' && tok(input.clientId) && tok(input.clientSecret)) keyStore.save(keyId(id), input.clientId + '\n' + input.clientSecret);
    else throw fail('FEED_KEY_INVALID', 400);
    keys.delete(id);
    for (const k of [...cache.keys()]) if (k.startsWith(id + '|')) cache.delete(k);
    return { feed: id, hasKey: hasKey(id) };
  }

  // JSON frame for Control (its CSP allows same-origin fetch only; the view draws it via createImageBitmap on a canvas).
  const frame = (json, buf) => json(200, { success: true, data: { jpeg: buf.toString('base64'), bytes: buf.length, at: new Date(now()).toISOString() } });
  const sendJpeg = (res, buf) => { res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }); res.end(buf); return true; };

  // Delegated from r9-routes after authentication. json = r9's envelope writer; { who, body } = role + bounded JSON reader.
  async function handle(req, res, url, json, { who = 'requester', body = null } = {}) {
    const p = url.pathname, owner = who === 'owner', cfg = config();
    // keys/<feed>: POST only. cameras, alpr: GET (read) or POST (Owner change). Everything else: GET only.
    const allowed = /^\/api\/r9\/mata-dewa\/keys\/[A-Za-z]{1,24}$/.test(p) ? ['POST'] : /^\/api\/r9\/mata-dewa\/(cameras|alpr|proactive|location\/gps|watchpoints\/import-link)$/.test(p) ? ['GET', 'POST'] : ['GET'];
    const isPost = req.method === 'POST';
    // Only the public camera list takes a query (?q=<text>&page=<n>, server-side search + pagination).
    const listRoute = /^\/api\/r9\/mata-dewa\/cameras\/public\/[a-z-]{1,24}$/.test(p);
    // The imagery chip takes exactly ?point=<area-or-watchpoint-id>&day=<YYYY-MM-DD>&product=<S30|L30>.
    const chipRoute = /^\/api\/r9\/mata-dewa\/imagery\/chip(\/frame)?$/.test(p);
    if ((url.search && !listRoute && !chipRoute) || !allowed.includes(req.method)) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
    const qp = url.searchParams, q = qp.get('q') || '', page = Number(qp.get('page') || 1);
    if (listRoute && ([...qp.keys()].some(k => k !== 'q' && k !== 'page') || q.length > 60 || /[\x00-\x1f\x7f]/.test(q) || !Number.isSafeInteger(page) || page < 1 || page > 1000))
      return json(400, { success: false, error: 'CAMERA_QUERY_INVALID' });
    if (chipRoute && ([...qp.keys()].some(k => !['point', 'day', 'product'].includes(k)) || !/^[a-z0-9-]{1,24}$/.test(qp.get('point') || '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(qp.get('day') || '') || !Number.isFinite(Date.parse(qp.get('day'))) || Date.parse(qp.get('day')) > now() || !imagery.PRODUCTS[qp.get('product') || '']))
      return json(400, { success: false, error: 'IMAGERY_QUERY_INVALID' });
    if (!isPost && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) return json(413, { success: false, error: 'BODY_NOT_ALLOWED' });
    const ownerOnly = () => { if (!owner) throw fail('OWNER_REQUIRED', 403); };
    const consent = () => { if (!cfg.consent) throw fail('MATA_DEWA_CONSENT_REQUIRED', 409); };
    let m;
    try {
      if (p === '/api/r9/mata-dewa/status') return json(200, { success: true, data: status(who) });
      if ((m = /^\/api\/r9\/mata-dewa\/feeds\/([A-Za-z]{1,24})$/.exec(p)) && Object.prototype.hasOwnProperty.call(FEEDS, m[1])) return json(200, { success: true, data: await feed(m[1]) });
      if (chipRoute) {
        consent();
        const loc = (cfg.areas || []).map(a => ({ id: a.id, lat: a.lat, lon: a.lon })).concat((cfg.watchPoints || []).map(w => ({ id: w.id, lat: w.lat, lon: w.lon }))).find(x => x.id === qp.get('point'));
        if (!loc) throw fail('IMAGERY_POINT_NOT_FOUND', 404);
        const buf = await imagery.fetchChip(loc, { day: qp.get('day'), product: qp.get('product') },
          { fetch: (url, o = {}) => fetch(url, { timeoutMs: 30000, ...o, headers: { 'user-agent': egress.userAgent(cfg.contactUrl), ...(o.headers || {}) } }) });
        return p.endsWith('/frame') ? frame(json, buf) : sendJpeg(res, buf);
      }
      if ((m = /^\/api\/r9\/mata-dewa\/keys\/([A-Za-z]{1,24})$/.exec(p))) { ownerOnly(); if (!body) throw fail('BODY_UNAVAILABLE', 503); return json(200, { success: true, data: setKey(m[1], await body(req, 2048)) }); }
      if (p === '/api/r9/mata-dewa/cameras' && !isPost)
        return json(200, { success: true, data: { sources: cfg.cctvSources, own: owner ? cameras.own() : [], ffmpeg: cameras.ffmpeg() } });
      if (p === '/api/r9/mata-dewa/cameras') {
        ownerOnly(); if (!cfg.cctvNoticeAt) throw fail('CCTV_NOTICE_REQUIRED', 409);
        const input = await body(req, 4096);
        if (input.alpr === true && !cfg.alprNoticeAt) throw fail('ALPR_NOTICE_REQUIRED', 409);
        return json(200, { success: true, data: cameras.register(input) });
      }
      if ((m = /^\/api\/r9\/mata-dewa\/cameras\/public\/([a-z-]{1,24})(?:\/([A-Za-z0-9._-]{1,40})\/(snapshot|frame))?$/.exec(p))) {
        consent(); if (!CCTV_SOURCES.includes(m[1])) throw fail('CAMERA_SOURCE_NOT_FOUND', 404); if (!cfg.cctvSources.includes(m[1])) throw fail('CAMERA_SOURCE_DISABLED', 409);
        if (m[2]) { const buf = await cameras.publicSnapshot(m[1], m[2]); return m[3] === 'frame' ? frame(json, buf) : sendJpeg(res, buf); }
        const s = PUBLIC_SOURCES[m[1]];
        const needle = q.toLowerCase(), all = (await cameras.publicList(m[1])).filter(c => !needle || c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle));
        const PAGE = 24, pages = Math.max(1, Math.ceil(all.length / PAGE));
        return json(200, { success: true, data: { source: m[1], label: s.label, attribution: s.attribution, license: s.license, q, page, pages, total: all.length,
          cameras: all.slice((page - 1) * PAGE, page * PAGE).map(({ imageUrl, ...c }) => c) } });
      }
      if ((m = /^\/api\/r9\/mata-dewa\/cameras\/own\/(cam-[a-f0-9]{12})\/(snapshot|frame)$/.exec(p))) {
        ownerOnly(); if (!cfg.cctvNoticeAt) throw fail('CCTV_NOTICE_REQUIRED', 409);
        const buf = await cameras.ownSnapshot(m[1]); return m[2] === 'frame' ? frame(json, buf) : sendJpeg(res, buf);
      }
      if (p === '/api/r9/mata-dewa/proactive') {
    if (!owner) return json(403, { success: false, error: 'OWNER_REQUIRED' });
    if (isPost) { const summary = await proactive.tick('manual'); return json(200, { success: true, data: { summary } }); }
    return json(200, { success: true, data: { status: proactive.status(), deliveries: proactive.recentDeliveries(50) } });
  }
  if (p === '/api/r9/mata-dewa/location/gps' && isPost) {
    if (!owner) return json(403, { success: false, error: 'OWNER_REQUIRED' });
    const b = body || {};
    if (!Number.isFinite(b.lat) || Math.abs(b.lat) > 90 || !Number.isFinite(b.lon) || Math.abs(b.lon) > 180) return json(400, { success: false, error: 'GPS_INVALID' });
    gpsReport = { lat: b.lat, lon: b.lon, at: Number.isFinite(b.at) ? b.at : Date.now(), ...(Number.isFinite(b.radiusKm) ? { radiusKm: Math.min(1000, Math.max(10, b.radiusKm)) } : {}) };
    return json(200, { success: true, data: { recorded: true } });
  }
  if (p === '/api/r9/mata-dewa/watchpoints/import-link' && isPost) {
    if (!owner) return json(403, { success: false, error: 'OWNER_REQUIRED' });
    const b = body || {};
    const httpGet = async (u) => { const r = await globalThis.fetch(u, { redirect: 'manual', signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined }); let text = ''; if (r.status === 200) text = (await r.text()).slice(0, 1024 * 1024); return { status: r.status, location: r.headers.get('location') || undefined, body: text }; };
    const resolved = await resolveMapsLink(typeof b.url === 'string' ? b.url : '', { httpGet });
    if (!resolved.ok) return json(400, { success: false, error: resolved.error });
    const profile = b.profile === 'personal' ? 'personal' : 'asset';
    const cleanName = (n) => { const c = String(n || '').replace(/[^\p{L}\p{N} .,'()_-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40); return c || 'Titik pantau'; };
    const cur = [...(config().watchPoints || [])];
    let imported = 0, skipped = 0;
    for (const pt of resolved.points) {
      if (cur.length >= 200) { skipped++; continue; }
      if (cur.some(w => Math.abs(w.lat - pt.lat) < 0.0001 && Math.abs(w.lon - pt.lon) < 0.0001)) { skipped++; continue; }
      const name = cleanName(pt.name);
      let id = 'wp-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18) || 'point'); let n = 2;
      while (cur.some(w => w.id === id)) id = 'wp-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 15) || 'point') + '-' + (n++);
      cur.push({ id, name, lat: pt.lat, lon: pt.lon, radiusKm: profile === 'asset' ? 50 : 25, profile, sourceUrl: resolved.sourceUrl });
      imported++;
    }
    if (imported) { if (typeof settings.update === 'function') settings.update({ mataDewa: { watchPoints: cur } }); else if (typeof settings.set === 'function') settings.set({ watchPoints: cur }); else return json(501, { success: false, error: 'SETTINGS_READ_ONLY' }); }
    return json(200, { success: true, data: { kind: resolved.kind, mapTitle: resolved.mapTitle || null, imported, skipped, total: cur.length } });
  }
      if (p.startsWith('/api/r9/mata-dewa/alpr')) {
        ownerOnly(); alpr.schedule();
    if (p === '/api/r9/mata-dewa/alpr' && !isPost) return json(200, { success: true, data: { status: alpr.status(), entries: alpr.entries(), watchlist: alpr.watchlist(), alerts: alpr.alerts().slice(0, 100) } });
        if (p === '/api/r9/mata-dewa/alpr') {
          const input = await body(req, 2048);
          // Owner-consented engine install (venv + pinned packages + model weights; network to the disclosed hosts).
          if (input.action === 'install-engine') { if (!cfg.alprNoticeAt) throw fail('ALPR_NOTICE_REQUIRED', 409); if (!alpr.engine?.install) throw fail('ALPR_ENGINE_UNAVAILABLE', 503); return json(202, { success: true, data: await alpr.engine.install() }); }
          return json(200, { success: true, data: alpr.action(input) });
        }
        if (p === '/api/r9/mata-dewa/alpr/alerts') return json(200, { success: true, data: { alerts: alpr.alerts().slice(0, 100), unacknowledged: alpr.status().unacknowledgedAlerts } });
        if (p === '/api/r9/mata-dewa/alpr/export') return json(200, { success: true, data: alpr.exportAll() });
        if ((m = /^\/api\/r9\/mata-dewa\/alpr\/crops\/(alpr_[a-f0-9]{16})(\/frame)?$/.exec(p))) return m[2] ? frame(json, alpr.crop(m[1])) : sendJpeg(res, alpr.crop(m[1]));
      }
      return json(404, { success: false, error: 'NOT_FOUND' });
    } catch (e) {
      if (e.status) return json(e.status, { success: false, error: e.message, ...(e.data ? { data: e.data } : {}) });
      throw e;
    }
  }

  return { handle, status, feed, setKey, cameras, alpr, wsWindow, proactive };
}

module.exports = { createMataDewa, NOTICE, wsWindow };
