# RF Sensing (Wi-Fi CSI) — Reference Audit & Adoption

Status: **Phase B foundation** — honest, bounded, replay-first. No fabricated
sensing claims. Every capability is scoped to what the reference material
actually supports, and everything unproven is labeled PREDICTED/unvalidated.

## 1. Reference repos audited (cloned shallow, 2026-09)

| Repo | License | What it actually gives us |
|---|---|---|
| `espressif/esp-csi` (Apache-2.0) | Apache-2.0 | Canonical ESP32 CSI capture: `wifi_csi_info_t` callback shape, CSV/JSON frame format (`type,id,mac,rssi,rate,...,data` where `data` is a JSON array of interleaved **imag,real** int8 pairs), subcarrier counts per PHY mode (52/56/106/114/234/490...), `get-started/tools/csi_data_read_parse.py` as the parsing reference, `esp-radar/wifi_sensing_demo` as the streaming reference. |
| `xyanchen/WiFi-CSI-Sensing-Benchmark` ("SenseFi", MobiCom'23 benchmark) | MIT | Reference model zoo (MLP/LeNet/ResNet18/LSTM/BiLSTM/Transformer over 250×90 amplitude tensors for UT-HAR; 342-dim sequences for NTU-Fi), normalization convention (global min-max), train/eval split discipline. We adopt the **evaluation honesty** (held-out accuracy only), not the models themselves (Python/PyTorch — Damar is Node). |
| `Wi-Pose/Wi-Pose` (paper code, no license file — treat as reference-only) | none declared | Signal→image pipeline: DWT (db4) denoising + Butterworth low-pass, timestamp-gap interpolation, complex→amplitude (`abs`) and →phase (`arctan(imag/real)`) per subcarrier, min-max image normalization. Adopted as **processing-stage reference** for the bounded DSP chain. NOT copied (no license ⇒ no code reuse; concepts only). |
| `ruvnet/RuView` (MIT) | MIT | End-to-end product framing on ESP32-S3: ADR-018 **binary CSI frame format** (magic `0xC5110001` LE; node id u8; antenna count u8; subcarrier count u16 LE; freq MHz u32 LE; seq u32 LE; RSSI i8; noise floor i8; reserved 2B; raw I/Q bytes), 50 Hz software gate (`CSI_MIN_PROCESS_INTERVAL_US = 20ms`) to keep the WiFi ISR healthy, channel-hop table with dwell time, and — importantly — **honest claim retraction** (v2 "100% presence" retracted for a label-free held-out 82.3% temporal-triplet accuracy). RVF container (64-byte segment headers, CRC32) for model packaging — noted, not adopted in v1. |

### What the references do NOT establish
- No peer-reviewed evidence in any of these repos that commodity-ESP32 CSI
  alone yields reliable **per-person identity, pose keypoints, or vital signs
  in arbitrary rooms**. Wi-Pose/SenseFi results are dataset-specific
  (UT-HAR, NTU-Fi, Widar), lab-controlled, single-room.
- RuView's own docs concede presence/accuracy caveats and require CSI-capable
  hardware (ESP32-S3/C6 or research NIC); plain laptops give RSSI only.
- Therefore: Damar v1 ships **presence / motion / occupancy ESTIMATES with
  explicit epistemic status and confidence**, never identity, never "pose",
  never vital signs. Anything beyond that requires real-data validation that
  does not exist yet.

## 2. Damar adoption decisions

| Reference element | Decision |
|---|---|
| ESP32 CSI JSON-CSV format (esp-csi) | **Adopted** as the canonical replay format for the file/replay source (`parseEspCsiCsvLine`). Interleaved imag/real int8 pairs, per-frame metadata (rssi, channel, timestamp, agc/fft gain). |
| RuView ADR-018 binary frame | **Adopted** as the live UDP source wire format (`parseRuviewFrame`): magic check, node id, subcarrier count, freq, seq, RSSI, noise floor, raw I/Q. Bounded decode (max subcarriers, max frame bytes). |
| 50 Hz software gate (RuView) | **Adopted** as `maxRateHz` bound on sources — protects the daemon from flood (the same ISR-health reasoning applies to the receiving side). |
| DWT denoise + Butterworth (Wi-Pose) | **Adopted conceptually** as a bounded smoothing stage (moving-median + one-pole IIR equivalents in pure JS); no pywt dependency. |
| SenseFi normalization & eval discipline | **Adopted**: global min-max amplitude normalization; metrics reported only as held-out/label-free numbers; models stay out of scope for v1 (no ML runtime in Damar core). |
| RuView honesty posture | **Adopted as law**: every RF observation carries `epistemic` (OBSERVED for raw CSI-derived signal metrics, INFERRED for motion/presence estimates), `confidence`, and lineage (`sensorId`, `captureSession`). No identity claims. No pose claims. No vital-sign claims. |

## 3. Architecture (v1, inside Mata Dewa — no new listener, no second service)

```
RF sources (trusted composition only)
  ├─ replay source: .csi.csv / .ndjson files (bounded read)     [v1, offline-safe]
  ├─ udp source: RuView ADR-018 frames                          [v1.1, local bind only]
  └─ esp serial source                                          [post-Lane4 hardware]
        │  (all frames enter via ONE boundary: rfSource → validate → bound)
        ▼
  rf/capture/  source abstraction + parsers + ring buffer (bounded)
        ▼
  rf/processing/  subcarrier amplitude/phase, normalization,
                  variance/motion energy per window, presence/motion ESTIMATE
        ▼
  observations (canonical SpatialObservation, types rf.*)
        ├─ rf.csi.channel_state      (OBSERVED — raw signal metrics)
        ├─ rf.channel_change         (OBSERVED — hop events)
        ├─ rf.motion_estimate        (INFERRED — motion energy → motion)
        ├─ rf.presence_estimate      (INFERRED — variance above quiet baseline)
        └─ rf.zone_occupancy_estimate (INFERRED — count-class estimate, coarse)
        ▼
  fusion (lineage: sensorId + captureSession = ONE independence group;
          RF observations are same-sensor correlated, never counted as
          independent corroboration of each other)
        ▼
  watch engine (hazard evaluator: rf presence/motion → asset watch events)
  capabilities (mata_dewa.rf.* — descriptive registry, governed actions via
          Action Fabric; read-only query surfaces via daemon executor)
```

Laws carried over from Phase A:
- **One network boundary** — RF UDP/serial capture is a LOCAL ingress, not an
  HTTP client; it never uses provider/http.js and never dials out.
- **AUTHORIZED_LOCAL_SOURCE fail-closed** — an RF sensor on the LAN is an
  authorized local source; until Lane 4 device trust exists, only the
  replay (file) source is enabled by default. UDP bind requires explicit
  trusted-composition opt-in (`allowLocalUdp: true`) with a fixed loopback
  bind address, or it refuses.
- **Strict schemas** — every RF observation goes through
  `normalizeObservation` (reject-not-clamp, deep-frozen, bounded).
- **Honest state machine** — the RF "provider" reports `not_proven_yet`
  until a source actually delivers frames; a replay source that parsed
  zero frames is UNAVAILABLE, not AVAILABLE.
- **Lineage** — `sensorId`/`captureSession` populate
  `independenceGroup`; two nodes of one capture are one group.

## 4. Claim validation policy (binding)

| Claim | Status in v1 | Evidence required to upgrade |
|---|---|---|
| "CSI frames captured/parsed" | OBSERVED — allowed | Frame checksums/counts from the source itself |
| "Motion detected near sensor" | INFERRED estimate — allowed with confidence + window | Motion energy vs quiet-baseline variance, per-session calibration |
| "Someone is present" | INFERRED estimate — allowed, coarse | Same + multi-sensor agreement (still not identity) |
| "Zone occupancy = N people" | INFERRED estimate — coarse only | Reference-grade validation does not exist for ESP32-class data; label explicitly coarse |
| "Identity / pose / heart rate" | **NOT CLAIMED** | Would require peer-reviewed, room-independent validation — absent in all four references |

Any UI or alert copy that would imply a stronger claim than the epistemic
status of the underlying observation is a defect, not a feature.

## 5. Test posture

- Parsers: golden vectors (valid, truncated, hostile, oversized), round-trip
  replay determinism, bounded memory.
- Processing: synthetic CSI with known injected motion — estimator must
  separate quiet vs motion windows; must NOT fire on flat noise.
- Boundary: replay source never touches network; UDP source refuses without
  explicit opt-in; oversized/flooded streams are dropped, not buffered.
- Honesty: zero-frame sources are UNAVAILABLE; estimates carry epistemic
  INFERRED; fusion counts one capture session as one independence group.
