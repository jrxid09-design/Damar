'use strict';
// Fixed allowlist of renderer files served on the private damar-presence:// scheme. The Owner page
// (renderer/idle_present.html) is C/ui-prototypes/w5/idle_present.html (sha 574d3cae...) with only the hard-coded personal
// name removed (the greeting comes from Core presence.displayName) and the retired CC2 link pointed at DAMAR Control; the product scripts are
// appended before </body> at serve time, exactly as the prototype server injected its adapters.
const fs = require('node:fs'), path = require('node:path');

const ROOT = path.join(__dirname, 'renderer');
const SCHEME = 'damar-presence';
const ENTRY = `${SCHEME}://app/idle_present`;
const OWNER_SHA256 = 'e7d6b92116d420d26cc83c5f6de073419004da78eef3c095c6c03ddb0b8bc815';
const INJECT = ['presence-i18n.js', 'damar-island-fsm.js', 'argon-character-engine.js', 'vendor/three.min.js', 'vendor/GLTFLoader.js', 'vendor/SkeletonUtils.js', 'damar-notch-3d.js', 'damar-notch-behavior.js', 'damar-island.js', 'damar-notch-moci.js', 'presence-adapter.js']
  .map(f => `<script src="/${f}" defer></script>`).join('');
const FILES = Object.freeze({
  '/damar-island-fsm.js': 'damar-island-fsm.js', '/argon-character-engine.js': 'argon-character-engine.js',
  '/damar-island.js': 'damar-island.js', '/damar-notch-character.js': 'damar-notch-character.js', '/presence-adapter.js': 'presence-adapter.js', '/presence-i18n.js': 'presence-i18n.js', '/damar-notch-behavior.js': 'damar-notch-behavior.js', '/damar-notch-rig-data.js': 'damar-notch-rig-data.js',
  // Damar Notch 3D stage (feat/notch-3d-base): vendored three.js r147 (MIT, see THIRD_PARTY_NOTICES.md) +
  // the stage module + the Owner's base model. The GLB route names the asset on the allowlist; the sandboxed
  // renderer itself receives the bytes over the IPC bridge (scheme fetch is disabled by design).
  '/vendor/three.min.js': 'vendor/three.min.js', '/vendor/GLTFLoader.js': 'vendor/GLTFLoader.js', '/vendor/SkeletonUtils.js': 'vendor/SkeletonUtils.js', '/damar-notch-3d.js': 'damar-notch-3d.js',
  // Interim 2D character (Owner-supplied Moci, 2026-11-25): registers itself with the island slot.
  '/damar-notch-moci.js': 'damar-notch-moci.js',
  '/notch-3d/damar-notch-base-3d.glb': 'argon-assets/visuals/notch-3d/damar-notch-base-3d.glb',
  // Damar Notch v3 sprite stage (approved glossy art, WebP).
  '/notch-v3/expr-happy.webp': 'argon-assets/visuals/notch-v3/expr-happy.webp', '/notch-v3/expr-alert.webp': 'argon-assets/visuals/notch-v3/expr-alert.webp', '/notch-v3/expr-thinking.webp': 'argon-assets/visuals/notch-v3/expr-thinking.webp', '/notch-v3/expr-recovering.webp': 'argon-assets/visuals/notch-v3/expr-recovering.webp', '/notch-v3/expr-surprised.webp': 'argon-assets/visuals/notch-v3/expr-surprised.webp',
  '/notch-v3/costume-chef.webp': 'argon-assets/visuals/notch-v3/costume-chef.webp', '/notch-v3/costume-hacker.webp': 'argon-assets/visuals/notch-v3/costume-hacker.webp', '/notch-v3/costume-engineer.webp': 'argon-assets/visuals/notch-v3/costume-engineer.webp', '/notch-v3/costume-detective.webp': 'argon-assets/visuals/notch-v3/costume-detective.webp', '/notch-v3/costume-artist.webp': 'argon-assets/visuals/notch-v3/costume-artist.webp', '/notch-v3/costume-matadewa.webp': 'argon-assets/visuals/notch-v3/costume-matadewa.webp',
  // Cinzel / Cinzel Decorative bundled locally (SIL OFL 1.1, licenses next to the fonts) instead of Google Fonts.
  '/fonts/Cinzel-VariableFont_wght.ttf': 'fonts/Cinzel-VariableFont_wght.ttf', '/fonts/CinzelDecorative-Bold.ttf': 'fonts/CinzelDecorative-Bold.ttf',
  '/damaricon-clean.PNG': 'damaricon-clean.png', '/damaricon-clean.png': 'damaricon-clean.png',
});
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.ttf': 'font/ttf', '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.glb': 'model/gltf-binary' };
// No network from the renderer: all Core data arrives over the allowlisted IPC bridge. The Owner page's own Google
// Fonts <link> is blocked here on purpose (privacy/offline); the same families are served from /fonts.
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
const HEADERS = Object.freeze({ 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });

function ownerPage() { return fs.readFileSync(path.join(ROOT, 'idle_present.html'), 'utf8').replace(/<\/body\s*>/i, `${INJECT}</body>`); }

// Returns { status, type, body } for a damar-presence:// URL; anything off the allowlist is 404.
function resolve(rawUrl) {
  let url; try { url = new URL(rawUrl); } catch { return { status: 400 }; }
  if (url.protocol !== SCHEME + ':' || url.host !== 'app' || url.search || url.username) return { status: 404 };
  if (url.pathname === '/idle_present') return { status: 200, type: TYPES['.html'], body: Buffer.from(ownerPage(), 'utf8') };
  let file = FILES[url.pathname];
  // The character engine loads its approved sprite from the prototype's absolute path; map it to the local copy.
  const asset = /^\/__preview-adapters\/argon-assets\/(visuals\/[a-z0-9_]+\.png)$/.exec(url.pathname);
  if (!file && asset) file = path.join('argon-assets', asset[1]);
  // Damar Notch rig parts (NOTCH-RIG-HIDUP): /notch-rig/<key>/<part>.webp -
  // strict character classes only, so no traversal or arbitrary file reads.
  const rig = /^\/notch-rig\/([a-z]+)\/([a-z0-9_-]+\.webp)$/.exec(url.pathname);
  if (!file && rig) file = path.join('argon-assets', 'visuals', 'notch-rig', rig[1], rig[2]);
  if (!file) return { status: 404 };
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT + path.sep) || !fs.existsSync(full)) return { status: 404 };
  return { status: 200, type: TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', body: fs.readFileSync(full) };
}

module.exports = { resolve, ownerPage, SCHEME, ENTRY, CSP, HEADERS, INJECT, ROOT, OWNER_SHA256 };
