'use strict';
// DINOv3 change detection for Mata Dewa watch points (Owner vision decision
// 2026-11-25, re-validated 2026-11-27): DINOv3 is the perception provider for
// "what changed here" - periodic satellite chips of an asset point are
// compared feature-wise against a baseline chip, DAMAR's VLM verifies any
// candidate, and only a confirmed change may alert (see alert-rules.cjs,
// rule imagery-change). This module is the provider binding: it owns the
// per-point scene-pair bookkeeping and the durable score record. Every
// comparison is stored (dinov3-scores.jsonl under the Mata Dewa profile dir)
// with both chip dates and source attribution, whatever the score: below
// threshold the record is the observation; at/above threshold the record
// also carries the VLM verification verdict. The engine only ever says
// "something changed here", never what it means.
//
// Pair policy: the newest catalog scene vs the clearest older scene of a
// different day (the baseline). A pair is compared once; the compared-pair
// state persists (dinov3-state.json) so a 10-minute tick never re-runs
// inference on the same pair. When a newer scene lands, the pair rolls.
const fs = require('node:fs'), path = require('node:path');

const SOURCE = 'NASA HLS (CMR) + Worldview Snapshot (GIBS)';
const ATTRIBUTION = 'Built with DINOv3';

function createDinov3Changes({ engine, fetchChip, latestScenes, verify = null, storeDir = null, now = Date.now, getConfig = () => ({}) } = {}) {
  const scoresFile = storeDir ? path.join(storeDir, 'dinov3-scores.jsonl') : null;
  const stateFile = storeDir ? path.join(storeDir, 'dinov3-state.json') : null;
  let state = { pairs: {} };
  try { const v = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (v && v.pairs && typeof v.pairs === 'object' && !Array.isArray(v.pairs)) state = { pairs: v.pairs }; } catch {}
  let scoreCount = 0;
  try { scoreCount = fs.readFileSync(scoresFile, 'utf8').split('\n').filter(Boolean).length; } catch {}
  const saveState = () => { if (!stateFile) return; try { fs.mkdirSync(storeDir, { recursive: true }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state)); fs.renameSync(stateFile + '.tmp', stateFile); } catch {} };
  const appendScore = rec => { scoreCount++; if (!scoresFile) return; try { fs.mkdirSync(storeDir, { recursive: true }); fs.appendFileSync(scoresFile, JSON.stringify(rec) + '\n'); } catch {} };
  function recentScores(limit = 50) {
    if (!scoresFile) return [];
    let lines = [];
    try { lines = fs.readFileSync(scoresFile, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, limit)); } catch { return []; }
    const out = [];
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
    return out.reverse();
  }

  async function provider(location) {
    const cfg = getConfig() || {};
    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 0.18;
    const model = cfg.model === 'vitb16' ? 'vitb16' : 'vits16';
    if (!engine || !(await engine.available())) return [];
    let scenes = [];
    try { scenes = await latestScenes(location); } catch { return []; }
    if (!Array.isArray(scenes) || scenes.length < 2) return [];
    const latest = scenes[0];
    const older = scenes.slice(1).filter(s => s && s.day && s.day !== latest.day);
    if (!older.length) return [];
    const baseline = [...older].sort((a, b) => (a.cloudCoverPct ?? 100) - (b.cloudCoverPct ?? 100))[0];
    const pairKey = String(baseline.id) + '>' + String(latest.id);
    if (state.pairs[location.id] === pairKey) return [];
    let baselineJpeg, latestJpeg;
    try {
      baselineJpeg = await fetchChip(location, { day: baseline.day, product: baseline.product });
      latestJpeg = await fetchChip(location, { day: latest.day, product: latest.product });
    } catch { return []; }
    let metrics;
    try { metrics = await engine.compare(baselineJpeg, latestJpeg, model); } catch { return []; }
    const rec = { at: new Date(now()).toISOString(), locationId: location.id, locationLabel: location.label,
      baseline: { sceneId: baseline.id, day: baseline.day, product: baseline.product, cloudCoverPct: baseline.cloudCoverPct ?? null },
      latest: { sceneId: latest.id, day: latest.day, product: latest.product, cloudCoverPct: latest.cloudCoverPct ?? null },
      model, threshold, score: metrics.score ?? null, clsDistance: metrics.clsDistance ?? null,
      patchMedian: metrics.patchMedian ?? null, patchP95: metrics.patchP95 ?? null, patchMax: metrics.patchMax ?? null,
      clearFraction: metrics.clearFraction ?? null, patchesUsed: metrics.patchesUsed ?? null,
      hottestPatch: metrics.hottestPatch ?? null, note: metrics.note || null,
      source: SOURCE, attribution: ATTRIBUTION, verification: null };
    if (rec.score !== null && rec.score >= threshold) {
      if (typeof verify === 'function') {
        try {
          const v = await verify({ location, record: rec, baselineJpeg, latestJpeg });
          rec.verification = { status: v && v.confirmed ? 'confirmed' : (v && v.status === 'ok' ? 'rejected' : (v && v.status) || 'unavailable'),
            note: v && typeof v.note === 'string' ? v.note.slice(0, 300) : null, model: (v && v.model) || null };
        } catch { rec.verification = { status: 'error', note: null, model: null }; }
      } else rec.verification = { status: 'unavailable', note: null, model: null };
    }
    state.pairs[location.id] = pairKey; saveState(); appendScore(rec);
    return [rec];
  }

  return { provider, recentScores, status: () => ({ scores: scoreCount }) };
}

module.exports = { createDinov3Changes, SOURCE, ATTRIBUTION };
