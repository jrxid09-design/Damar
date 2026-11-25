# DINOv3 Change Detection — Mata Dewa PoC

**Status: PROOF OF CONCEPT.** This folder is a phase-1 feasibility spike on
branch `feat/mata-dewa-dinov3-poc`. It is NOT wired into any production
path: no production alert, watch, or fusion code calls it. It proves three
things with measured numbers (see the phase report `DINOV3.md` in the
project bridge folder):

1. DINOv3 runs acceptably on the owner's CPU-only PC (i5-14500) via ONNX
   Runtime — per-image latency and RAM for ViT-S/16 and ViT-B/16 at
   watch-point image sizes.
2. The change signal behaves: feature distance vs a baseline is low for
   the same scene (including recompression and lighting noise), clearly
   higher for a structurally changed scene, and highest for a different
   scene.
3. The integration shape into Mata Dewa's canonical provider registry
   and observation model is pinned (see `dinov3_change.py` docstring).

## Licensing — read before touching

Damar's own code is MIT. **The DINOv3 weights and Meta's model code are
NOT MIT and NOT Apache** — they are under the **DINOv3 License** (Meta,
August 14, 2025). Consequences baked into this design:

- Weights are **never bundled** with Damar. The end user downloads them
  from Meta/HuggingFace and accepts the DINOv3 License themselves.
- Any redistribution of the weights (or derivatives such as ONNX
  conversions) must carry the DINOv3 License and the notice
  "Built with DINOv3".
- Prohibited uses in that license (military/warfare, nuclear, espionage,
  ITAR-controlled activities, illegal weapons) apply to this feature.
- Full verdict + section citations: phase report `DINOV3.md`.

## Files

- `dinov3_core.py` — pure distance/banding math (numpy only).
- `dinov3_change.py` — detector + observation-shaped output (PoC wrapper).
- `gen_scenes.py` — deterministic self-made test scenes (no third-party
  imagery).
- `bench.py` — ONNX CPU benchmark (latency / RAM / load).
- `poc.py` — end-to-end distance matrix over the generated scenes.
- `test_change_logic.py` — unit tests for the pure math (plain asserts,
  no weights needed): `python test_change_logic.py`.

## What the real phase still needs

Per-watch-point baseline storage and refresh policy, threshold
calibration from real baseline history (the bands in `dinov3_core.py`
are placeholders), a frame-ingestion source per watch point, VLM
verification before any alert, and the registry/fusion wiring in Core.
None of that is in this PoC, deliberately.
