'use strict';
// Builds core-snapshot/: a hash-pinned copy of canonical Damar src plus ONLY the node_modules packages the
// isolated Core host actually loads (from require traces). Removes the runtime dependency on mutable
// canonical node_modules. Canonical is read only.
//   node scripts/build-core-snapshot.cjs src
//   node scripts/build-core-snapshot.cjs modules <trace.json>...
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { hashTree } = require('../src/core-host/core-host.cjs');
// This script lives in apps/desktop/scripts; the canonical source is at repo src/.
const CANONICAL = path.resolve(__dirname, '../../..');
const OUT = path.join(__dirname, '../core-snapshot');
const MANIFEST = path.join(OUT, 'SNAPSHOT_MANIFEST.json');
const aggregate = files => crypto.createHash('sha256').update(files.map(f => `${f.path}|${f.bytes}|${f.sha256}`).join('\n')).digest('hex');
const [phase, ...traces] = process.argv.slice(2);

if (phase === 'src') {
  if (!fs.existsSync(path.join(CANONICAL, 'src'))) throw Error('REPO_SRC_MISSING: use the pinned core-snapshot');
  if (fs.existsSync(OUT)) throw Error('SNAPSHOT_EXISTS');
  fs.mkdirSync(OUT);
  fs.cpSync(path.join(CANONICAL, 'src'), path.join(OUT, 'src'), { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(CANONICAL, f), path.join(OUT, f));
  const canonical = hashTree(path.join(CANONICAL, 'src')), src = hashTree(path.join(OUT, 'src'));
  if (aggregate(canonical) !== aggregate(src)) throw Error('SNAPSHOT_COPY_MISMATCH');
  const lock = fs.readFileSync(path.join(OUT, 'package-lock.json'));
  fs.writeFileSync(MANIFEST, JSON.stringify({ createdUtc: new Date().toISOString(), canonicalSource: { root: 'canonical-damar', srcAggregate: aggregate(canonical) }, packageLockSha256: crypto.createHash('sha256').update(lock).digest('hex'), src: { count: src.length, aggregate: aggregate(src), files: src }, modules: null }, null, 1));
  console.log(JSON.stringify({ phase, files: src.length, aggregate: aggregate(src) }));
} else if (phase === 'modules') {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.modules) throw Error('MODULES_ALREADY_PINNED');
  const root = path.resolve(CANONICAL, 'node_modules');
  const packages = new Set();
  for (const t of traces) for (const file of JSON.parse(fs.readFileSync(t, 'utf8'))) {
    const rel = path.relative(root, path.resolve(file));
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // not from canonical node_modules
    const parts = rel.split(path.sep);
    packages.add(parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  const dest = path.join(OUT, 'node_modules');
  fs.mkdirSync(dest);
  const rows = [];
  for (const name of [...packages].sort()) {
    fs.cpSync(path.join(root, name), path.join(dest, name), { recursive: true, errorOnExist: true, dereference: false, verbatimSymlinks: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(dest, name, 'package.json'), 'utf8'));
    rows.push({ name, version: pkg.version, license: pkg.license ?? null });
  }
  const files = hashTree(dest);
  manifest.modules = { source: 'canonical node_modules subset from require traces', traces: traces.length, packages: rows, count: files.length, aggregate: aggregate(files), files };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ phase, packages: rows.length, files: files.length, aggregate: manifest.modules.aggregate, bytes: files.reduce((n, f) => n + f.bytes, 0) }));
} else if (phase === 'scrub') {
  // Release scrub (run after `src`): removes references to the Owner's private local router from snapshot text
  // (comments and one UI hint). Deterministic and idempotent; the manifest's src pin is recomputed and every changed
  // file is recorded with its canonical and scrubbed hash, so the pin stays consistent and the deviation is auditable.
  const RULES = [[/OpenCode\/9router deepseek-v4\.1-flash/g, 'independent model review'], [/\b(?:9router|ninerouter)\b/gi, 'local router'],
    [/(127\.0\.0\.1|localhost):20127/g, '$1:<port>'], [/\bgpt-6-luna\b/g, '<model>'],
    // Personal paths and URLs (developer machine, GitHub account): one User-Agent, repository URLs, comment paths.
    [/damar-mata-dewa\/1\.0 \(\+https:\/\/github\.com\/jrxid09-design\/Aether\)/g, 'DAMAR/1.0'],
    [/(?:git\+)?https:\/\/github\.com\/jrxid09-design\/Aether(?:\.git)?/g, 'https://github.com/REPLACE-ME/damar'],
    [/C:\\Workspace\\Damar-audit-evidence\\[^\s*]*/g, 'the internal audit evidence (not shipped)'],
    [/C:\\Workspace\\Aether/g, 'C:\\Projects\\Example'], [/\/mnt\/c\/Workspace\/Aether/g, '/mnt/c/Projects/Example'],
    [/C:\\Users\\\.\.\./g, 'C:\\Data\\...'], [/C:\/Users\/\.\.\./g, 'C:/Data/...']];
  // package.json is not in the src pin: its repository URLs become the placeholder, or DAMAR_REPO_URL when set.
  const repo = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(process.env.DAMAR_REPO_URL || '') ? process.env.DAMAR_REPO_URL : 'https://github.com/REPLACE-ME/damar';
  const pkgFile = path.join(OUT, 'package.json'), pkg = fs.readFileSync(pkgFile, 'utf8');
  const pkgAfter = RULES.reduce((s, [re, to]) => s.replace(re, to), pkg).split('https://github.com/REPLACE-ME/damar').join(repo);
  if (pkgAfter !== pkg) fs.writeFileSync(pkgFile, pkgAfter);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (/^[A-Za-z]:[\\/]/.test(manifest.canonicalSource?.root || '')) manifest.canonicalSource.root = 'canonical-damar';   // no developer path
  const scrubbed = manifest.scrubbed || [];
  for (const f of manifest.src.files) {
    const file = path.join(OUT, 'src', f.path), before = fs.readFileSync(file, 'utf8');
    const after = RULES.reduce((s, [re, to]) => s.replace(re, to), before);
    if (after === before) continue;
    fs.writeFileSync(file, after);
    const prior = scrubbed.find(x => x.path === f.path);
    const row = { path: f.path, canonicalSha256: prior?.canonicalSha256 || f.sha256, sha256: crypto.createHash('sha256').update(after).digest('hex') };
    if (prior) Object.assign(prior, row); else scrubbed.push(row);
  }
  const src = hashTree(path.join(OUT, 'src'));
  manifest.src = { count: src.length, aggregate: aggregate(src), files: src };
  manifest.scrubbed = scrubbed.sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ phase, scrubbed: manifest.scrubbed.map(x => x.path), aggregate: manifest.src.aggregate }));
} else throw Error('USAGE: src | modules <trace.json>... | scrub');
