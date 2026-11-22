'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createProductSurfaces } = require('../r5/productSurfaces');
function createSurfaces(root) {
  const legacy = createProductSurfaces({ root, snapshot() { throw Error('R5_STATE_NOT_ACTIVE'); } });
  return (req, res) => {
    if (req.url?.startsWith('/api/r5/')) return false;
    const url = new URL(req.url, 'http://127.0.0.1');
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (req.method === 'GET' && url.pathname === '/cc2') {
      const html = fs.readFileSync(path.join(root, 'cc2/output/damar_control_center.html'), 'utf8');
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(html.replace(/<\/body>/i, '<script src="/__r6/control.js" defer></script></body>')); return true;
    }
    if (req.method === 'GET' && url.pathname === '/__r6/control.js') {
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript' });
      res.end(fs.readFileSync(path.join(root, 'scripts/preview-adapters/r6-control.js'))); return true;
    }
    return legacy(req, res);
  };
}
module.exports = { createSurfaces };
