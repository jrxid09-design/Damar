'use strict';
// Mata Dewa outbound boundary (Mata Dewa's own policy, independent of Core's general egress setting).
// Public feeds: HTTPS/443 only, exact-host allowlist (+ path prefix for shared hosts), resolved address must be public
// (anti DNS-rebinding), no redirect following, total deadline, streamed byte cap (also after gzip decoding).
// Owner cameras: only URLs the Owner registered (camera registry), http/https, LAN/private addresses allowed, loopback
// and link-local refused (protects Core itself and cloud metadata), same caps. Errors carry codes only.
const https = require('node:https'), http = require('node:http'), dns = require('node:dns'), net = require('node:net'), zlib = require('node:zlib'), crypto = require('node:crypto');

const HOSTS = Object.freeze([
  'earthquake.usgs.gov', 'api.open-meteo.com', 'air-quality-api.open-meteo.com', 'api.adsb.lol', 'celestrak.org', 'll.thespacedevs.com',
  'www.nhc.noaa.gov', 'opensky-network.org', 'auth.opensky-network.org', 'stream.aisstream.io', 'firms.modaps.eosdis.nasa.gov', 'api.tomtom.com',
  'api.tfl.gov.uk', 's3-eu-west-1.amazonaws.com', 'tie.digitraffic.fi', 'weathercam.digitraffic.fi',
  'api.met.no', 'www.gdacs.org', 'api.openaq.org',
]);
// Shared hosts are narrowed to the publisher's own path.
const PATH_PREFIX = Object.freeze({ 's3-eu-west-1.amazonaws.com': '/jamcams.tfl.gov.uk/' });
// Neutral product User-Agent; the Owner may append a contact URL in Control (mataDewa.contactUrl), empty by default.
const USER_AGENT = 'DAMAR/1.0';
const userAgent = contact => USER_AGENT + (contact ? ' (+' + contact + ')' : '');
const fail = code => Object.assign(Error(code), { code });

const v4 = ip => ip.split('.').map(Number);
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = v4(ip);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); if (mapped) return isPublicAddress(mapped[1]);
    return !(v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v));
  }
  return false;
}
// Owner cameras may live on the LAN, but never on loopback (Core itself), link-local (169.254/fe80, cloud metadata),
// unspecified or multicast addresses.
function isCameraAddress(ip) {
  if (net.isIPv4(ip)) { const [a, b] = v4(ip); return !(a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)); }
  if (net.isIPv6(ip)) { const v = ip.toLowerCase(); const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); if (m) return isCameraAddress(m[1]); return !(v === '::' || v === '::1' || /^fe[89ab]/.test(v) || /^ff/.test(v)); }
  return false;
}

const lookupWith = accept => (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || list.some(a => !accept(a.address))) return callback(fail('EGRESS_PRIVATE_ADDRESS'));
    callback(null, address, family);
  });
};
const guardedLookup = lookupWith(isPublicAddress);
const cameraLookup = lookupWith(isCameraAddress);

function checkUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw fail('EGRESS_URL_INVALID'); }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) throw fail('EGRESS_URL_REFUSED');
  if (!HOSTS.includes(u.hostname)) throw fail('EGRESS_HOST_NOT_ALLOWED');
  if (PATH_PREFIX[u.hostname] && !u.pathname.startsWith(PATH_PREFIX[u.hostname])) throw fail('EGRESS_PATH_NOT_ALLOWED');
  return u;
}
function checkCameraUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw fail('CAMERA_URL_INVALID'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw fail('CAMERA_URL_REFUSED');
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if ((net.isIP(h) && !isCameraAddress(h)) || /^localhost$/i.test(h)) throw fail('EGRESS_PRIVATE_ADDRESS');
  return u;
}

// One request with all caps. Shared by public feeds and Owner cameras (different URL/lookup policy).
function send(u, { timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, method = 'GET', headers = {}, body = null, binary = false, request, lookup, firstJpeg = false }) {
  return new Promise((resolve, reject) => {
    let done = false, req = null;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); if (err || firstJpeg) { try { req?.destroy(); } catch {} } if (err) reject(err.code && /^(EGRESS|UPSTREAM|CAMERA)_/.test(err.code) ? err : fail('EGRESS_NETWORK_ERROR')); else resolve(value); };
    const timer = setTimeout(() => finish(fail('EGRESS_TIMEOUT')), timeoutMs);
    try {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      req = request({ protocol: u.protocol, host, servername: net.isIP(host) ? undefined : host, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, lookup, agent: false,
        headers: { 'user-agent': USER_AGENT, accept: binary ? 'image/jpeg, image/*;q=0.8, */*;q=0.1' : 'application/json, text/plain;q=0.9, */*;q=0.1', 'accept-encoding': binary ? 'identity' : 'gzip', ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
        if (res.statusCode !== 200) {
          res.resume?.();
          const e = fail(res.statusCode >= 300 && res.statusCode < 400 ? 'UPSTREAM_REDIRECT_REFUSED' : res.statusCode === 401 || res.statusCode === 403 ? 'UPSTREAM_AUTH_REJECTED' : 'UPSTREAM_HTTP_' + (Number(res.statusCode) || 0));
          if (res.statusCode === 401) e.challenge = String(res.headers?.['www-authenticate'] || '').slice(0, 2000); // used by fetchCamera only
          return finish(e);
        }
        if (!firstJpeg && Number(res.headers?.['content-length']) > maxBytes) return finish(fail('EGRESS_RESPONSE_TOO_LARGE'));
        let stream = res;
        if (/gzip/i.test(res.headers?.['content-encoding'] || '')) { stream = res.pipe(zlib.createGunzip()); stream.on('error', () => finish(fail('UPSTREAM_MALFORMED'))); }
        const chunks = []; let n = 0;
        stream.on('data', c => {
          if (done) return; n += c.length; chunks.push(c);
          if (n > maxBytes) return finish(fail('EGRESS_RESPONSE_TOO_LARGE'));
          if (firstJpeg) { const buf = Buffer.concat(chunks), s = buf.indexOf(Buffer.from([0xff, 0xd8])), e = s >= 0 ? buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2) : -1; if (e > 0) finish(null, buf.subarray(s, e + 2)); }
        });
        stream.on('end', () => { if (firstJpeg) return finish(fail('CAMERA_NO_FRAME')); const buf = Buffer.concat(chunks); finish(null, binary ? buf : buf.toString('utf8')); });
        res.on('error', () => finish(fail('EGRESS_NETWORK_ERROR')));
      });
      req.on('error', e => finish(e && e.code === 'EGRESS_PRIVATE_ADDRESS' ? e : fail('EGRESS_NETWORK_ERROR')));
      req.end(body || undefined);
    } catch { finish(fail('EGRESS_NETWORK_ERROR')); }
  });
}

// Public allowlisted fetch. `request` is injectable for tests (no network in tests).
function fetchPublic(raw, opts = {}) {
  let u; try { u = checkUrl(raw); } catch (e) { return Promise.reject(e); }
  return send(u, { ...opts, request: opts.request || https.request, lookup: opts.lookup || guardedLookup });
}
// HTTP Digest (RFC 7616 / 2617): MD5, MD5-sess, SHA-256, SHA-256-sess; qop=auth or none.
function digestHeader(challenge, { username, password = '', method = 'GET', uri, cnonce = crypto.randomBytes(8).toString('hex') }) {
  const part = /Digest\s+(.*?)(?:,\s*(?:Basic|Bearer|Negotiate)\b|$)/is.exec(challenge); if (!part) return null;
  const p = {}; for (const m of part[1].matchAll(/([A-Za-z-]+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1].toLowerCase()] = m[2] ?? m[3];
  if (!p.realm || !p.nonce) return null;
  const alg = (p.algorithm || 'MD5').toUpperCase(), hashName = alg.startsWith('SHA-256') ? 'sha256' : alg.startsWith('MD5') ? 'md5' : null; if (!hashName) return null;
  const H = x => crypto.createHash(hashName).update(x).digest('hex');
  let ha1 = H(`${username}:${p.realm}:${password}`); if (alg.endsWith('-SESS')) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`), qop = (p.qop || '').split(',').map(x => x.trim()).includes('auth') ? 'auth' : null, nc = '00000001';
  const response = qop ? H(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${p.nonce}:${ha2}`);
  const q2 = v => String(v).replace(/[\\"\r\n]/g, '');
  return 'Digest ' + [`username="${q2(username)}"`, `realm="${q2(p.realm)}"`, `nonce="${q2(p.nonce)}"`, `uri="${q2(uri)}"`, `algorithm=${q2(p.algorithm || 'MD5')}`, `response="${response}"`,
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []), ...(p.opaque !== undefined ? [`opaque="${q2(p.opaque)}"`] : [])].join(', ');
}

// Owner-registered camera fetch (snapshot JPEG or first MJPEG frame). Credentials are sent only after the camera
// challenges (401): Digest when offered, else Basic. Never in the URL.
async function fetchCamera(raw, { username, password, mjpeg = false, ...opts } = {}) {
  const u = checkCameraUrl(raw);
  const base = { timeoutMs: 8000, maxBytes: 4 * 1024 * 1024, ...opts, binary: true, firstJpeg: mjpeg,
    request: opts.request || (u.protocol === 'https:' ? https.request : http.request), lookup: opts.lookup || cameraLookup };
  try { return await send(u, { ...base, headers: {} }); }
  catch (e) {
    if (e.code !== 'UPSTREAM_AUTH_REJECTED' || !username || !e.challenge) throw e;
    const auth = /\bDigest\s/i.test(e.challenge) ? digestHeader(e.challenge, { username, password, uri: u.pathname + u.search })
      : /^\s*Basic\b/i.test(e.challenge) ? 'Basic ' + Buffer.from(username + ':' + (password || '')).toString('base64') : null;
    if (!auth) throw e;
    return send(u, { ...base, headers: { authorization: auth } });
  }
}

module.exports = { HOSTS, PATH_PREFIX, USER_AGENT, userAgent, fetchPublic, fetchCamera, isPublicAddress, isCameraAddress, digestHeader, guardedLookup, cameraLookup, checkUrl, checkCameraUrl };
