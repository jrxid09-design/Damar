#!/usr/bin/env python3
"""Resident TTS service: Supertonic 3 (ONNX, CPU) untuk suara Damar.

Pola yang sama dengan WarmWhisperServer (model dimuat sekali, lalu melayani
banyak sintesis tanpa muat ulang). Dipakai lewat src/voice/local/engines.js
(kelas WarmSupertonicServer).

  python supertonic_service.py [model_dir] [port]

  GET  /health     -> {"ok": true, "model": "supertonic-3", "sampleRate": 44100, "voices": [...]}
  POST /synthesize {"text": "...", "voice": "M1"|"supertonic-M1", "steps": 8, "lang": "id"}
                   -> WAV PCM16 mono 44.1 kHz (+ header X-Damar-Duration-Ms)
                   Opsional (Voice FX, voice_fx.py): "pitch_semitones" (-12..+12),
                   "style": "normal"|"jarvis", "fx": {parameter preset Jarvis}.
                   Bila dipakai, respons membawa header X-Damar-Fx-Ms/-Pitch/-Style.

Hanya stdlib + paket `supertonic` (onnxruntime). Tidak ada akses jaringan.
Model tidak diunduh di sini; pasang lewat scripts/voice-setup.ps1.
Suara: M1-M5 pria, F1-F5 wanita; semua suara bisa berbahasa Indonesia.
Lisensi bobot: OpenRAIL-M (Supertone/supertonic-3, proyek diarsipkan Sep 2026;
diperlakukan sebagai dependensi beku — revisi pin 724fb5abbf5502583fb520898d45929e62f02c0b).
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Post-processing suara (pitch + preset Jarvis). Supertonic TIDAK punya
# parameter pitch native (signature synthesize: text/voice_style/steps/
# speed/lang), jadi pergeseran pitch + FX diterapkan di waveform hasil
# sintesis — lihat voice_fx.py dan VOICE-FX.md.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import voice_fx as _voice_fx
except Exception as _fx_exc:  # FX tidak boleh mematikan service TTS
    _voice_fx = None
    sys.stderr.write(f"[supertonic] voice_fx tidak termuat: {_fx_exc}\n")

DEFAULT_PORT = 8128
VOICES = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]
MAX_TEXT_CHARS = 2000

# Direktori model default: <repo>/data/voice/supertonic3 (relatif thd file ini).
_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DIR = os.path.normpath(os.path.join(_HERE, "..", "..", "..",
                                             "data", "voice", "supertonic3"))
MODEL_DIR = (sys.argv[1] if len(sys.argv) > 1 else
             os.environ.get("SUPERTONIC_MODEL_DIR") or _DEFAULT_DIR)
PORT = int(sys.argv[2] if len(sys.argv) > 2 else
           os.environ.get("SUPERTONIC_PORT") or DEFAULT_PORT)

_tts = None
_styles = {}
_lock = threading.Lock()


def _load():
    global _tts
    from supertonic import TTS
    t0 = time.time()
    # intra_op 4 terukur tercepat di Aether (i5-14500, mesin berbagi beban):
    # bench 3,3 dtk audio = 629 ms (threads 4) vs 1195 ms (8) vs 5214 ms (14).
    # Bisa ditimpa lewat env SUPERTONIC_THREADS.
    threads = int(os.environ.get("SUPERTONIC_THREADS") or 4)
    _tts = TTS(model="supertonic-3", model_dir=MODEL_DIR, auto_download=False,
               intra_op_num_threads=threads, inter_op_num_threads=2)
    for v in VOICES:
        try:
            _styles[v] = _tts.get_voice_style(voice_name=v)
        except Exception as exc:  # satu style hilang tidak boleh mematikan service
            sys.stderr.write(f"[supertonic] style {v} dilewati: {exc}\n")
            sys.stderr.flush()
    sys.stderr.write(f"[supertonic] model dimuat dalam "
                     f"{round((time.time() - t0) * 1000)} ms "
                     f"(sample_rate={_tts.sample_rate})\n")
    sys.stderr.flush()


def _wav_bytes(wav, sample_rate):
    import struct
    import wave
    import io
    import numpy as np
    pcm = (np.asarray(wav, dtype=np.float32).reshape(-1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # log ringkas ke stderr saja
        sys.stderr.write("[supertonic] %s - %s\n" % (self.address_string(), fmt % args))
        sys.stderr.flush()

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send_json(200, {"ok": True, "model": "supertonic-3",
                                         "sampleRate": int(_tts.sample_rate),
                                         "voices": sorted(_styles.keys())})
        return self._send_json(404, {"error": "rute tidak dikenal"})

    def do_POST(self):
        if self.path != "/synthesize":
            return self._send_json(404, {"error": "rute tidak dikenal"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send_json(400, {"error": "Content-Length tidak valid"})
        if length <= 0 or length > 65536:
            return self._send_json(400, {"error": "body kosong / terlalu besar"})
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:
            return self._send_json(400, {"error": f"JSON tidak valid: {exc}"})
        text = str(payload.get("text") or payload.get("input") or "").strip()
        voice = str(payload.get("voice") or "M1").strip().upper()
        if voice.startswith("SUPERTONIC-"):
            voice = voice[len("SUPERTONIC-"):]
        steps = payload.get("steps", 5)
        lang = str(payload.get("lang") or "id").strip().lower()
        # --- Voice FX (opsional; absen = perilaku lama persis) ----------
        # pitch_semitones: -12..+12 (dari Dashboard voice.pitch_semitones)
        # style: "normal" | "jarvis"; fx: parameter preset Jarvis
        # {pitch_semitones, ring_hz, ring_depth, reverb_wet,
        #  reverb_decay_ms, eq_low_db, eq_presence_db, eq_high_db}.
        try:
            fx_pitch = float(payload.get("pitch_semitones") or 0.0)
        except (TypeError, ValueError):
            return self._send_json(400, {"error": "field 'pitch_semitones' harus angka"})
        fx_pitch = max(-12.0, min(12.0, fx_pitch))
        fx_style = str(payload.get("style") or "normal").strip().lower()
        if fx_style not in ("normal", "jarvis"):
            return self._send_json(400, {"error": "field 'style' harus 'normal' atau 'jarvis'"})
        fx_params = payload.get("fx") if isinstance(payload.get("fx"), dict) else None
        if not text:
            return self._send_json(400, {"error": "field 'text' wajib diisi"})
        if len(text) > MAX_TEXT_CHARS:
            return self._send_json(400, {"error": f"teks melebihi {MAX_TEXT_CHARS} karakter"})
        if voice not in _styles:
            return self._send_json(400, {"error": f"suara '{voice}' tidak dikenal"})
        try:
            steps = int(steps)
        except (TypeError, ValueError):
            return self._send_json(400, {"error": "field 'steps' harus bilangan bulat"})
        steps = max(1, min(16, steps))
        t0 = time.time()
        with _lock:  # ONNX Runtime: satu sintesis dalam satu waktu (deterministik)
            wav, dur = _tts.synthesize(text, voice_style=_styles[voice],
                                       lang=lang, total_steps=steps)
        import numpy as np
        dur_s = float(np.asarray(dur).reshape(-1)[0])
        # Voice FX post-processing (pitch/Jarvis) — hanya bila diminta.
        fx_info = None
        if _voice_fx is not None and (fx_pitch != 0.0 or fx_style == "jarvis"):
            try:
                y = np.asarray(wav, dtype=np.float32).reshape(-1)
                y, fx_info = _voice_fx.apply_voice_fx(
                    y, int(_tts.sample_rate), pitch_semitones=fx_pitch,
                    style=fx_style, params=fx_params)
                wav = y
            except Exception as exc:  # FX gagal -> kirim audio asli, jangan gagalkan sintesis
                sys.stderr.write(f"[supertonic] voice_fx gagal, audio asli dipakai: {exc}\n")
                sys.stderr.flush()
                fx_info = None
        audio = _wav_bytes(wav, _tts.sample_rate)
        ms = round((time.time() - t0) * 1000)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Damar-Voice", f"supertonic-{voice}")
        self.send_header("X-Damar-Duration-Ms", str(round(dur_s * 1000)))
        self.send_header("X-Damar-Synth-Ms", str(ms))
        if fx_info is not None:
            self.send_header("X-Damar-Fx-Ms", str(round(fx_info["ms"])))
            self.send_header("X-Damar-Fx-Pitch", str(fx_info["pitchApplied"]))
            self.send_header("X-Damar-Fx-Style", fx_info["style"])
        self.end_headers()
        self.wfile.write(audio)


if __name__ == "__main__":
    _load()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(f"[supertonic] mendengarkan di http://127.0.0.1:{PORT} "
                     f"(model_dir={MODEL_DIR})\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
