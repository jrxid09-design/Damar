'use strict';
// Mata Dewa cameras.
// (1) Official public cameras whose publishers intend them to be viewed, from documented open endpoints: TfL JamCams
//     (London) and Fintraffic weather cameras (Finland), plus the verified official Indonesian publishers added
//     2026-11-28 (Owner order: Indonesia first): the BPJT (Kementerian PU) toll-camera portal streaming Jasa Marga
//     and other toll operators' cameras, the Dishub Kota Bandung ATCS portal, and the Pemerintah Kota Yogyakarta
//     CCTV portal. The Indonesian sources publish HLS live streams for public viewing; DAMAR grabs ONE still frame
//     per request via ffmpeg and never records or archives the stream. Latest still only, cached briefly, never ALPR.
//     Sources checked and NOT integrated (2026-11-28): RTTMC Kemenhub (rttmc.dephub.go.id no longer resolves;
//     rttmc.kemenhub.go.id unreachable), Bina Marga CCTV page (404), jasamargalive.com as a portal (TLS certificate
//     expired; its streams are reached through the BPJT portal instead), ATCS Padang (unreachable), ATCS Cirebon
//     (404), Surabaya SITS and Kota Bogor CCTV subdomains (do not resolve), Semarang CCTV portal (HTTP 500),
//     Denpasar CCTV portal (403). Private aggregators (e.g. lewatmana.com) are never used: not the publisher.
// (2) The Owner's own cameras registered in Control: HTTP snapshot, MJPEG (first frame) or RTSP (one frame via ffmpeg
//     when present). LAN addresses are allowed ONLY for these registered URLs (egress.fetchCamera); credentials are kept
//     DPAPI-encrypted in the key store as matadewa-cam-<id> and never returned. No discovery, scanning or default-password
//     guessing exists anywhere in this module.
const fs = require('node:fs'), path = require('node:path'), dns = require('node:dns'), net = require('node:net'), crypto = require('node:crypto'), { spawn } = require('node:child_process');
const egress = require('./egress.cjs');

const fail = (code, status = 400) => Object.assign(Error(code), { code, status });
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n) : '');
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

const PUBLIC_SOURCES = Object.freeze({
  'tfl-london': {
    label: 'TfL JamCams (London traffic cameras)', region: 'London, UK', attribution: 'Powered by TfL Open Data', license: 'TfL Open Data terms (OGL v2 based); contains OS data © Crown copyright',
    terms: 'https://tfl.gov.uk/info-for/open-data-users/', listUrl: 'https://api.tfl.gov.uk/Place/Type/JamCam', headers: {}, maxBytes: 3 * 1024 * 1024,
    parse: text => JSON.parse(text).map(p => {
      const prop = k => (p.additionalProperties || []).find(x => x.key === k)?.value;
      const img = prop('imageUrl'); if (prop('available') === 'false' || typeof img !== 'string') return null;
      try { egress.checkUrl(img); } catch { return null; }
      return { id: str(p.id, 40).replace(/[^A-Za-z0-9._-]/g, ''), name: str(p.commonName, 80), lat: num(p.lat), lon: num(p.lon), imageUrl: img };
    }).filter(c => c && c.id),
  },
  fintraffic: {
    label: 'Fintraffic weather cameras (Finland roads)', region: 'Finland', attribution: 'Fintraffic / digitraffic.fi', license: 'CC BY 4.0',
    terms: 'https://www.digitraffic.fi/en/terms-of-service/', listUrl: 'https://tie.digitraffic.fi/api/weathercam/v1/stations', headers: { 'digitraffic-user': 'DAMAR-MataDewa' }, maxBytes: 4 * 1024 * 1024,
    parse: text => (JSON.parse(text).features || []).flatMap(f => (f.properties?.presets || []).filter(p => p.inCollection && /^[A-Z0-9]{6,12}$/.test(p.id))
      .map(p => ({ id: p.id, name: str(f.properties.name, 60) + ' · ' + p.id.slice(-2), lat: num(f.geometry?.coordinates?.[1]), lon: num(f.geometry?.coordinates?.[0]), imageUrl: 'https://weathercam.digitraffic.fi/' + p.id + '.jpg' }))),
  },
  // --- Indonesia (verified live 2026-11-28 from the Owner's network: list + a real frame grab per source) ---
  'bpjt-tol': {
    label: 'Kamera jalan tol BPJT (Kementerian PU)', region: 'Indonesia', kind: 'hls', attribution: 'BPJT, Kementerian Pekerjaan Umum · kamera operator jalan tol', license: 'Portal publik resmi BPJT (bpjt.pu.go.id/cctv)',
    terms: 'https://bpjt.pu.go.id/cctv/', listUrl: 'https://bpjt.pu.go.id/cctv/', headers: {}, maxBytes: 4 * 1024 * 1024,
    streamHosts: ['jmlive.jasamarga.com'],
    parse: text => {
      const out = [];
      for (const m of String(text).matchAll(/\{[^{}]*"streamhls"\s*:\s*"[^"]+"[^{}]*\}/g)) {
        let o; try { o = JSON.parse(m[0]); } catch { continue; }
        if (o.status !== '1' || typeof o.streamhls !== 'string' || !o.streamhls.startsWith('https://jmlive.jasamarga.com/')) continue;
        const lat = num(o.lat), lon = num(o.lon), uid = str(o.unique_id, 24).replace(/[^A-Za-z0-9._-]/g, '');
        if (lat === null || lon === null || !uid) continue;
        out.push({ id: 'tol-' + uid, name: (str(o.nama_km, 60) || 'Kamera tol') + (o.nama_ruas ? ' · ' + str(o.nama_ruas, 50) : ''), lat, lon, streamUrl: o.streamhls });
      }
      return out;
    },
  },
  'atcs-bandung': {
    label: 'ATCS Dishub Kota Bandung', region: 'Bandung, Indonesia', kind: 'hls', attribution: 'ATCS Dinas Perhubungan Kota Bandung', license: 'Portal publik resmi Dishub Kota Bandung (atcs-dishub.bandung.go.id)',
    terms: 'https://atcs-dishub.bandung.go.id/', streamHosts: ['atcs-dishub.bandung.go.id'], streamPorts: [443, 1990],
    // The portal's own flow: locations (POST /ajax/lokasi) -> cameras per location (POST /ajax/cctv-list, HTML)
    // -> the HLS address of one camera (POST /ajax/cctv-info), resolved lazily at snapshot time.
    async list(fetch) {
      const post = (p, body) => fetch('https://atcs-dishub.bandung.go.id' + p, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' }, maxBytes: 1024 * 1024, timeoutMs: 15000 });
      const locations = JSON.parse(await post('/ajax/lokasi', ''));
      const out = [];
      for (const loc of (Array.isArray(locations) ? locations : []).slice(0, 40)) {
        const lat = num(loc.lat_lokasi), lon = num(loc.lon_lokasi); if (lat === null || lon === null || loc.id_lokasi === undefined) continue;
        const html = await post('/ajax/cctv-list', 'id=' + encodeURIComponent(loc.id_lokasi)).catch(() => '');
        for (const m of String(html).matchAll(/showStreamingModal\((\d+)\)[\s\S]{0,700}?<p class="col-sm-12 text-center">\s*([A-Za-z0-9][^<]{0,79}?)\s*<\/p>/g))
          out.push({ id: 'bdg-' + m[1], name: str(m[2], 80) + ' · ' + str(loc.nama_lokasi, 40), lat, lon, ref: m[1] });
      }
      return out;
    },
    async resolveStream(cam, fetch) {
      const text = await fetch('https://atcs-dishub.bandung.go.id/ajax/cctv-info', { method: 'POST', body: 'id=' + encodeURIComponent(cam.ref), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' }, maxBytes: 64 * 1024, timeoutMs: 15000 });
      const src = JSON.parse(text)?.src; if (typeof src !== 'string') throw fail('CAMERA_NO_FRAME', 502);
      return src;
    },
  },
  'cctv-jogja': {
    label: 'CCTV Pemerintah Kota Yogyakarta', region: 'Yogyakarta, Indonesia', kind: 'hls', attribution: 'Pemerintah Kota Yogyakarta', license: 'Portal publik resmi Pemerintah Kota Yogyakarta (cctv.jogjakota.go.id)',
    terms: 'https://cctv.jogjakota.go.id/', listUrl: 'https://cctv.jogjakota.go.id/home/getdata', headers: { 'x-requested-with': 'XMLHttpRequest' }, maxBytes: 2 * 1024 * 1024,
    streamHosts: ['cctvjss.jogjakota.go.id'],
    parse: text => (JSON.parse(text) || []).map(r => {
      const lat = num(r.cctv_latitude), lon = num(r.cctv_longitude), id = str(r.cctv_id, 12).replace(/[^A-Za-z0-9._-]/g, '');
      if (lat === null || lon === null || !id || typeof r.cctv_link !== 'string' || !r.cctv_link.startsWith('https://cctvjss.jogjakota.go.id/')) return null;
      return { id: 'jog-' + id, name: str(r.cctv_title, 70) || 'Kamera Yogyakarta', lat, lon, streamUrl: r.cctv_link };
    }).filter(Boolean),
  },
});
const LIST_TTL = 6 * 3600 * 1000, SNAP_TTL = 60 * 1000, MAX_OWN = 16;

// ffmpeg is optional (RTSP only). Not bundled: GPL/LGPL builds need a licence review before any redistribution.
function findFfmpeg(env = process.env) {
  if (env.DAMAR_FFMPEG && path.isAbsolute(env.DAMAR_FFMPEG) && fs.existsSync(env.DAMAR_FFMPEG)) return env.DAMAR_FFMPEG;
  for (const dir of String(env.DAMAR_USER_PATH || env.PATH || '').split(path.delimiter)) {
    if (!dir) continue; const exe = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try { if (fs.statSync(exe).isFile()) return exe; } catch {}
  }
  // A fresh winget install is not on PATH until a new shell: check its Links folder and the Gyan.FFmpeg package folder.
  const local = env.DAMAR_USER_LOCALAPPDATA || env.LOCALAPPDATA;
  if (local && process.platform === 'win32') {
    const winget = path.join(local, 'Microsoft', 'WinGet');
    try { const link = path.join(winget, 'Links', 'ffmpeg.exe'); if (fs.statSync(link).isFile()) return link; } catch {}
    try {
      for (const pkg of fs.readdirSync(path.join(winget, 'Packages')).filter(n => /^Gyan\.FFmpeg/i.test(n)))
        for (const build of fs.readdirSync(path.join(winget, 'Packages', pkg))) { const exe = path.join(winget, 'Packages', pkg, build, 'bin', 'ffmpeg.exe'); if (fs.existsSync(exe)) return exe; }
    } catch {}
  }
  return null;
}

// addressCheck: which resolved addresses an Owner camera may use (product: egress.isCameraAddress, which refuses
// loopback/link-local). Only tests override it, to reach a loopback RTSP test source.
function createCameras({ profileDir, keyStore = null, fetchPublic = egress.fetchPublic, fetchCamera = egress.fetchCamera, ffmpeg = findFfmpeg(), spawnFn = spawn, now = Date.now, addressCheck = egress.isCameraAddress }) {
  const file = profileDir ? path.join(profileDir, 'cameras.json') : null;
  const lists = new Map(), snaps = new Map(), creds = new Map();
  let own = [];
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(v)) own = v.filter(c => c && /^cam-[a-f0-9]{12}$/.test(c.id)).slice(0, MAX_OWN); } catch {}
  const save = () => { fs.mkdirSync(profileDir, { recursive: true }); const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(own, null, 1)); fs.renameSync(tmp, file); };
  const ownView = c => ({ id: c.id, name: c.name, kind: c.kind, url: c.url, alpr: c.alpr, hasCredential: c.hasCredential });

  async function publicList(source) {
    const s = PUBLIC_SOURCES[source]; if (!s) throw fail('CAMERA_SOURCE_NOT_FOUND', 404);
    const c = lists.get(source);
    if (c && now() - c.at < (c.ok ? LIST_TTL : 300000)) { if (c.ok) return c.items; throw fail(c.error, 502); }
    try { const items = (typeof s.list === 'function' ? await s.list(fetchPublic) : s.parse(await fetchPublic(s.listUrl, { maxBytes: s.maxBytes, headers: s.headers, timeoutMs: 15000 }))).slice(0, 6000); lists.set(source, { ok: true, at: now(), items }); return items; }
    catch (e) { const code = e instanceof SyntaxError ? 'UPSTREAM_MALFORMED' : /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'FEED_FAILED'; lists.set(source, { ok: false, at: now(), error: code }); throw fail(code, 502); }
  }
  // One still frame from a publisher's public HLS stream. The stream URL comes from the publisher's own
  // list data and is re-validated here: https only, the source's own stream host and ports, an .m3u8 path,
  // and every resolved address public (the same anti-rebinding stance as egress.fetchPublic; ffmpeg does
  // its own networking, so the check happens before it is spawned). Nothing is recorded: one frame, out.
  async function hlsFrame(rawUrl, source) {
    if (!ffmpeg) throw fail('FFMPEG_NOT_FOUND', 503);
    let u; try { u = new URL(rawUrl); } catch { throw fail('CAMERA_URL_INVALID', 502); }
    const port = Number(u.port) || 443;
    if (u.protocol !== 'https:' || u.username || u.password || !(source.streamHosts || []).includes(u.hostname) || !(source.streamPorts || [443]).includes(port) || !u.pathname.endsWith('.m3u8')) throw fail('CAMERA_URL_REFUSED', 502);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true }).catch(() => { throw fail('EGRESS_NETWORK_ERROR', 502); })).map(a => a.address);
    if (!addrs.length || addrs.some(a => !egress.isPublicAddress(a))) throw fail('EGRESS_PRIVATE_ADDRESS', 502);
    return new Promise((resolve, reject) => {
      const p = spawnFn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'https,tls,tcp', '-i', u.toString(), '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let n = 0;
      const timer = setTimeout(() => { p.kill(); reject(fail('EGRESS_TIMEOUT', 504)); }, 20000);
      p.stdout.on('data', d => { n += d.length; if (n > 4 * 1024 * 1024) { p.kill(); clearTimeout(timer); reject(fail('EGRESS_RESPONSE_TOO_LARGE', 502)); } else chunks.push(d); });
      p.on('error', () => { clearTimeout(timer); reject(fail('FFMPEG_FAILED', 502)); });
      p.on('close', code => { clearTimeout(timer); const b = Buffer.concat(chunks); code === 0 && b[0] === 0xff ? resolve(b) : reject(fail('CAMERA_NO_FRAME', 502)); });
    });
  }
  async function publicSnapshot(source, id) {
    const s = PUBLIC_SOURCES[source];
    const cam = (await publicList(source)).find(c => c.id === id); if (!cam) throw fail('CAMERA_NOT_FOUND', 404);
    const key = source + '|' + id, c = snaps.get(key);
    if (c && now() - c.at < SNAP_TTL) return c.jpeg;
    let jpeg;
    if (s.kind === 'hls') {
      const url = cam.streamUrl || (typeof s.resolveStream === 'function' ? await s.resolveStream(cam, fetchPublic) : null);
      if (!url) throw fail('CAMERA_NO_FRAME', 502);
      jpeg = await hlsFrame(url, s);
    } else {
      jpeg = await fetchPublic(cam.imageUrl, { binary: true, maxBytes: 1024 * 1024, headers: s.headers });
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw fail('UPSTREAM_NOT_JPEG', 502);
    }
    snaps.set(key, { at: now(), jpeg }); if (snaps.size > 200) snaps.delete(snaps.keys().next().value);
    return jpeg;
  }

  function credential(c) {
    if (!c.hasCredential || !keyStore) return null;
    if (!creds.has(c.id)) { const raw = keyStore.load('matadewa-cam-' + c.id.slice(4)); creds.set(c.id, raw ? JSON.parse(raw) : null); }
    return creds.get(c.id);
  }
  function validCamera(input) {
    const name = str(input.name, 40), kind = input.kind, alpr = input.alpr === true;
    if (!/^[\p{L}\p{N} .,'()_-]{1,40}$/u.test(name)) throw fail('CAMERA_NAME_INVALID');
    if (!['snapshot', 'mjpeg', 'rtsp'].includes(kind)) throw fail('CAMERA_KIND_INVALID');
    if (typeof input.url !== 'string' || input.url.length > 400) throw fail('CAMERA_URL_INVALID');
    if (kind === 'rtsp') { let u; try { u = new URL(input.url); } catch { throw fail('CAMERA_URL_INVALID'); } if (!['rtsp:', 'rtsps:'].includes(u.protocol) || u.username || u.password) throw fail('CAMERA_URL_REFUSED'); }
    else try { egress.checkCameraUrl(input.url); } catch (e) { throw fail(e.code || 'CAMERA_URL_INVALID'); }
    return { name, kind, url: input.url, alpr };
  }
  // Owner registry. Requires the CCTV notice; ALPR additionally the ALPR notice (checked by the caller with settings).
  function register(input) {
    if (input.action === 'remove') {
      const i = own.findIndex(c => c.id === input.id); if (i < 0) throw fail('CAMERA_NOT_FOUND', 404);
      const [c] = own.splice(i, 1); keyStore?.forget('matadewa-cam-' + c.id.slice(4)); creds.delete(c.id); snaps.delete('own|' + c.id); save(); return null;
    }
    const base = input.action === 'update' ? own.find(c => c.id === input.id) : null;
    if (input.action === 'update' && !base) throw fail('CAMERA_NOT_FOUND', 404);
    if (input.action === 'add' && own.length >= MAX_OWN) throw fail('CAMERA_LIMIT', 409);
    if (!['add', 'update'].includes(input.action)) throw fail('ACTION_INVALID');
    const v = validCamera({ ...(base || {}), ...input });
    const c = base || { id: 'cam-' + crypto.randomBytes(6).toString('hex'), hasCredential: false };
    Object.assign(c, v);
    if (input.username !== undefined) {
      if (typeof input.username !== 'string' || input.username.length > 128 || typeof (input.password ?? '') !== 'string' || (input.password || '').length > 256 || /[\r\n]/.test(input.username)) throw fail('CAMERA_CREDENTIAL_INVALID');
      if (!keyStore) throw fail('KEY_STORE_UNAVAILABLE', 503);
      if (input.username) { keyStore.save('matadewa-cam-' + c.id.slice(4), JSON.stringify({ username: input.username, password: input.password || '' })); c.hasCredential = true; }
      else { keyStore.forget('matadewa-cam-' + c.id.slice(4)); c.hasCredential = false; }
      creds.delete(c.id);
    }
    if (!base) own.push(c);
    save(); return ownView(c);
  }

  // One frame from an RTSP camera via ffmpeg. Credentials never appear on ffmpeg's command line: when the camera has
  // credentials the full URL is written to a one-shot ffconcat file in the Owner's private profile folder (removed as
  // soon as ffmpeg exits) and ffmpeg reads it with the concat demuxer (-safe 0, protocol whitelist limited to RTSP); ffconcat `option` lines force TCP transport and the socket timeout.
  async function rtspFrame(c, cred) {
    if (!ffmpeg) throw fail('FFMPEG_NOT_FOUND', 503);
    const u = new URL(c.url), h = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(h) ? [h] : (await dns.promises.lookup(h, { all: true }).catch(() => { throw fail('EGRESS_NETWORK_ERROR', 502); })).map(a => a.address);
    if (!addrs.length || addrs.some(a => !addressCheck(a))) throw fail('EGRESS_PRIVATE_ADDRESS', 403);
    let input = ['-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', u.toString()], secretFile = null;
    if (cred) {
      u.username = encodeURIComponent(cred.username); u.password = encodeURIComponent(cred.password);
      const dir = path.join(profileDir, 'tmp'); fs.mkdirSync(dir, { recursive: true });
      secretFile = path.join(dir, 'rtsp-' + crypto.randomBytes(8).toString('hex') + '.ffconcat');
      fs.writeFileSync(secretFile, "ffconcat version 1.0\nfile '" + u.toString().replace(/'/g, '%27') + "'\noption rtsp_transport tcp\noption timeout 8000000\n", { mode: 0o600, flag: 'wx' });
      input = ['-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,rtsp,rtsps,rtp,tcp,udp,tls', '-i', secretFile];
    }
    const cleanup = () => { if (secretFile) try { fs.unlinkSync(secretFile); } catch {} secretFile = null; };
    return new Promise((resolve, reject) => {
      const p = spawnFn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...input, '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let n = 0;
      const timer = setTimeout(() => { p.kill(); cleanup(); reject(fail('EGRESS_TIMEOUT', 504)); }, 12000);
      p.stdout.on('data', d => { n += d.length; if (n > 4 * 1024 * 1024) { p.kill(); clearTimeout(timer); cleanup(); reject(fail('EGRESS_RESPONSE_TOO_LARGE', 502)); } else chunks.push(d); });
      p.on('error', () => { clearTimeout(timer); cleanup(); reject(fail('FFMPEG_FAILED', 502)); });
      p.on('close', code => { clearTimeout(timer); cleanup(); const b = Buffer.concat(chunks); code === 0 && b[0] === 0xff ? resolve(b) : reject(fail('CAMERA_NO_FRAME', 502)); });
    });
  }
  async function ownSnapshot(id, { maxAgeMs = 2000 } = {}) {
    const c = own.find(x => x.id === id); if (!c) throw fail('CAMERA_NOT_FOUND', 404);
    const hit = snaps.get('own|' + id); if (hit && now() - hit.at < maxAgeMs) return hit.jpeg;
    const cred = credential(c);
    let jpeg;
    try { jpeg = c.kind === 'rtsp' ? await rtspFrame(c, cred) : await fetchCamera(c.url, { ...(cred || {}), mjpeg: c.kind === 'mjpeg' }); }
    catch (e) { throw e.status ? e : fail(/^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'CAMERA_FAILED', 502); }
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw fail('CAMERA_NOT_JPEG', 502);
    snaps.set('own|' + id, { at: now(), jpeg });
    return jpeg;
  }

  return { PUBLIC_SOURCES, publicList, publicSnapshot, register, ownSnapshot, own: () => own.map(ownView), ffmpeg: () => !!ffmpeg };
}

module.exports = { createCameras, PUBLIC_SOURCES, findFfmpeg };
