"""DINOv3 change-detection provider — PROOF OF CONCEPT (reference impl).

STATUS: PoC, NOT wired into any production path. Nothing in Damar calls
this yet. It exists to prove the signal and to pin the integration shape
for the real Mata Dewa phase.

Integration shape (mirrors the canonical Core contracts found in
apps/desktop/core-snapshot/src/mataDewa/):

* The provider registers with the Mata Dewa ProviderRegistry
  (registry/providerRegistry.js) with a descriptor:
    {
      id: "dinov3-change", label: "DINOv3 Change Detection (local)",
      types: ["satellite", "asset"],            // observation types emitted
      accessMode: <keyless/local mode>, accessClass: "public",
      attribution: "Built with DINOv3",
      license: "DINOv3 License (Meta) — weights are NOT MIT; see README",
      fallbacks: [],                            // degrades honestly alone
      poll: async ({ bounds, credential }) => observations[],
      healthy: async () => boolean
    }
  Registry registration is DESCRIPTIVE — it never authorizes anything.

* poll() emits canonical SpatialObservation records (observations/
  observation.js, MD-005) per watch point whose latest frame was compared
  against its stored baseline:
    {
      schemaVersion: 1, id: "dinov3:<watchPointId>:<epochMs>",
      source: "dinov3-change", type: "asset" (or "satellite"),
      geometry: <watch point geometry>, observedAt, receivedAt,
      epistemic: <status>, confidence: <mapped from distance margin>,
      quality: <frame quality>, accessClass: "public",
      attributes: { changeDistance, changeBand, baselineId,
                    modelId, inputSize },
      mediaReference: <frame reference>, attribution: "Built with DINOv3",
      license: "DINOv3 License", lineage: [...]
    }
  Events/fusion and the proactive alert engine consume observations from
  there; a "significant" band would still require VLM verification before
  any alert — this provider only ever says "something changed", never
  what it means.

* Runtime: the heavy inference runs in a local worker (this Python
  reference, or an ONNX Runtime binding) OUTSIDE the Core process; Core
  only receives normalized observations. Weights are downloaded by the
  end user from Meta/HuggingFace under the DINOv3 License and are NEVER
  bundled with Damar (Damar's own code stays MIT).

This file implements the comparison core of poll(): image bytes in,
observation-shaped dict out. Model loading is lazy and injectable so the
logic is testable without weights.
"""
import io
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dinov3_core import classify_change, cosine_distance, mean_patch_feature  # noqa: E402

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
NUM_PREFIX_TOKENS = 5  # DINOv3 ViT: 1 CLS + 4 registers
DEFAULT_INPUT_SIZE = 512


def preprocess(image_bytes: bytes, size: int = DEFAULT_INPUT_SIZE) -> np.ndarray:
    im = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize(
        (size, size), Image.BICUBIC)
    arr = np.asarray(im).astype(np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return arr.transpose(2, 0, 1)[None].astype(np.float32)


class DinoV3ChangeDetector:
    """Wraps an ONNX Runtime session; one instance per loaded model."""

    def __init__(self, session, model_id: str, input_size: int = DEFAULT_INPUT_SIZE):
        self.session = session
        self.model_id = model_id
        self.input_size = input_size
        self._input_name = session.get_inputs()[0].name

    @classmethod
    def from_onnx(cls, path: str, model_id: str, input_size: int = DEFAULT_INPUT_SIZE):
        import onnxruntime as ort  # local import: keeps logic tests light

        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        return cls(sess, model_id=model_id, input_size=input_size)

    def embed(self, image_bytes: bytes) -> dict:
        """Return {'cls': vec, 'patchMean': vec} for one image."""
        feed = preprocess(image_bytes, self.input_size)
        outputs = self.session.run(None, {self._input_name: feed})
        seq = next(o[0] for o in outputs if o.ndim == 3)
        return {"cls": seq[0], "patchMean": mean_patch_feature(seq, NUM_PREFIX_TOKENS)}

    def compare(self, baseline_bytes: bytes, current_bytes: bytes) -> dict:
        """Distance signal between a stored baseline frame and a new frame."""
        base = self.embed(baseline_bytes)
        cur = self.embed(current_bytes)
        d_cls = cosine_distance(base["cls"], cur["cls"])
        d_patch = cosine_distance(base["patchMean"], cur["patchMean"])
        # CLS carries the global scene read; patch-mean is the tiebreaker.
        distance = float(max(d_cls, 0.5 * (d_cls + d_patch)))
        return {
            "distance": round(distance, 4),
            "clsDistance": round(float(d_cls), 4),
            "patchMeanDistance": round(float(d_patch), 4),
            "band": classify_change(distance),
            "modelId": self.model_id,
            "inputSize": self.input_size,
        }

    def to_observation(self, comparison: dict, *, watch_point_id: str,
                       baseline_id: str, geometry, observed_at_ms: int,
                       received_at_ms: int, media_reference: str | None = None) -> dict:
        """Shape a comparison result as a canonical SpatialObservation.

        Mirrors observations/observation.js fields. Confidence is a PoC
        mapping (band margin), NOT a calibrated probability.
        """
        band_conf = {"none": 0.9, "minor": 0.6, "significant": 0.75,
                     "scene-change": 0.85}[comparison["band"]]
        return {
            "schemaVersion": 1,
            "id": f"dinov3:{watch_point_id}:{observed_at_ms}",
            "source": "dinov3-change",
            "type": "asset",
            "geometry": geometry,
            "observedAt": observed_at_ms,
            "receivedAt": received_at_ms,
            "confidence": band_conf,
            "quality": 0.8,
            "accessClass": "public",
            "attributes": {
                "changeDistance": comparison["distance"],
                "clsDistance": comparison["clsDistance"],
                "patchMeanDistance": comparison["patchMeanDistance"],
                "changeBand": comparison["band"],
                "baselineId": baseline_id,
                "modelId": comparison["modelId"],
                "inputSize": comparison["inputSize"],
            },
            "mediaReference": media_reference,
            "attribution": "Built with DINOv3",
            "license": "DINOv3 License",
            "lineage": [{"step": "dinov3-change-poc", "baselineId": baseline_id}],
        }
