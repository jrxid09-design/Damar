'use strict';
// Mata Dewa ALPR — ONLY on the Owner's own registered cameras with ALPR enabled, processed locally.
// Engine: alpr-engine.cjs (fast-alpr 0.4.0, MIT) in a private venv installed only by the Owner's action in Control;
// until then ALPR reports the engine as not installed. Nothing is sent to any service. There is no
// plate-to-owner lookup, no identity resolution and no ALPR on public cameras (this module never sees them).
// Log: <profileDir>/alpr/log.jsonl + crops/<id>.jpg, purged after `alprRetentionDays` (default 30). Watchlist hits
// raise alerts (GET /api/r9/mata-dewa/alpr/alerts; unacknowledged count in /status for Control and the notch).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const fail = (code, status = 400) => Object.assign(Error(code), { code, status });
const PLATE = /^[A-Z0-9]{2,12}$/, DEDUPE_MS = 120000, MAX_ENTRIES = 50000;
const normPlate = p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const { pythonEngine } = require('./alpr-engine.cjs');

// onAlert(alert): called once per new watchlist hit (Core relays it to GET /api/r9/activity as kind "alert").
function createAlpr({ profileDir, cameras, settings, engine, now = Date.now, setTimer = setInterval, onAlert = null }) {
  const dir = profileDir ? path.join(profileDir, 'alpr') : null, logFile = dir && path.join(dir, 'log.jsonl'), cropDir = dir && path.join(dir, 'crops'), wlFile = dir && path.join(dir, 'watchlist.json');
  const cfg = () => settings();
  let log = [], watchlist = [], alerts = [], status = { engine: engine?.name || null, available: null, lastRun: null, lastError: null };
  const recent = new Map();
  if (dir) {
    try { log = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && PLATE.test(e.plate)); } catch {}
    try { watchlist = JSON.parse(fs.readFileSync(wlFile, 'utf8')).filter(w => PLATE.test(w.plate)); } catch {}
  }
  const ensure = () => fs.mkdirSync(cropDir, { recursive: true });
  const writeLog = () => { ensure(); const tmp = logFile + '.tmp'; fs.writeFileSync(tmp, log.map(e => JSON.stringify(e)).join('\n') + (log.length ? '\n' : '')); fs.renameSync(tmp, logFile); };
  const writeWl = () => { ensure(); fs.writeFileSync(wlFile + '.tmp', JSON.stringify(watchlist, null, 1)); fs.renameSync(wlFile + '.tmp', wlFile); };
  const dropCrop = e => { if (e.crop) try { fs.unlinkSync(path.join(cropDir, e.id + '.jpg')); } catch {} };

  function purge() {
    const cutoff = now() - cfg().alprRetentionDays * 86400000, keep = [];
    for (const e of log) { if (Date.parse(e.t) >= cutoff) keep.push(e); else dropCrop(e); }
    while (keep.length > MAX_ENTRIES) dropCrop(keep.shift());
    if (keep.length !== log.length) { log = keep; writeLog(); }
    alerts = alerts.filter(a => Date.parse(a.t) >= cutoff);
  }

  async function scanCamera(cam) {
    const jpeg = await cameras.ownSnapshot(cam.id, { maxAgeMs: 0 });
    const reads = await engine.recognize(jpeg);
    const t = new Date(now()).toISOString(), added = [];
    for (const r of Array.isArray(reads) ? reads.slice(0, 20) : []) {
      const plate = normPlate(r.plate), confidence = Number(r.confidence);
      if (!PLATE.test(plate) || !(confidence >= 0.5)) continue;
      const k = cam.id + '|' + plate; if (now() - (recent.get(k) || 0) < DEDUPE_MS) continue; recent.set(k, now());
      const e = { id: 'alpr_' + crypto.randomBytes(8).toString('hex'), t, plate, confidence: Math.round(confidence * 100) / 100, camera: cam.id, cameraName: cam.name, crop: false };
      if (typeof r.crop === 'string' && r.crop && r.crop.length < 2 * 1024 * 1024) { ensure(); fs.writeFileSync(path.join(cropDir, e.id + '.jpg'), Buffer.from(r.crop, 'base64')); e.crop = true; }
      log.push(e); added.push(e); ensure(); fs.appendFileSync(logFile, JSON.stringify(e) + '\n');
      const hit = watchlist.find(w => w.plate === plate);
      if (hit) { const a = { id: 'alert_' + e.id.slice(5), t, plate, camera: cam.id, cameraName: cam.name, note: hit.note, entry: e.id, acknowledged: false }; alerts.push(a); try { onAlert?.(a); } catch {} }
    }
    if (recent.size > 5000) recent.clear();
    if (alerts.length > 500) alerts = alerts.slice(-500);
    return added;
  }

  let running = false;
  async function tick() {
    if (running) return; running = true;
    try {
      const c = cfg(), cams = cameras.own().filter(x => x.alpr);
      if (!c.alprNoticeAt || !c.cctvNoticeAt || !cams.length) return;
      status.available = await engine.available(); if (!status.available) return;
      for (const cam of cams) { try { await scanCamera(cam); status.lastError = null; } catch (e) { status.lastError = /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'ALPR_FAILED'; } }
      status.lastRun = new Date(now()).toISOString();
    } finally { running = false; }
  }
  let timer = null, every = 0, lastPurge = 0;
  let engineChecked = false;
  function schedule() { // called on each status/route access and by the 5 s heartbeat; cheap when idle
    const c = cfg();
    if (!engineChecked && c.alprNoticeAt && engine?.available) { engineChecked = true; engine.available().then(v => { status.available = v; }, () => {}); } if (now() - lastPurge > 3600000) { lastPurge = now(); purge(); }
    if (every !== c.alprIntervalSec) { if (timer) clearInterval(timer); every = c.alprIntervalSec; timer = setTimer(() => tick().catch(() => {}), every * 1000); timer.unref?.(); }
  }

  function action(input) {
    if (input.action === 'delete') { const i = log.findIndex(e => e.id === input.id); if (i < 0) throw fail('ENTRY_NOT_FOUND', 404); dropCrop(log[i]); log.splice(i, 1); writeLog(); return { deleted: 1 }; }
    if (input.action === 'delete-all') { const n = log.length; log.forEach(dropCrop); log = []; alerts = []; writeLog(); return { deleted: n }; }
    if (input.action === 'watchlist-add') {
      const plate = normPlate(input.plate), note = String(input.note || '').replace(/[\x00-\x1f\x7f<>]/g, '').slice(0, 80);
      if (!PLATE.test(plate)) throw fail('PLATE_INVALID'); if (watchlist.length >= 200) throw fail('WATCHLIST_FULL', 409);
      watchlist = watchlist.filter(w => w.plate !== plate).concat({ plate, note, addedAt: new Date(now()).toISOString() }); writeWl(); return { watchlist };
    }
    if (input.action === 'watchlist-remove') { watchlist = watchlist.filter(w => w.plate !== normPlate(input.plate)); writeWl(); return { watchlist }; }
    if (input.action === 'ack-alerts') { alerts.forEach(a => { a.acknowledged = true; }); return { acknowledged: alerts.length }; }
    throw fail('ACTION_INVALID');
  }

  return {
    schedule, tick, purge, scanCamera, action,
    engine,
    status: () => ({ ...status, engineState: engine?.status ? engine.status() : null, enabledCameras: cameras.own().filter(c => c.alpr).length, entries: log.length, unacknowledgedAlerts: alerts.filter(a => !a.acknowledged).length }),
    entries: (limit = 200) => log.slice(-limit).reverse(),
    exportAll: () => ({ exportedAt: new Date(now()).toISOString(), retentionDays: cfg().alprRetentionDays, entries: log, watchlist }),
    crop: id => { const e = log.find(x => x.id === id && x.crop); if (!e) throw fail('ENTRY_NOT_FOUND', 404); return fs.readFileSync(path.join(cropDir, e.id + '.jpg')); },
    watchlist: () => watchlist, alerts: () => alerts.slice().reverse(),
    stop: () => { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createAlpr, pythonEngine, normPlate };
