"""Unit tests for the pure change-detection math (dinov3_core).

Run with plain python (no test framework needed):
    python test_change_logic.py
or under pytest. Every check is an assert on a mathematical property —
no model weights, no ONNX Runtime involved.
"""
import numpy as np

from dinov3_core import (
    classify_change,
    cosine_distance,
    l2_distance,
    l2_normalize,
    mean_patch_feature,
)


def test_identical_vectors_have_zero_distance():
    v = np.array([1.0, 2.0, 3.0])
    assert cosine_distance(v, v) == 0.0
    assert l2_distance(v, v) == 0.0


def test_scale_invariance():
    v = np.array([1.0, 0.0])
    assert cosine_distance(v, v * 7.5) == 0.0


def test_orthogonal_and_opposite():
    a = np.array([1.0, 0.0])
    b = np.array([0.0, 1.0])
    c = np.array([-1.0, 0.0])
    assert abs(cosine_distance(a, b) - 1.0) < 1e-9
    assert abs(cosine_distance(a, c) - 2.0) < 1e-9
    assert abs(l2_distance(a, b) - np.sqrt(2)) < 1e-9


def test_monotonic_small_perturbations():
    rng = np.random.default_rng(7)
    base = rng.normal(size=64)
    d_small = cosine_distance(base, base + rng.normal(scale=0.01, size=64))
    d_big = cosine_distance(base, base + rng.normal(scale=0.6, size=64))
    d_other = cosine_distance(base, rng.normal(size=64))
    assert 0.0 <= d_small < d_big < d_other


def test_normalize_rejects_zero_vector():
    try:
        l2_normalize(np.zeros(4))
    except ValueError:
        return
    raise AssertionError("zero vector must be rejected")


def test_mean_patch_feature_skips_prefix():
    tokens = np.arange(20, dtype=np.float64).reshape(10, 2)
    out = mean_patch_feature(tokens, 5)
    assert np.allclose(out, tokens[5:].mean(axis=0))
    try:
        mean_patch_feature(tokens[:5], 5)
    except ValueError:
        return
    raise AssertionError("short sequence must be rejected")


def test_classify_change_bands_are_ordered():
    assert classify_change(0.0) == "none"
    assert classify_change(0.05) == "minor"
    assert classify_change(0.12) == "significant"
    assert classify_change(0.9) == "scene-change"
    try:
        classify_change(float("nan"))
    except ValueError:
        return
    raise AssertionError("NaN distance must be rejected")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("PASS", fn.__name__)
    print(f"{len(fns)} tests passed")
