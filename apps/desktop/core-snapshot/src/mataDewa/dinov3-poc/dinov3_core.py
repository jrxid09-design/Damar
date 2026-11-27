"""Pure change-detection logic for the DINOv3 Mata Dewa PoC.

Kept dependency-light (numpy only) so the math is unit-testable without
ONNX Runtime or the model weights. The provider-shaped wrapper lives in
dinov3_change.py.
"""
import numpy as np

# PoC placeholder bands on CLS cosine distance (1 - cosine similarity).
# These are NOT production thresholds: the real phase must calibrate per
# watch point from that point's own baseline history.
CHANGE_BANDS = (
    (0.02, "none"),          # capture noise / re-encode level
    (0.08, "minor"),         # lighting/season-level variation
    (0.20, "significant"),   # structural change worth a second look
    (float("inf"), "scene-change"),  # different scene altogether
)


def l2_normalize(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    n = float(np.linalg.norm(v))
    if n == 0.0 or not np.isfinite(n):
        raise ValueError("cannot normalize a zero/non-finite vector")
    return v / n


def cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """1 - cosine similarity, in [0, 2]. Identical direction -> 0."""
    d = 1.0 - float(np.dot(l2_normalize(a), l2_normalize(b)))
    return min(2.0, max(0.0, d))


def l2_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Euclidean distance between the L2-normalized vectors."""
    return float(np.linalg.norm(l2_normalize(a) - l2_normalize(b)))


def mean_patch_feature(tokens: np.ndarray, num_prefix_tokens: int) -> np.ndarray:
    """Average the patch tokens of a (tokens, dim) sequence.

    DINOv3 ViT emits [CLS, register x N, patch ...]; the caller passes how
    many leading tokens to skip (1 CLS + 4 registers = 5 for DINOv3).
    """
    tokens = np.asarray(tokens)
    if tokens.ndim != 2 or tokens.shape[0] <= num_prefix_tokens:
        raise ValueError("token sequence too short")
    return tokens[num_prefix_tokens:].mean(axis=0)


def classify_change(distance: float, bands=CHANGE_BANDS) -> str:
    """Map a cosine distance to a qualitative change band (PoC bands)."""
    if not np.isfinite(distance) or distance < 0:
        raise ValueError("distance must be finite and >= 0")
    for limit, label in bands:
        if distance < limit:
            return label
    return bands[-1][1]
