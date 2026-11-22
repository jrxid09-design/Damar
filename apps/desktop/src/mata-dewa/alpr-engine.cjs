'use strict';
// Local ALPR engine: fast-alpr 0.4.0 (MIT) in a private venv, models cached under the same folder.
// Location (for the release agent): %LOCALAPPDATA%\DAMAR\alpr  (override: DAMAR_ALPR_DIR)
//   venv\                                   python -m venv, pinned packages (PINS)
//   home\.cache\open-image-models\<det>\    detector weights (github.com/ankandrew/open-image-models releases, MIT repo)
//   home\.cache\fast-plate-ocr\<ocr>\       OCR weights (github.com/ankandrew/cnn-ocr-lp releases, MIT repo)
//   install.log
// Nothing is downloaded silently: install() runs only from the Owner's "Install ALPR engine" action in Control.
// The worker never downloads: it refuses with MODELS_NOT_INSTALLED when the weights are missing.
// Recognition runs in one long-lived worker process (models loaded once); one JSON line per frame.
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');

const fail = (code, status = 502) => Object.assign(Error(code), { code, status });
const PINS = Object.freeze(['fast-alpr[onnx]==0.4.0', 'fast-plate-ocr==1.1.0', 'open-image-models==0.6.0', 'onnxruntime==1.32.0', 'opencv-python-headless==5.1.0.95', 'numpy==2.4.6']);
const DETECTOR = 'yolo-v9-t-384-license-plate-end2end', OCR = 'cct-xs-v2-global-model';
const INSTALL_HOSTS = Object.freeze(['pypi.org', 'files.pythonhosted.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

// Checks that the pinned packages import and both model folders are populated, without any download.
const CHECK_PY = String.raw`
import sys, json
from open_image_models.detection.core import hub as dh
from fast_plate_ocr.inference import hub as oh
import fast_alpr, importlib.metadata as md
d, o = dh.MODEL_CACHE_DIR / sys.argv[1], oh.MODEL_CACHE_DIR / sys.argv[2]
ok = lambda p: p.is_dir() and any(p.iterdir())
print(json.dumps({"fastAlpr": md.version("fast-alpr"), "detector": ok(d), "ocr": ok(o)}))
`;
// Downloads the two pinned models into the venv's HOME cache (install step only).
const DOWNLOAD_PY = String.raw`
import sys
from open_image_models.detection.core.hub import download_model as dd
from fast_plate_ocr.inference.hub import download_model as od
dd(sys.argv[1]); od(sys.argv[2]); print("ok")
`;
// Worker: one base64 JPEG per stdin line -> one JSON line [{plate, confidence, detConfidence, crop}] (or {"error"}).
const WORKER_PY = String.raw`
import sys, json, base64
from open_image_models.detection.core import hub as dh
from fast_plate_ocr.inference import hub as oh
for p in (dh.MODEL_CACHE_DIR / sys.argv[1], oh.MODEL_CACHE_DIR / sys.argv[2]):
    if not (p.is_dir() and any(p.iterdir())):
        print(json.dumps({"error": "MODELS_NOT_INSTALLED"}), flush=True); sys.exit(4)
import numpy as np, cv2
from fast_alpr import ALPR
alpr = ALPR(detector_model=sys.argv[1], ocr_model=sys.argv[2], ocr_device="cpu")
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        img = cv2.imdecode(np.frombuffer(base64.b64decode(line.strip()), np.uint8), cv2.IMREAD_COLOR)
        out = []
        if img is not None:
            h, w = img.shape[:2]
            for r in alpr.predict(img):
                o, d = r.ocr, r.detection
                if o is None or not o.text:
                    continue
                conf = o.confidence
                if isinstance(conf, (list, tuple)) or hasattr(conf, "__len__"):
                    conf = float(sum(conf) / max(1, len(conf)))
                bb = d.bounding_box
                x1, y1, x2, y2 = [int(max(0, v)) for v in (bb.x1, bb.y1, bb.x2, bb.y2)]
                c = img[min(y1, h):min(y2, h), min(x1, w):min(x2, w)]
                crop = base64.b64encode(cv2.imencode(".jpg", c)[1].tobytes()).decode() if c.size else ""
                out.append({"plate": o.text, "confidence": float(conf), "detConfidence": float(d.confidence), "crop": crop})
        print(json.dumps(out), flush=True)
    except Exception as e:
        print(json.dumps({"error": type(e).__name__}), flush=True)
`;

function defaultDir(env = process.env) {
  if (env.DAMAR_ALPR_DIR && path.isAbsolute(env.DAMAR_ALPR_DIR)) return env.DAMAR_ALPR_DIR;
  // Inside Core, Node-side writes are confined to the data root (scratch write guard), so the engine lives there.
  if (env.DAMAR_DATA_ROOT && path.isAbsolute(env.DAMAR_DATA_ROOT)) return path.join(env.DAMAR_DATA_ROOT, 'alpr');
  const local = env.DAMAR_USER_LOCALAPPDATA || env.LOCALAPPDATA;
  return local ? path.join(local, 'DAMAR', 'alpr') : null;
}

// Tolerates null/partial options and a missing folder or venv; the folder is resolved lazily on first use.
function pythonEngine(opts) {
  const o = opts || {}, basePython = o.basePython || null, spawnFn = o.spawnFn || spawn;
  let resolved;
  const D = () => (resolved === undefined ? (resolved = o.dir || defaultDir()) : resolved);
  const venvPython = () => D() && path.join(D(), 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
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

  let state = { installed: null, installing: false, error: null, versions: null };
  async function check() {
    if (!D() || !fs.existsSync(venvPython())) { state = { ...state, installed: false, error: D() ? null : 'NO_ALPR_DIR' }; return state; }
    const r = await run(venvPython(), ['-I', '-c', CHECK_PY, DETECTOR, OCR], { timeout: 30000 });
    let v = null; try { v = JSON.parse(r.out.trim().split('\n').pop()); } catch {}
    state = { ...state, installed: !!(v && v.detector && v.ocr), versions: v ? { fastAlpr: v.fastAlpr, detector: DETECTOR, ocr: OCR } : null, error: v ? (v.detector && v.ocr ? null : 'MODELS_NOT_INSTALLED') : 'ENGINE_NOT_INSTALLED' };
    return state;
  }

  // Owner-consented install: venv + pinned packages + the two model files. Network goes to INSTALL_HOSTS.
  async function install() {
    if (state.installing) return state;
    if (!D()) throw fail('NO_ALPR_DIR', 503);
    if (!fs.existsSync(venvPython()) && !basePython) throw fail('PYTHON_NOT_FOUND', 503);
    state = { ...state, installing: true, error: null };
    const log = path.join(D(), 'install.log'), step = (name, r) => { fs.appendFileSync(log, `[${new Date().toISOString()}] ${name}: exit ${r.code}\n${r.err.slice(-2000)}\n`); if (r.code !== 0) throw fail('INSTALL_' + name.toUpperCase() + '_FAILED'); };
    (async () => {
      try {
        for (const sub of ['home', 'tmp']) fs.mkdirSync(path.join(D(), sub), { recursive: true });
        if (!fs.existsSync(venvPython())) step('venv', await run(basePython, ['-I', '-m', 'venv', path.join(D(), 'venv')], { timeout: 300000 }));
        step('pip', await run(venvPython(), ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...PINS], { timeout: 1800000 }));
        step('models', await run(venvPython(), ['-I', '-c', DOWNLOAD_PY, DETECTOR, OCR], { timeout: 600000 }));
        state = { ...state, installing: false }; await check();
      } catch (e) { state = { ...state, installing: false, installed: false, error: e.code || 'INSTALL_FAILED' }; }
    })();
    return state;
  }

  // Long-lived worker; requests are serialized.
  let worker = null, queue = Promise.resolve();
  function startWorker() {
    return new Promise((resolve, reject) => {
      const p = spawnFn(venvPython(), ['-I', '-c', WORKER_PY, DETECTOR, OCR], { windowsHide: true, env: env(), cwd: D(), stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '', waiting = null;
      const w = { p, send: line => new Promise((res, rej) => { waiting = { res, rej }; p.stdin.write(line + '\n'); }) };
      p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
        if (m && m.ready) { resolve(w); continue; } if (m && m.error === 'MODELS_NOT_INSTALLED') { reject(fail('MODELS_NOT_INSTALLED', 503)); continue; } if (waiting) { const x = waiting; waiting = null; x.res(m); } } });
      p.on('error', () => reject(fail('ALPR_ENGINE_FAILED')));
      p.on('close', () => { worker = null; if (waiting) { waiting.rej(fail('ALPR_ENGINE_FAILED')); waiting = null; } reject(fail('ALPR_ENGINE_FAILED')); });
    });
  }
  function recognize(jpeg) {
    const job = queue.then(async () => {
      if (!worker) worker = startWorker().catch(e => { worker = null; throw e; });
      const w = await worker;
      const timer = setTimeout(() => w.p.kill(), 60000);
      try { const r = await w.send(jpeg.toString('base64')); if (r && r.error) throw fail('ALPR_ENGINE_' + String(r.error).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40)); return r; }
      finally { clearTimeout(timer); }
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    name: 'fast-alpr 0.4.0 (MIT)', get dir() { return D(); }, PINS, INSTALL_HOSTS,
    async available() { if (state.installed === null) await check(); return state.installed === true; },
    status: () => ({ ...state, dir: D() }), check, install, recognize,
    stop() { try { worker && worker.then(w => w.p.kill(), () => {}); } catch {} worker = null; },
  };
}

module.exports = { pythonEngine, defaultDir, PINS, DETECTOR, OCR, INSTALL_HOSTS, WORKER_PY };
