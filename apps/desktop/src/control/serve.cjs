'use strict';
// DAMAR Control static surface, served by Core itself on its loopback origin at /control/.
// Only a fixed allowlist of non-secret files is served; every Core datum the page shows comes from the
// existing bearer-authenticated /api/r9/* and /api/v1/console/* routes (same origin, so Core's ORIGIN check holds).
// The page never receives a credential from this handler: the Owner launcher passes it in the URL fragment.
const fs = require('node:fs'), path = require('node:path');

const FILES = Object.freeze({
  '/control/': ['index.html', 'text/html; charset=utf-8'],
  '/control/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/control/control.css': ['control.css', 'text/css; charset=utf-8'],
  '/control/control.js': ['control.js', 'text/javascript; charset=utf-8'],
  '/control/support-links.js': ['support-links.js', 'text/javascript; charset=utf-8'],
  '/control/damaricon-clean.png': ['damaricon-clean.png', 'image/png'],
});
const HEADERS = Object.freeze({
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
  // Inline style attributes are part of the frozen prototype markup; scripts are same-origin files only.
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

const VIEW = /^\/control\/views\/([a-z][a-z0-9-]{1,30})\.js$/;
const viewList = () => { try { return fs.readdirSync(path.join(__dirname, 'views'), { withFileTypes: true }).filter(e => e.isFile() && /^[a-z][a-z0-9-]{1,30}\.js$/.test(e.name)).map(e => e.name.slice(0, -3)).sort(); } catch { return []; } };
const isControlPath = pathname => pathname === '/control' || pathname.startsWith('/control/');

function serveControl(req, res, url) {
  const host = `127.0.0.1:${req.socket.localPort}`;
  const deny = (status, error) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ success: false, error })); };
  // Same loopback/DNS-rebinding guard as the Core API routes.
  if (req.socket.localAddress !== '127.0.0.1' || req.headers.host !== host || req.headers['sec-fetch-site'] === 'cross-site') return deny(403, 'ORIGIN_DENIED');
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'READ_ONLY_ROUTE');
  if (url.pathname === '/control') { res.writeHead(308, { location: '/control/', 'cache-control': 'no-store' }); return res.end(); }
  // Separately shipped views: src/control/views/<name>.js (plain files only), loaded after control.js.
  const view = url.search ? null : VIEW.exec(url.pathname);
  const entry = url.search ? null : view ? ['views/' + view[1] + '.js', 'text/javascript; charset=utf-8'] : FILES[url.pathname];
  if (!entry) return deny(404, 'NOT_FOUND');
  let bytes;
  try {
    const file = path.join(__dirname, entry[0]);
    if (view && !fs.lstatSync(file).isFile()) throw 0;
    bytes = fs.readFileSync(file);
    if (entry[0] === 'index.html') bytes = Buffer.from(bytes.toString('utf8').replace('</body>', viewList().map(n => `  <script src="views/${n}.js"></script>
`).join('') + '</body>'));
  } catch { return deny(404, 'NOT_FOUND'); }
  res.writeHead(200, { ...HEADERS, 'content-type': entry[1], 'content-length': bytes.length });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

module.exports = { serveControl, isControlPath, FILES };
