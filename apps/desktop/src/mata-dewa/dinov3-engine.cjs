'use strict';
// Local DINOv3 change-detection engine: ONNX Runtime in a private venv, weights
// cached under the same folder - the ALPR engine pattern (alpr-engine.cjs).
// Location (for the release agent): %LOCALAPPDATA%\DAMAR\dinov3  (override: DAMAR_DINOV3_DIR)
//   venv\                                   python -m venv, pinned packages (PINS)
//   models\<repo>\onnx\model.onnx(+_data)   DINOv3 weights (onnx-community conversions)
//   install.log
// The weights are DINOv3 License material (Meta): they are NEVER bundled with
// DAMAR and never redistributed; install() downloads them only from the
// Owner's "Install DINOv3 engine" action, and the worker refuses with
// MODELS_NOT_INSTALLED when they are missing. Attribution: Built with DINOv3.
//
// Score contract (calibrated 2026-11-28 on real NASA HLS chips of Jakarta and
// the Nusantara capital region, see DINOV3.md): per-patch cosine distances
// between the two chips are computed over MUTUALLY CLEAR land patches only
// (a pixel cloud mask drops cloud/haze patches in either chip). The change
// score is the mean of the top 5% patch distances minus the median patch
// distance - localized change strength above the pair's own background.
// Absolute patch distances do NOT separate change from scene texture on real
// imagery (a dense city jitters more than a cleared forest), which is why the
// score is relative to the pair itself and why a score at/above threshold is
// only a candidate: DAMAR's VLM verification decides before any alert.
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');

const fail = (code, status = 502) => Object.assign(Error(code), { code, status });
const PINS = Object.freeze(['onnxruntime==1.32.0', 'numpy==2.5.5', 'pillow==13.0.0', 'huggingface-hub==2.4.0']);
const MODELS = Object.freeze({
  vits16: Object.freeze({ repo: 'onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX', label: 'DINOv3 ViT-S/16 (LVD-1689M)' }),
  vitb16: Object.freeze({ repo: 'onnx-community/dinov3-vitb16-pretrain-lvd1689m-ONNX', label: 'DINOv3 ViT-B/16 (LVD-1689M)' }),
});
const INSTALL_HOSTS = Object.freeze(['pypi.org', 'files.pythonhosted.org', 'huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co']);
const repoDir = id => MODELS[id].repo.split('/')[1];

// Checks that the pinned packages import and both fp32 model files are present, without any download.
const CHECK_PY = String.raw`
import sys, json, os
import importlib.metadata as md
def ok(d):
    g, w = os.path.join(d, "onnx", "model.onnx"), os.path.join(d, "onnx", "model.onnx_data")
    return os.path.isfile(g) and os.path.isfile(w) and os.path.getsize(w) > 40000000
print(json.dumps({"onnxruntime": md.version("onnxruntime"), "numpy": md.version("numpy"), "pillow": md.version("pillow"),
  "models": {"vits16": ok(sys.argv[1]), "vitb16": ok(sys.argv[2])}}))
`;
// Downloads the fp32 ONNX weights + configs into models\<repo> (install step only).
const DOWNLOAD_PY = String.raw`
import sys, os
from huggingface_hub import snapshot_download
for repo, dest in (("onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX", sys.argv[1]), ("onnx-community/dinov3-vitb16-pretrain-lvd1689m-ONNX", sys.argv[2])):
    snapshot_download(repo_id=repo, local_dir=dest, allow_patterns=["onnx/model.onnx", "onnx/model.onnx_data", "config.json", "preprocessor_config.json", "LICENSE.md", "README.md"])
print("ok")
`;
// Worker: one JSON line {"a": base64 jpeg, "b": base64 jpeg} -> one JSON line of metrics (or {"error"}).
const WORKER_PY = String.raw`
import sys, json, base64, io, os
model_path = sys.argv[1]
if not os.path.isfile(model_path):
    print(json.dumps({"error": "MODELS_NOT_INSTALLED"}), flush=True); sys.exit(4)
import numpy as np
import onnxruntime as ort
from PIL import Image
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
NUM_PREFIX = 5
SIZE = 512
GRID = 32
PATCH = SIZE // GRID
sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
INP = sess.get_inputs()[0].name
print(json.dumps({"ready": True}), flush=True)

def load(b64):
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB").resize((SIZE, SIZE), Image.BICUBIC)

def tokens(im):
    arr = np.asarray(im).astype(np.float32) / 255.0
    arr = (arr - MEAN) / STD
    out = sess.run(None, {INP: arr.transpose(2, 0, 1)[None].astype(np.float32)})
    return next(o[0] for o in out if o.ndim == 3)

def cloud_mask(im):
    arr = np.asarray(im).astype(np.float32) / 255.0
    bright = arr.mean(axis=2); mx = arr.max(axis=2); mn = arr.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    cell = (bright > 0.78) & (sat < 0.30)
    return cell.reshape(GRID, PATCH, GRID, PATCH).mean(axis=(1, 3)) > 0.5

def cos1(a, b):
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    return float(min(2.0, max(0.0, 1.0 - float(np.dot(a, b)))))

def compare(a64, b64):
    ia, ib = load(a64), load(b64)
    ta, tb = tokens(ia), tokens(ib)
    pa, pb = ta[NUM_PREFIX:], tb[NUM_PREFIX:]
    an = pa / np.linalg.norm(pa, axis=1, keepdims=True)
    bn = pb / np.linalg.norm(pb, axis=1, keepdims=True)
    d = (1.0 - np.sum(an * bn, axis=1)).reshape(GRID, GRID)
    clear = ~cloud_mask(ia) & ~cloud_mask(ib)
    vals = d[clear]
    res = {"clsDistance": round(cos1(ta[0], tb[0]), 4), "clearFraction": round(float(clear.mean()), 3),
           "patchesUsed": int(vals.size), "grid": GRID, "inputSize": SIZE}
    if vals.size < 30:
        res.update({"score": None, "note": "INSUFFICIENT_CLEAR_LAND"})
        return res
    med = float(np.median(vals))
    top5 = float(np.sort(vals)[-max(1, vals.size // 20):].mean())
    idx = int(np.argmax(np.where(clear, d, -1.0)))
    row, col = divmod(idx, GRID)
    res.update({"patchMedian": round(med, 4), "patchP95": round(float(np.percentile(vals, 95)), 4),
                "patchMax": round(float(vals.max()), 4), "top5Mean": round(top5, 4),
                "score": round(top5 - med, 4), "hottestPatch": {"row": row, "col": col}})
    return res

for line in sys.stdin:
    try:
        req = json.loads(line)
        print(json.dumps(compare(req["a"], req["b"])), flush=True)
    except Exception as e:
        print(json.dumps({"error": type(e).__name__}), flush=True)
`;

function defaultDir(env = process.env) {
  if (env.DAMAR_DINOV3_DIR && path.isAbsolute(env.DAMAR_DINOV3_DIR)) return env.DAMAR_DINOV3_DIR;
  // Inside Core, Node-side writes are confined to the data root (scratch write guard), so the engine lives there.
  if (env.DAMAR_DATA_ROOT && path.isAbsolute(env.DAMAR_DATA_ROOT)) return path.join(env.DAMAR_DATA_ROOT, 'dinov3');
  const local = env.DAMAR_USER_LOCALAPPDATA || env.LOCALAPPDATA;
  return local ? path.join(local, 'DAMAR', 'dinov3') : null;
}

// Tolerates null/partial options and a missing folder or venv; the folder is resolved lazily on first use.
function createDinov3Engine(opts) {
  const o = opts || {}, basePython = o.basePython || null, spawnFn = o.spawnFn || spawn;
  let resolved;
  const D = () => (resolved === undefined ? (resolved = o.dir || defaultDir()) : resolved);
  const venvPython = () => D() && path.join(D(), 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
  const modelDir = id => D() && path.join(D(), 'models', repoDir(id));
  const modelFile = id => D() && path.join(modelDir(id), 'onnx', 'model.onnx');
  const env = () => ({ SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: path.dirname(venvPython()), USERPROFILE: path.join(D(), 'home'), HOME: path.join(D(), 'home'),
    TEMP: path.join(D(), 'tmp'), TMP: path.join(D(), 'tmp'), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' });
  const run = (exe, args, { timeout = 60000, input = null } = {}) => new Promise(resolve => {
    const p = spawnFn(exe, args, { windowsHide: true, env: env(), cwd: D(), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', d => out.push(Buffer.from(d))); p.stderr.on('data', d => { if (err.length < 200) err.push(Buffer.from(d)); });
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out: '', err: 'SPAWN_FAILED' }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }); });
    p.stdin.end(input || undefined);
  });

  let state = { installed: null, installing: false, error: null, versions: null, models: null };
  async function check() {
    if (!D() || !fs.existsSync(venvPython())) { state = { ...state, installed: false, error: D() ? null : 'NO_DINOV3_DIR' }; return state; }
    const r = await run(venvPython(), ['-I', '-c', CHECK_PY, modelDir('vits16'), modelDir('vitb16')], { timeout: 30000 });
    let v = null; try { v = JSON.parse(r.out.trim().split('\n').pop()); } catch {}
    const anyModel = !!(v && (v.models.vits16 || v.models.vitb16));
    state = { ...state, installed: anyModel, versions: v ? { onnxruntime: v.onnxruntime, numpy: v.numpy, pillow: v.pillow } : null, models: v ? v.models : null,
      error: v ? (anyModel ? null : 'MODELS_NOT_INSTALLED') : 'ENGINE_NOT_INSTALLED' };
    return state;
  }

  // Owner-consented install: venv + pinned packages + the two fp32 weight sets. Network goes to INSTALL_HOSTS.
  async function install() {
    if (state.installing) return state;
    if (!D()) throw fail('NO_DINOV3_DIR', 503);
    if (!fs.existsSync(venvPython()) && !basePython) throw fail('PYTHON_NOT_FOUND', 503);
    state = { ...state, installing: true, error: null };
    const log = path.join(D(), 'install.log'), step = (name, r) => { fs.appendFileSync(log, `[${new Date().toISOString()}] ${name}: exit ${r.code}\n${r.err.slice(-2000)}\n`); if (r.code !== 0) throw fail('INSTALL_' + name.toUpperCase() + '_FAILED'); };
    (async () => {
      try {
        for (const sub of ['home', 'tmp', 'models']) fs.mkdirSync(path.join(D(), sub), { recursive: true });
        if (!fs.existsSync(venvPython())) step('venv', await run(basePython, ['-I', '-m', 'venv', path.join(D(), 'venv')], { timeout: 300000 }));
        step('pip', await run(venvPython(), ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...PINS], { timeout: 1800000 }));
        step('models', await run(venvPython(), ['-I', '-c', DOWNLOAD_PY, modelDir('vits16'), modelDir('vitb16')], { timeout: 1800000 }));
        state = { ...state, installing: false }; await check();
      } catch (e) { state = { ...state, installing: false, installed: false, error: e.code || 'INSTALL_FAILED' }; }
    })();
    return state;
  }

  // Long-lived worker per model; requests are serialized. Switching models restarts the worker.
  let worker = null, workerModel = null, queue = Promise.resolve();
  function startWorker(modelId) {
    return new Promise((resolve, reject) => {
      const p = spawnFn(venvPython(), ['-I', '-c', WORKER_PY, modelFile(modelId)], { windowsHide: true, env: env(), cwd: D(), stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '', waiting = null, settled = false;
      const w = { p, send: line => new Promise((res, rej) => { waiting = { res, rej }; p.stdin.write(line + '\n'); }) };
      p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
        if (m && m.ready) { if (!settled) { settled = true; workerModel = modelId; resolve(w); } continue; }
        if (m && m.error === 'MODELS_NOT_INSTALLED') { if (!settled) { settled = true; reject(fail('MODELS_NOT_INSTALLED', 503)); } continue; }
        if (waiting) { const x = waiting; waiting = null; x.res(m); } } });
      p.on('error', () => { if (!settled) { settled = true; reject(fail('DINOV3_ENGINE_FAILED')); } });
      p.on('close', () => { if (worker === w) worker = null; if (workerModel === modelId) workerModel = null; if (waiting) { waiting.rej(fail('DINOV3_ENGINE_FAILED')); waiting = null; } if (!settled) { settled = true; reject(fail('DINOV3_ENGINE_FAILED')); } });
    });
  }
  function compare(jpegA, jpegB, modelId = 'vits16') {
    const id = MODELS[modelId] ? modelId : 'vits16';
    const job = queue.then(async () => {
      if (!worker || workerModel !== id) { try { worker && worker.p.kill(); } catch {} worker = null; workerModel = null; worker = startWorker(id); }
      const w = await worker;
      const timer = setTimeout(() => w.p.kill(), 300000);
      try {
        const r = await w.send(JSON.stringify({ a: Buffer.from(jpegA).toString('base64'), b: Buffer.from(jpegB).toString('base64') }));
        if (r && r.error) throw fail('DINOV3_ENGINE_' + String(r.error).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40));
        return { ...r, model: id };
      } finally { clearTimeout(timer); }
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    name: 'DINOv3 (ONNX, local) - Built with DINOv3', get dir() { return D(); }, PINS, MODELS, INSTALL_HOSTS,
    async available() { if (state.installed === null) await check(); return state.installed === true; },
    status: () => ({ ...state, dir: D(), models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.label])) }), check, install, compare,
    stop() { try { worker && worker.then(w => w.p.kill(), () => {}); } catch {} worker = null; workerModel = null; },
  };
}

module.exports = { createDinov3Engine, defaultDir, PINS, MODELS, INSTALL_HOSTS, WORKER_PY };
