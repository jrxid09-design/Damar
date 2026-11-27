'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { projectControl } = require('./controlProjection');

function createProductSurfaces({ root, snapshot }) {
  const files = new Map([
    ['/cc2', ['cc2/output/damar_control_center.html', 'control']],
    ['/s/idle_presence', ['ui-surfaces/w5/idle_present.html', 'presence']],
    ['/mobile', ['ui-surfaces/mobile/mobile.html', 'mobile']],
    ['/__preview-adapters/damar-island-fsm.js', ['ui-surfaces/w5/damar-island-fsm.js']],
    ['/__preview-adapters/argon-character-engine.js', ['ui-surfaces/w5/argon-character-engine.js']],
    ['/__preview-adapters/r5-control.js', ['scripts/preview-adapters/r5-control.js']],
    ...['damar-island.js', 'mobile-island.js', 'idle-presence.js', 'mobile.js'].map(name => [`/__preview-adapters/${name}`, [`scripts/preview-adapters/${name}`]])
  ]);
  return (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return false; }
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (url.pathname === '/api/r5/control-state') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(projectControl(snapshot()))); return true;
    }
    let entry = files.get(url.pathname);
    // Private source testing only. Packaging must omit these restricted assets.
    if (!entry && url.pathname.startsWith('/__preview-adapters/argon-assets/')) {
      const relative = url.pathname.slice('/__preview-adapters/argon-assets/'.length);
      if (relative.split('/').some(part => part === '..' || part.includes('\\'))) return false;
      entry = [`ui-surfaces/w5/third_party/argon-damar/${relative}`];
    }
    if (url.pathname === '/s/damaricon-clean.PNG') entry = ['ui-surfaces/w5/damaricon-clean.png'];
    if (!entry) return false;
    const file = path.resolve(root, entry[0]);
    if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.PNG': 'image/png' };
    let content = fs.readFileSync(file);
    if (entry[1]) {
      const scripts = entry[1] === 'control' ? ['r5-control.js'] : entry[1] === 'presence'
        ? ['damar-island-fsm.js', 'argon-character-engine.js', 'damar-island.js', 'idle-presence.js']
        : ['damar-island-fsm.js', 'mobile-island.js', 'mobile.js'];
      content = Buffer.from(content.toString('utf8').replace(/<\/body\s*>/i,
        scripts.map(name => `<script src="/__preview-adapters/${name}" defer></script>`).join('') + '</body>'));
    }
    res.writeHead(200, { ...headers, 'content-type': types[ext] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : content);
    return true;
  };
}

module.exports = { createProductSurfaces };
