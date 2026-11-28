'use strict';
// Pusat Kapabilitas management binding (Owner order 2026-11-27: the capability
// center must not stay read-only). Composition only: every operation binds the
// ONE canonical owner of its kind that already lives in this Core process:
//   MCP client servers : src/mcp/configStore.js (the registry file) plus
//                        src/mcp/mcpClientManager.js (the runtime), started
//                        with the same canonical actuator the damar.mcp
//                        embodiment driver passes (node:child_process spawn).
//   Plugins            : src/plugins/pluginLoader.js (loadOne / unloadPlugin;
//                        manifest validation is the loader's own loadManifest,
//                        which runs pluginValidator).
//   Skills             : the Core profile skills directory that
//                        core-settings.cjs reads (the settings file's sibling
//                        "skills" folder). Enable/disable stays on the existing
//                        core-settings update path used by Control Settings.
// No second registry, engine or store is created here, and no write bypasses
// the Owner-only r9 layer: these functions are only reachable through the
// Owner-gated /api/r9/kapabilitas routes.
// Honest limits of the canonical backends, surfaced rather than papered over:
//   - The MCP registry is stdio-only (id, command, args, env, cwd,
//     allowedTools). There is no URL/HTTP transport and no headers field.
//   - MCP entries carry no enabled flag and the manager starts every
//     configured server, so there is no MCP enable/disable: removal is the
//     only off state.
//   - Plugin disable is the loader's live unload; the folder stays installed
//     and the plugin loads again at the next Core boot. Removal deletes it.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const fail = (status, error) => Object.assign(Error(error), { status });
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/; // same skill-name rule core-settings.cjs applies
const MAX_FILES = 256, MAX_BYTES = 16 * 1024 * 1024;

function frontMatter(text) { // mirrors core-settings.cjs frontMatter()
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text); if (!m) return null;
  const meta = {}; for (const line of m[1].split(/\r?\n/)) { const kv = /^([a-z]+):\s*(.*)$/i.exec(line.trim()); if (kv) meta[kv[1].toLowerCase()] = kv[2].trim(); }
  return { meta, body: m[2] };
}

// Bounded recursive copy: links of any kind are refused, so an install can
// never smuggle a junction or symlink into a loader-read directory.
function copyTree(src, dest) {
  let files = 0, bytes = 0;
  const walk = (from, to) => {
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) throw fail(400, 'Folder sumber berisi tautan (symlink/junction) dan ditolak.');
    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) walk(path.join(from, name), path.join(to, name));
      return;
    }
    if (!st.isFile()) throw fail(400, 'Folder sumber berisi entri yang tidak didukung dan ditolak.');
    files++; bytes += st.size;
    if (files > MAX_FILES || bytes > MAX_BYTES) throw fail(400, 'Paket terlalu besar untuk dipasang (maks 256 berkas, 16 MB).');
    fs.copyFileSync(from, to);
  };
  walk(src, dest);
  return { files, bytes };
}

// Minimal zip reader (store + deflate) with traversal guards; enough for
// plugin and skill packages without adding a dependency to the product.
function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw fail(400, 'Berkas zip tidak valid (direktori pusat tidak ditemukan).');
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw fail(400, 'Zip berisi terlalu banyak berkas (maks 256).');
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw fail(400, 'Berkas zip tidak valid.');
    const method = buf.readUInt16LE(off + 10), compSize = buf.readUInt32LE(off + 20), rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (compSize === 0xffffffff || rawSize === 0xffffffff) throw fail(400, 'Zip64 tidak didukung.');
    const clean = name.replace(/\\/g, '/');
    if (!clean || clean.endsWith('/')) continue;
    if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').includes('..')) throw fail(400, 'Zip berisi jalur yang ditolak: ' + clean.slice(0, 80));
    total += rawSize; if (total > MAX_BYTES) throw fail(400, 'Isi zip terlalu besar (maks 16 MB).');
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw fail(400, 'Berkas zip tidak valid.');
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const comp = buf.subarray(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) { try { data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_BYTES }); } catch { throw fail(400, 'Zip rusak pada entri: ' + clean.slice(0, 80)); } }
    else throw fail(400, 'Metode kompresi zip tidak didukung: ' + method);
    const target = path.join(destDir, ...clean.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

// A staged package may sit at the root or inside a single wrapper folder.
function packageRoot(stageDir, markerFile) {
  if (fs.existsSync(path.join(stageDir, markerFile))) return stageDir;
  const dirs = fs.readdirSync(stageDir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.'));
  if (dirs.length === 1 && fs.existsSync(path.join(stageDir, dirs[0].name, markerFile))) return path.join(stageDir, dirs[0].name);
  return null;
}

function createKapabilitasBinding({ copyRoot, settingsFile, settings }) {
  // Canonical modules are required lazily from this session's canonical copy,
  // so the binding composes the exact singletons the canonical app uses.
  const lazy = {};
  const mod = name => lazy[name] || (lazy[name] = require(path.join(copyRoot, 'src', ...name.split('/'))));
  const configStore = () => mod('mcp/configStore.js');
  const manager = () => mod('mcp/mcpClientManager.js');
  const skillsDir = path.join(path.dirname(settingsFile), 'skills');

  async function restartMcp() {
    await manager().restart({ spawnProcess: spawn });
    try { const rt = mod('services/aiRuntimeService.js'); if (typeof rt.refreshTools === 'function') rt.refreshTools(); } catch { /* registry refresh is best-effort; the manager state above is the truth */ }
  }

  function mcpState() {
    const file = manager().configFile;
    const configured = configStore().read(file);
    const servers = configured.map(cfg => {
      const client = manager().clients.get(cfg.id);
      return { id: cfg.id, command: cfg.command, args: Array.isArray(cfg.args) ? cfg.args : [], cwd: cfg.cwd || null,
        envKeys: cfg.env && typeof cfg.env === 'object' ? Object.keys(cfg.env) : [], allowedTools: Array.isArray(cfg.allowedTools) ? cfg.allowedTools : null,
        running: !!client?._ready, tools: client ? client._tools.map(t => t.name) : [], lastError: client?.lastError ?? null };
    });
    return { file, servers };
  }

  function pluginState() {
    const loader = mod('plugins/pluginLoader.js'), registry = mod('plugins/pluginRegistry.js');
    const loaded = new Map(); // id -> { source, path, toolIds }
    try { for (const [id, rec] of loader.loaded) loaded.set(id, rec); } catch { /* older loader shape: registry only */ }
    const items = registry.describe().map(d => { const rec = loaded.get(d.id); return { ...d, loaded: true, source: rec?.source || 'builtin', folder: rec?.path ? path.basename(rec.path) : null }; });
    const seen = new Set(items.map(i => i.id));
    const userRoot = loader.userRoot;
    let folders = [];
    try { folders = fs.readdirSync(userRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch { /* no user root yet */ }
    for (const folder of folders) {
      const dir = path.join(userRoot, folder);
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
      let manifest = null, error = null;
      try { manifest = loader.loadManifest(dir); } catch (e) { error = e.message; }
      if (manifest && seen.has(manifest.id)) { const it = items.find(i => i.id === manifest.id); if (it && !it.folder) it.folder = folder; continue; }
      items.push({ id: manifest?.id || null, name: manifest?.name || folder, version: manifest?.version || null, description: manifest?.description || '', category: manifest?.category || 'general', permissions: manifest?.permissions || [], toolCount: 0, loaded: false, source: 'user', folder, valid: !!manifest, error });
    }
    return { userRoot, items };
  }

  function skillState() {
    const listed = new Map();
    try { for (const s of settings.skills(null)) listed.set(s.name, s); } catch { /* settings read is best-effort */ }
    let folders = [];
    try { folders = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && NAME.test(e.name)).map(e => e.name); } catch { /* no profile skills yet */ }
    const items = folders.map(name => {
      const row = listed.get(name);
      let valid = false, error = null;
      try { const fm = frontMatter(fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8').slice(0, 16384)); valid = !!fm; if (!fm) error = 'SKILL.md tidak memiliki front matter yang terbaca.'; }
      catch (e) { error = e.code === 'ENOENT' ? 'SKILL.md tidak ada.' : e.message; }
      return { name, source: 'profile', description: row?.description || '', triggers: row?.triggers || [], enabled: row ? row.enabled : !settings.view().skills.disabled.includes(name), valid, error };
    });
    return { dir: skillsDir, items };
  }

  function stageDir(root) { const d = path.join(root, '.kapabilitas-stage-' + crypto.randomBytes(6).toString('hex')); fs.mkdirSync(d, { recursive: true }); return d; }

  async function stagePackage(root, input, markerFile) {
    const source = input?.source, where = String(input?.path || '').trim();
    if (!['folder', 'zip', 'git'].includes(source) || !where) throw fail(400, 'Sumber paket tidak lengkap.');
    const stage = stageDir(root);
    try {
      if (source === 'folder') {
        if (!path.isAbsolute(where) || !fs.existsSync(where) || !fs.statSync(where).isDirectory()) throw fail(400, 'Folder sumber tidak ditemukan.');
        copyTree(where, stage);
      } else if (source === 'zip') {
        if (!path.isAbsolute(where) || !fs.existsSync(where) || !/\.zip$/i.test(where)) throw fail(400, 'Berkas zip tidak ditemukan.');
        extractZip(where, stage);
      } else {
        if (!/^https:\/\/[^\s]+$/.test(where) && !/^git@[^\s]+$/.test(where)) throw fail(400, 'URL git harus berbentuk https:// atau git@.');
        await new Promise((resolve, reject) => execFile('git', ['clone', '--depth', '1', '--', where, stage], { timeout: 120000, windowsHide: true }, e => e ? reject(fail(400, 'git clone gagal: ' + String(e.message).slice(0, 200))) : resolve()));
        fs.rmSync(path.join(stage, '.git'), { recursive: true, force: true });
      }
      const root2 = packageRoot(stage, markerFile);
      if (!root2) throw fail(400, 'Paket tidak berisi ' + markerFile + ' di akar atau dalam satu folder pembungkus.');
      return { stage, root: root2 };
    } catch (e) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* staging cleanup is best-effort */ } throw e; }
  }

  return {
    state: () => ({ mcp: mcpState(), plugins: pluginState(), skills: skillState() }),

    // Connection test: a throwaway client performs the real MCP handshake and
    // tool listing with the candidate entry, then stops. Nothing is saved and
    // the running manager is not touched.
    async mcpTest(input) {
      let entry; try { entry = configStore().normalize(input || {}); } catch (e) { throw fail(400, e.message); }
      const { McpClient } = mod('mcp/mcpClient.js');
      const client = new McpClient({ id: entry.id, command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd, allowedTools: entry.allowedTools ? new Set(entry.allowedTools) : null, spawnProcess: spawn });
      const t0 = Date.now();
      try { const tools = await client.start({ timeout: 15000 }); return { ok: true, id: entry.id, tools: tools.map(t => t.name), latencyMs: Date.now() - t0 }; }
      catch (e) { return { ok: false, id: entry.id, error: String(client.lastError || e.message || e).slice(0, 300) }; }
      finally { await client.stop().catch(() => {}); }
    },

    async mcpSave(input) {
      let entry; try { entry = configStore().normalize(input || {}); } catch (e) { throw fail(400, e.message); }
      configStore().upsert(entry, manager().configFile);
      await restartMcp();
      return { saved: entry.id, mcp: mcpState() };
    },

    async mcpRemove(id) {
      if (typeof id !== 'string' || !id) throw fail(400, 'ID server tidak valid.');
      if (!configStore().remove(id, manager().configFile)) throw fail(404, 'Server MCP tidak ditemukan di registry.');
      await restartMcp();
      return { removed: id, mcp: mcpState() };
    },

    async pluginInstall(input) {
      const loader = mod('plugins/pluginLoader.js');
      const userRoot = loader.userRoot;
      fs.mkdirSync(userRoot, { recursive: true });
      const { stage, root } = await stagePackage(userRoot, input, 'manifest.json');
      try {
        let manifest; try { manifest = loader.loadManifest(root); } catch (e) { throw fail(400, 'Manifest plugin tidak valid: ' + e.message); }
        const folder = path.basename(root) === path.basename(stage) ? manifest.id : path.basename(root);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(folder)) throw fail(400, 'Nama folder plugin tidak valid.');
        const target = path.join(userRoot, folder);
        if (fs.existsSync(target)) throw fail(409, 'Sudah ada plugin pada folder "' + folder + '". Hapus yang lama dulu bila ingin menggantinya.');
        copyTree(root, target);
        const result = loader.loadOne(target, 'user');
        if (!result?.ok) { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* rollback is best-effort */ } throw fail(400, 'Loader menolak plugin ini: ' + String(result?.error || 'alasan tidak tercatat').slice(0, 300)); }
        return { installed: result.id, folder, tools: result.tools ?? 0, plugins: pluginState() };
      } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* staging cleanup is best-effort */ } }
    },

    async pluginSetEnabled(id, enabled) {
      const loader = mod('plugins/pluginLoader.js');
      const rec = (() => { try { return loader.loaded.get(id); } catch { return null; } })();
      if (rec && rec.source !== 'user') throw fail(400, 'Plugin bawaan Core tidak bisa dinonaktifkan dari sini.');
      if (!enabled) { if (!loader.unloadPlugin(id)) throw fail(404, 'Plugin tidak sedang dimuat.'); return { id, enabled: false, plugins: pluginState() }; }
      if (rec) return { id, enabled: true, plugins: pluginState() };
      const st = pluginState();
      const item = st.items.find(i => i.id === id && i.source === 'user');
      if (!item?.folder) throw fail(404, 'Plugin pengguna dengan id ini tidak ditemukan.');
      if (item.valid === false) throw fail(400, 'Manifest plugin tidak valid: ' + String(item.error || '').slice(0, 200));
      const result = loader.loadOne(path.join(st.userRoot, item.folder), 'user');
      if (!result?.ok) throw fail(400, 'Loader menolak plugin ini: ' + String(result?.error || 'alasan tidak tercatat').slice(0, 300));
      return { id, enabled: true, plugins: pluginState() };
    },

    async pluginRemove(id) {
      const loader = mod('plugins/pluginLoader.js');
      const st = pluginState();
      const item = st.items.find(i => i.id === id && i.source === 'user');
      if (!item?.folder) throw fail(404, 'Plugin ini bukan plugin pengguna yang terpasang; plugin bawaan tidak bisa dihapus dari sini.');
      try { loader.unloadPlugin(id); } catch { /* unload before delete is best-effort */ }
      fs.rmSync(path.join(st.userRoot, item.folder), { recursive: true, force: true });
      return { removed: id, plugins: pluginState() };
    },

    async skillImport(input) {
      fs.mkdirSync(skillsDir, { recursive: true });
      const { stage, root } = await stagePackage(skillsDir, { ...input, source: input?.source === 'zip' ? 'zip' : 'folder' }, 'SKILL.md');
      try {
        let fm = null; try { fm = frontMatter(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8').slice(0, 16384)); } catch { /* handled below */ }
        if (!fm) throw fail(400, 'SKILL.md tidak memiliki front matter yang terbaca (blok --- di awal berkas).');
        // The reader names a skill by its FOLDER, so the name comes from the
        // source folder (folder import), the wrapper folder (zip), or, for a
        // root-level zip, the front matter name.
        let name = null;
        if (root !== stage) name = path.basename(root);
        else if (input?.source !== 'zip') name = path.basename(path.resolve(String(input?.path || '')));
        else if (fm.meta.name && NAME.test(fm.meta.name)) name = fm.meta.name;
        if (!name || !NAME.test(name)) throw fail(400, 'Nama skill tidak bisa ditentukan atau tidak memenuhi aturan nama (huruf kecil, angka, strip, garis bawah; maks 40 karakter). Gunakan folder bernama skill itu, atau zip dengan satu folder pembungkus bernama sama.');
        const target = path.join(skillsDir, name);
        if (fs.existsSync(target)) throw fail(409, 'Skill "' + name + '" sudah ada di folder skill profil. Hapus yang lama dulu bila ingin menggantinya.');
        copyTree(root, target);
        return { imported: name, skills: skillState() };
      } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* staging cleanup is best-effort */ } }
    },

    async skillRemove(name) {
      if (typeof name !== 'string' || !NAME.test(name)) throw fail(400, 'Nama skill tidak valid.');
      const target = path.join(skillsDir, name);
      if (!fs.existsSync(target)) throw fail(404, 'Skill profil dengan nama ini tidak ditemukan.');
      fs.rmSync(target, { recursive: true, force: true });
      // A removed skill must not leave its name in the settings disabled
      // list: a later import of the same name would otherwise start disabled.
      try { const disabled = settings.view().skills.disabled; if (disabled.includes(name)) settings.update({ skills: { disabled: disabled.filter(n => n !== name) } }); } catch { /* folder removal already succeeded; the stale name is inert */ }
      return { removed: name, skills: skillState() };
    }
  };
}

module.exports = { createKapabilitasBinding };
