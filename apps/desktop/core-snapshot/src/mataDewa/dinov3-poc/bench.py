"""CPU benchmark for a DINOv3 ONNX model on Aether.

Usage: python bench.py <model.onnx> <label> [image.png]
Measures per-image latency at 518 and 1024 input sizes, peak process RAM,
and records machine load alongside (other workstreams share this PC).
If the exported graph rejects a size, the nearest multiple of 16 is used
and the actual size is recorded. For 1024, if direct inference fails, a
2x2 tiling of 518 tiles is used and the method is recorded.
"""
import json
import os
import statistics
import sys
import time

import numpy as np
import onnxruntime as ort
import psutil
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
WORK = os.path.dirname(os.path.abspath(__file__))


def preprocess(img: Image.Image, size: int) -> np.ndarray:
    im = img.convert("RGB").resize((size, size), Image.BICUBIC)
    arr = np.asarray(im).astype(np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return arr.transpose(2, 0, 1)[None].astype(np.float32)


def tiles(img: Image.Image, tile: int = 518) -> np.ndarray:
    im = img.convert("RGB").resize((tile * 2, tile * 2), Image.BICUBIC)
    out = []
    for ty in range(2):
        for tx in range(2):
            crop = im.crop((tx * tile, ty * tile, (tx + 1) * tile, (ty + 1) * tile))
            arr = np.asarray(crop).astype(np.float32) / 255.0
            arr = (arr - MEAN) / STD
            out.append(arr.transpose(2, 0, 1))
    return np.stack(out).astype(np.float32)


def run_timed(sess, feed, runs):
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        sess.run(None, feed)
        times.append((time.perf_counter() - t0) * 1000.0)
    return times


def bench_size(sess, inp_name, img, size, runs):
    """Returns dict with latency stats + method, or error info."""
    feed_arr = preprocess(img, size)
    try:
        for _ in range(2):
            sess.run(None, {inp_name: feed_arr})
        times = run_timed(sess, {inp_name: feed_arr}, runs)
        return {"method": "direct", "actual_size": size, "times_ms": times}
    except Exception as e:  # noqa: BLE001
        err = str(e)[:200]
    # fallback: tiling (only meaningful for the large size)
    if size >= 1000:
        feed_arr = tiles(img, 518)
        try:
            sess.run(None, {inp_name: feed_arr})
            times = run_timed(sess, {inp_name: feed_arr}, max(2, runs // 2))
            return {"method": "tile-2x2@518 (batch of 4)", "actual_size": size,
                    "times_ms": times, "direct_error": err}
        except Exception as e2:  # noqa: BLE001
            return {"method": "failed", "error": err + " | tile: " + str(e2)[:200]}
    # fallback: nearest multiple of 16
    alt = (size // 16) * 16
    if alt != size:
        try:
            feed_arr = preprocess(img, alt)
            sess.run(None, {inp_name: feed_arr})
            times = run_timed(sess, {inp_name: feed_arr}, runs)
            return {"method": f"direct at adjusted size {alt}", "actual_size": alt,
                    "times_ms": times, "direct_error": err}
        except Exception as e3:  # noqa: BLE001
            return {"method": "failed", "error": err + " | adj: " + str(e3)[:200]}
    return {"method": "failed", "error": err}


def stats(times):
    return {
        "runs": len(times),
        "mean_ms": round(statistics.mean(times), 1),
        "median_ms": round(statistics.median(times), 1),
        "min_ms": round(min(times), 1),
        "max_ms": round(max(times), 1),
    }


def main():
    model_path, label = sys.argv[1], sys.argv[2]
    img_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(WORK, "scenes", "scene_base.png")
    proc = psutil.Process()
    load_before = psutil.cpu_percent(interval=1.0)
    so = ort.SessionOptions()
    sess = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    outs = [(o.name, o.shape) for o in sess.get_outputs()]
    img = Image.open(img_path)
    rss0 = proc.memory_info().rss / 1e6

    result = {
        "label": label,
        "model_path": model_path,
        "model_file_mb": round((os.path.getsize(model_path) + (
            os.path.getsize(model_path + "_data") if os.path.exists(model_path + "_data") else 0)) / 1e6, 1),
        "ort_version": ort.__version__,
        "intra_op_threads": so.intra_op_num_threads,
        "input": {"name": inp.name, "shape": [str(s) for s in inp.shape]},
        "outputs": [(n, [str(s) for s in sh]) for n, sh in outs],
        "image": img_path,
        "cpu_percent_before": load_before,
        "sizes": {},
    }
    for size, runs in [(518, 15), (1024, 6)]:
        r = bench_size(sess, inp.name, img, size, runs)
        if "times_ms" in r:
            r["stats"] = stats(r.pop("times_ms"))
        result["sizes"][str(size)] = r
        result[f"cpu_percent_after_{size}"] = psutil.cpu_percent(interval=0.5)
    info = proc.memory_info()
    result["process_rss_mb"] = round(info.rss / 1e6, 1)
    result["process_rss_start_mb"] = round(rss0, 1)
    peak = getattr(info, "peak_wset", None)
    result["process_peak_wset_mb"] = round(peak / 1e6, 1) if peak else None
    out_path = os.path.join(WORK, f"bench_{label}.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
    print("written", out_path)


if __name__ == "__main__":
    main()
