#!/usr/bin/env python3
"""voice_fx — post-processing audio untuk TTS Damar (pitch + preset Jarvis).

Dipakai oleh supertonic_service.py SESUDAH sintesis Supertonic 3, sebelum
audio dikirim ke pemutar. Alasan post-processing: API `supertonic`
(TTS.synthesize) TIDAK punya parameter pitch native — parameternya hanya
text / voice_style / total_steps / speed / lang (terverifikasi dari
signature paket di data/voice/pyenv). `speed` mengubah durasi lewat
duration predictor, bukan pitch, jadi pitch digeser di sini.

Semua fungsi murni numpy/scipy, CPU, tanpa state global — aman dipanggil
per request (termasuk per mikro-chunk streaming; lihat catatan reverb).

Rantai:
  pitch  : resample (pitch+durasi berubah) lalu phase-vocoder time-stretch
           mengembalikan durasi semula -> pitch bergeser, tempo tetap.
  jarvis : preset di atas pitch user: offset pitch preset + ring modulator
           (karakter metalik) + EQ 3 titik (low shelf / presence peak /
           high shelf — shaping formant ringan) + reverb pendek wet rendah.
           Bahasa-agnostik: bekerja di waveform, sintesis ID tidak berubah.

Parameter Jarvis semuanya datang dari config (src/voice/config.js ->
engines.js -> payload service), jadi bisa di-tuning tanpa ubah kode.
"""
import time

import numpy as np
from scipy import signal

# Default preset Jarvis (harus sama dengan default src/voice/config.js
# dan core-settings.cjs; service hanya memakai ini bila payload tidak
# membawa parameter).
JARVIS_DEFAULTS = {
    "pitch_semitones": -2.0,   # offset pitch preset (di atas pitch user)
    "ring_hz": 32.0,           # frekuensi carrier ring modulator (Hz)
    "ring_depth": 0.40,        # 0 = mati, 1 = ring mod penuh
    "reverb_wet": 0.15,        # campuran reverb 0..1
    "reverb_decay_ms": 110.0,  # waktu peluruhan IR reverb (ms, ke -40 dB)
    "eq_low_db": 2.0,          # low shelf 200 Hz (badan suara)
    "eq_presence_db": 3.0,     # peak 2.5 kHz (daerah formant/artikulasi)
    "eq_high_db": 2.0,         # high shelf 6 kHz (kilau metalik)
}

_FFT = 2048
_HOP = 512


def _phase_vocoder(D, hop, stretch):
    """Regangkan STFT kompleks D sebesar `stretch` ( >1 = lebih panjang).

    Laroche/Dolson: fase tiap bin dimajukan mengikuti frekuensi
    sesaatnya (deviasi dari advance harapan, di-wrap ke [-pi, pi]),
    magnitudo diinterpolasi linier pada posisi waktu input.
    """
    n_bins, n_frames = D.shape
    if n_frames < 2 or stretch <= 0:
        return D
    n_out = max(1, int(np.ceil(n_frames * stretch)))
    mags = np.abs(D)
    phases = np.angle(D)
    expected = 2.0 * np.pi * hop * np.arange(n_bins) / (2 * (n_bins - 1))
    out = np.zeros((n_bins, n_out), dtype=np.complex128)
    phase_acc = phases[:, 0].copy()
    out[:, 0] = mags[:, 0] * np.exp(1j * phase_acc)
    for m in range(1, n_out):
        t = m / stretch
        i0 = int(np.floor(t))
        if i0 >= n_frames - 1:
            i0 = n_frames - 2
            frac = 1.0
        else:
            frac = t - i0
        mag = (1.0 - frac) * mags[:, i0] + frac * mags[:, i0 + 1]
        if i0 > 0:
            # Frekuensi sesaat (rad/frame) pada posisi input t. Fase
            # output maju sebesar itu PER FRAME OUTPUT — bukan dikali
            # delta-t — karena tiap frame output berdurasi hop yang sama
            # dan frekuensi bin harus dipertahankan persis.
            dev = phases[:, i0] - phases[:, i0 - 1] - expected
            dev = dev - 2.0 * np.pi * np.round(dev / (2.0 * np.pi))
            phase_acc = phase_acc + expected + dev
        out[:, m] = mag * np.exp(1j * phase_acc)
    return out


def _time_stretch(y, stretch):
    if abs(stretch - 1.0) < 1e-3 or len(y) < _FFT:
        return y
    _, _, D = signal.stft(y, nperseg=_FFT, noverlap=_FFT - _HOP,
                          boundary=None, padded=False)
    D2 = _phase_vocoder(D, _HOP, stretch)
    _, y2 = signal.istft(D2, nperseg=_FFT, noverlap=_FFT - _HOP,
                         boundary=None)
    return y2


def pitch_shift(y, semitones):
    """Geser pitch sebesar `semitones` tanpa mengubah durasi total."""
    if semitones == 0 or len(y) == 0:
        return y
    f = float(2.0 ** (semitones / 12.0))
    n = len(y)
    # 1) Resample: pitch x f, durasi / f.
    idx = np.arange(0.0, n, f)
    y_fast = np.interp(idx, np.arange(n), y)
    # 2) Phase-vocoder stretch x f: durasi kembali ~ n, pitch tetap.
    y_out = _time_stretch(y_fast.astype(np.float64), f)
    # Samakan panjang persis dengan input (beda tepi dari STFT dibuang).
    if len(y_out) > n:
        y_out = y_out[:n]
    elif len(y_out) < n:
        y_out = np.pad(y_out, (0, n - len(y_out)))
    return y_out.astype(np.float32)


def _biquad(kind, freq, gain_db, q, sr):
    """Koefisien biquad RBJ (low/high shelf, peaking) -> (b, a)."""
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * freq / sr
    cw, sw = np.cos(w0), np.sin(w0)
    if kind in ("lowshelf", "highshelf"):
        alpha = sw / 2.0 * np.sqrt(2.0)
        sq = 2.0 * np.sqrt(A) * alpha
        if kind == "lowshelf":
            b = np.array([A * ((A + 1) - (A - 1) * cw + sq),
                          2 * A * ((A - 1) - (A + 1) * cw),
                          A * ((A + 1) - (A - 1) * cw - sq)])
            a = np.array([(A + 1) + (A - 1) * cw + sq,
                          -2 * ((A - 1) + (A + 1) * cw),
                          (A + 1) + (A - 1) * cw - sq])
        else:
            b = np.array([A * ((A + 1) + (A - 1) * cw + sq),
                          -2 * A * ((A - 1) + (A + 1) * cw),
                          A * ((A + 1) + (A - 1) * cw - sq)])
            a = np.array([(A + 1) - (A - 1) * cw + sq,
                          2 * ((A - 1) - (A + 1) * cw),
                          (A + 1) - (A - 1) * cw - sq])
    else:  # peaking
        alpha = sw / (2.0 * q)
        b = np.array([1 + alpha * A, -2 * cw, 1 - alpha * A])
        a = np.array([1 + alpha / A, -2 * cw, 1 - alpha / A])
    return b / a[0], a / a[0]


def _eq(y, sr, low_db, presence_db, high_db):
    out = y.astype(np.float64)
    for kind, freq, gain, q in (("lowshelf", 200.0, low_db, 0.9),
                                ("peaking", 2500.0, presence_db, 1.0),
                                ("highshelf", 6000.0, high_db, 0.9)):
        if gain == 0:
            continue
        b, a = _biquad(kind, freq, gain, q, sr)
        out = signal.lfilter(b, a, out)
    return out


def _ring_mod(y, sr, hz, depth):
    if depth <= 0:
        return y
    t = np.arange(len(y)) / float(sr)
    carrier = np.cos(2.0 * np.pi * hz * t)
    # sqrt(2) mengkompensasi RMS carrier agar level keseluruhan stabil.
    return (1.0 - depth) * y + depth * y * carrier * np.sqrt(2.0)


def _reverb(y, sr, wet, decay_ms):
    if wet <= 0:
        return y
    # IR noise deterministik (seed tetap) dgn peluruhan eksponensial;
    # decay_ms = waktu mencapai -40 dB.
    ir_len = int(min(0.6, decay_ms * 4.0 / 1000.0) * sr)
    if ir_len < 16:
        return y
    rng = np.random.default_rng(20261126)
    t = np.arange(ir_len) / float(sr)
    tau = (decay_ms / 1000.0) / np.log(10.0 ** (40.0 / 20.0))
    ir = rng.standard_normal(ir_len) * np.exp(-t / tau)
    ir = ir / (np.sqrt(np.sum(ir ** 2)) + 1e-12)
    wet_sig = signal.fftconvolve(y, ir, mode="full")[:len(y)]
    return (1.0 - wet) * y + wet * wet_sig


def apply_voice_fx(y, sr, pitch_semitones=0.0, style="normal", params=None):
    """Terapkan rantai FX. Mengembalikan (audio_float32, info dict).

    info: {pitchApplied, style, ms, stages:{pitch,ring,eq,reverb}}
    Urutan: pitch (user + offset preset Jarvis) -> ring mod -> EQ -> reverb.
    """
    p = dict(JARVIS_DEFAULTS)
    if params:
        for k, v in params.items():
            if k in p and v is not None:
                p[k] = float(v)
    out = np.asarray(y, dtype=np.float32).reshape(-1)
    stages = {}
    total_pitch = float(pitch_semitones or 0.0)
    if style == "jarvis":
        total_pitch += p["pitch_semitones"]
    t0 = time.perf_counter()
    if total_pitch != 0.0:
        out = pitch_shift(out, total_pitch)
    stages["pitch"] = (time.perf_counter() - t0) * 1000.0
    if style == "jarvis":
        t = time.perf_counter()
        out = _ring_mod(out.astype(np.float64), sr, p["ring_hz"], p["ring_depth"])
        stages["ring"] = (time.perf_counter() - t) * 1000.0
        t = time.perf_counter()
        out = _eq(out, sr, p["eq_low_db"], p["eq_presence_db"], p["eq_high_db"])
        stages["eq"] = (time.perf_counter() - t) * 1000.0
        t = time.perf_counter()
        out = _reverb(out, sr, p["reverb_wet"], p["reverb_decay_ms"])
        stages["reverb"] = (time.perf_counter() - t) * 1000.0
        out = out.astype(np.float32)
    # Jaring pengaman clipping sesudah gain EQ/ring.
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if peak > 0.99:
        out = (out * (0.99 / peak)).astype(np.float32)
    info = {
        "pitchApplied": total_pitch,
        "style": style,
        "ms": (time.perf_counter() - t0) * 1000.0,
        "stages": {k: round(v, 2) for k, v in stages.items()},
    }
    return out, info
