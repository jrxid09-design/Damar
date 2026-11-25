"""Per-patch change localization analysis (companion to poc.py).

For each variant, compute the cosine distance of every patch token vs the
baseline's corresponding patch token, then report mean / p95 / max and the
grid position of the most-changed patch. A structural change should light
up a LOCALIZED region (high max, modest mean); a global lighting change
should raise the mean slightly with no strong local spike.

Usage: python patch_analysis.py <model.onnx> <label>
"""
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
WORK = os.path.dirname(os.path.abspath(__file__))
NUM_PREFIX = 5
SIZE = 512
GRID = SIZE // 16  # 32 x 32 patches


def preprocess(path):
    im = Image.open(path).convert("RGB").resize((SIZE, SIZE), Image.BICUBIC)
    arr = np.asarray(im).astype(np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return arr.transpose(2, 0, 1)[None].astype(np.float32)


def patch_tokens(sess, inp, path):
    out = sess.run(None, {inp: preprocess(path)})
    seq = next(o[0] for o in out if o.ndim == 3)
    return seq[NUM_PREFIX:]


def main():
    model_path, label = sys.argv[1], sys.argv[2]
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name
    base = patch_tokens(sess, inp, os.path.join(WORK, "scenes", "scene_base.png"))
    base_n = base / np.linalg.norm(base, axis=1, keepdims=True)
    rows = []
    for name in ["scene_same_jpg.png", "scene_near.png", "scene_changed.png", "scene_different.png"]:
        cur = patch_tokens(sess, inp, os.path.join(WORK, "scenes", name))
        cur_n = cur / np.linalg.norm(cur, axis=1, keepdims=True)
        dists = 1.0 - np.sum(base_n * cur_n, axis=1)
        idx = int(np.argmax(dists))
        row, col = divmod(idx, GRID)
        rows.append({
            "variant": name,
            "patch_mean": round(float(dists.mean()), 4),
            "patch_p95": round(float(np.percentile(dists, 95)), 4),
            "patch_max": round(float(dists.max()), 4),
            "max_patch_grid": {"row": row, "col": col},
            "max_patch_region": f"x {(col * 1024 // GRID)}-{(col + 1) * 1024 // GRID}, "
                                f"y {(row * 1024 // GRID)}-{(row + 1) * 1024 // GRID} (of 1024)",
        })
        print(f"{name:24s} mean={rows[-1]['patch_mean']:.4f} p95={rows[-1]['patch_p95']:.4f} "
              f"max={rows[-1]['patch_max']:.4f} at row={row} col={col}")
    result = {"model": label, "input_size": SIZE, "grid": GRID, "rows": rows,
              "note": "Scene layout (1024px): truck added at x 600-862, y 872-988; "
                      "smoke plume at x ~855-1010, y ~450-610; tree removed at x ~950, y 640-940."}
    out_path = os.path.join(WORK, f"patch_{label}.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print("written", out_path)


if __name__ == "__main__":
    main()
