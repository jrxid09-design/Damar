'use strict';
// Provider API keys the Owner chose to remember, encrypted with Windows DPAPI for the current user (CryptProtectData,
// CurrentUser scope, per-provider entropy). Only the encrypted blob is written (<dir>/<provider>.dpapi); the plaintext
// key travels only over the helper's stdin/stdout, never in arguments, files or logs. A blob that does not decrypt
// (another user, another machine, tampered) is treated as no key.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');

const ID = /^[a-z0-9-]{1,40}$/;
// argv: protect|unprotect <entropy>. protect: stdin plaintext -> stdout base64 blob; unprotect: the reverse.
const HELPER = String.raw`
import base64, ctypes, sys
from ctypes import wintypes as w
class Blob(ctypes.Structure):
    _fields_ = [("cbData", w.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]
def blob(b):
    buf = ctypes.create_string_buffer(b, len(b))
    return Blob(len(b), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf
crypt32, kernel32 = ctypes.WinDLL("crypt32"), ctypes.WinDLL("kernel32")
protect = sys.argv[1] == "protect"
data = sys.stdin.buffer.read()
src, keep_src = blob(data if protect else base64.b64decode(data, validate=True))
ent, keep_ent = blob(sys.argv[2].encode("utf-8"))
out = Blob()
UI_FORBIDDEN = 0x1
if protect:
    ok = crypt32.CryptProtectData(ctypes.byref(src), "DAMAR provider key", ctypes.byref(ent), None, None, UI_FORBIDDEN, ctypes.byref(out))
else:
    ok = crypt32.CryptUnprotectData(ctypes.byref(src), None, ctypes.byref(ent), None, None, UI_FORBIDDEN, ctypes.byref(out))
if not ok:
    sys.exit(3)
result = ctypes.string_at(out.pbData, out.cbData)
kernel32.LocalFree(out.pbData)
sys.stdout.buffer.write(base64.b64encode(result) if protect else result)
`;

function createKeyStore({ dir, python }) {
  const file = id => { if (!ID.test(id)) throw Object.assign(Error('UNKNOWN_PROVIDER'), { status: 400 }); return path.join(dir, id + '.dpapi'); };
  const run = (mode, id, input) => {
    if (!python) throw Object.assign(Error('KEY_STORE_UNAVAILABLE'), { status: 503 });
    const r = spawnSync(python, ['-I', '-c', HELPER, mode, 'DAMAR provider key v1:' + id], { input, windowsHide: true, timeout: 15000, maxBuffer: 1 << 16 });
    return r.status === 0 ? r.stdout : null;
  };
  return {
    has: id => fs.existsSync(file(id)),
    // The key, or null when none is remembered or the blob does not decrypt for this user.
    load(id) {
      let blob; try { blob = fs.readFileSync(file(id)); } catch { return null; }
      const out = run('unprotect', id, blob);
      return out && out.length ? out.toString('utf8') : null;
    },
    save(id, key) {
      const blob = run('protect', id, Buffer.from(key, 'utf8'));
      if (!blob || !blob.length) throw Object.assign(Error('KEY_STORE_FAILED'), { status: 500 });
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file(id) + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, blob, { flag: 'wx' }); fs.renameSync(tmp, file(id));
    },
    forget(id) { try { fs.unlinkSync(file(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  };
}
module.exports = { createKeyStore };
