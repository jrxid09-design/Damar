"""Change-detection PoC: DINOv3 features vs a baseline image.

For every scene image, extract the CLS feature and the mean patch feature,
then compute cosine distances of every scene against the baseline
(scene_base.png). Expectation:
  base vs itself / JPEG round-trip / lighting-noise -> low
  base vs changed (truck added, tree removed, smoke) -> clearly higher
  base vs different scene -> highest
Usage: python poc.py <model.onnx> <label>
"""
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dinov3_core import cosine_distance, mean_patch_feature  # noqa: E402

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
WORK = os.path.dirname(os.path.abspath(__file__))
SCENES = ["scene_base.png", "scene_same_jpg.png", "scene_near.png",
          "scene_changed.png", "scene_different.png"]
NUM_PREFIX = 5  # 1 CLS + 4 register tokens (DINOv3 ViT)


def preprocess(path, size):
    im = Image.open(path).convert("RGB").resize((size, size), Image.BICUBIC)
    arr = np.asarray(im).astype(np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return arr.transpose(2, 0, 1)[None].astype(np.float32)


def features(sess, inp_name, path, size):
    out = sess.run(None, {inp_name: preprocess(path, size)})
    # find the 3-D token-sequence output
    seq = None
    for o in out:
        if o.ndim == 3:
            seq = o[0]
            break
    if seq is None:
        raise RuntimeError("no token-sequence output found")
    cls = seq[0]
    patch_mean = mean_patch_feature(seq, NUM_PREFIX)
    return cls, patch_mean


def main():
    model_path, label = sys.argv[1], sys.argv[2]
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    size = 512  # multiple of 16; 518 benchmark covers the requested size
    feats = {}
    for name in SCENES:
        cls, pm = features(sess, inp_name, os.path.join(WORK, "scenes", name), size)
        feats[name] = (cls, pm)
        print(f"{name}: cls dim={cls.shape[0]}")
    base_cls, base_pm = feats["scene_base.png"]
    rows = []
    for name in SCENES:
        cls, pm = feats[name]
        rows.append({
            "pair": f"scene_base vs {name.replace('scene_', '').replace('.png', '')}",
            "cls_cosine_distance": round(cosine_distance(base_cls, cls), 4),
            "patchmean_cosine_distance": round(cosine_distance(base_pm, pm), 4),
        })
    # extra cross-pair: changed vs different
    rows.append({
        "pair": "scene_changed vs scene_different",
        "cls_cosine_distance": round(cosine_distance(feats["scene_changed.png"][0],
                                                     feats["scene_different.png"][0]), 4),
        "patchmean_cosine_distance": round(cosine_distance(feats["scene_changed.png"][1],
                                                           feats["scene_different.png"][1]), 4),
    })
    result = {"model": label, "input_size": size, "rows": rows}
    out_path = os.path.join(WORK, f"poc_{label}.json")
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    for r in rows:
        print(f"{r['pair']:42s} cls={r['cls_cosine_distance']:.4f}  patch={r['patchmean_cosine_distance']:.4f}")
    print("written", out_path)


if __name__ == "__main__":
    main()
