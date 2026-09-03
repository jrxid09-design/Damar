# Mata Dewa — Capability Map (GEV Actions → Damar)

Wave 5 Lane 5. Mapping of God's Eye View's `GEV_REALTIME_TOOLS` (28 voice
tools, declared in upstream `vite.config.js`, dispatched by
`src/voice/gevActions.js`) onto **Damar-owned capabilities**. No AI-generated
imperative executes except through the Manager/canonical authority path.

## Registry

Capabilities are registered (descriptively) in the canonical Capability
Registry under provenance `provider:matadewa` via
`src/mataDewa/capabilities/index.js` (`buildMataDewaCapabilityRuntime()` —
21 descriptors, schema v1, kind `provider`). The registry never authorizes or
executes.

## Classification (`src/mataDewa/actions/executors.js`)

| Class | Meaning | Enforcement |
|---|---|---|
| `readonly` | pure observation/query | executable daemon-side, scoped |
| `ui_state` | changes UI state only | executed on the renderer surface |
| `governed` | writes core state | **refused direct execution** — must flow Action Intent → Authority → Actuation → Verification |

## GEV tool → Mata Dewa capability

| GEV tool | Capability | Class | Damar surface |
|---|---|---|---|
| fly_to_location | `mata_dewa.view.fly_to` | readonly | renderer (camera) |
| adjust_camera_zoom | `mata_dewa.view.zoom` | readonly | renderer |
| zoom_to_globe | `mata_dewa.view.globe` | readonly | renderer |
| move_camera | `mata_dewa.view.zoom` (orbit/pan args) | readonly | renderer |
| set_layer_visibility | `mata_dewa.layer.set` | ui_state | renderer + daemon registry |
| show_data_layers_menu | — (panel is Damar-owned UI) | ui_state | renderer |
| set_panel_open | — (Damar panel chrome) | ui_state | renderer |
| set_map_stack | `mata_dewa.map_stack.set` | ui_state | renderer |
| set_visual_style | `mata_dewa.style.set` | ui_state | renderer |
| set_post_processing | `mata_dewa.style.set` (part of styles) | ui_state | renderer |
| set_hud | Damar HUD toggle (renderer-local) | ui_state | renderer |
| set_detection | dropped (detection overlay not adopted) | — | — |
| set_context_mode | dropped (GEV cockpit concept) | — | — |
| control_cockpit | dropped (out of scope) | — | — |
| get_entity_context | `mata_dewa.entity.inspect` | readonly | daemon + renderer |
| get_current_view_state | renderer-local state read | readonly | renderer |
| track_entity | `mata_dewa.entity.track` | ui_state | renderer |
| stop_tracking | `mata_dewa.entity.untrack` | ui_state | renderer |
| select_nearest_aircraft | `view.fly_to` + `layer.set` + `entity.track` composed | mixed | composed by Manager, not a single bypass |
| frame_overhead | renderer camera preset (optional, not adopted v1) | — | — |
| annotate_map | `mata_dewa.annotation.draw` | ui_state | renderer |
| clear_annotations | `mata_dewa.annotation.clear` | ui_state | renderer |
| control_scene | `mata_dewa.scene.control` | ui_state | renderer |
| control_cctv | `mata_dewa.cctv.inspect` | readonly | daemon (fail-closed access) |
| control_radio | dropped (radio not adopted) | — | — |
| analyst_query | `mata_dewa.hazard.query` / `timeline.query` / `route.inspect` | readonly | daemon |
| next_iss_pass | `mata_dewa.hazard.query` (satellites layer) | readonly | daemon |
| fly_route | `mata_dewa.route.inspect` + camera fly (composed) | mixed | composed by Manager |

## Mata Dewa-only additions (no GEV equivalent)

| Capability | Class |
|---|---|
| `mata_dewa.mode.activate` / `.deactivate` | ui_state |
| `mata_dewa.watch.create` / `.remove` | **governed** |
| `mata_dewa.asset.import` | **governed** |

Governed capabilities are exposed to the owner only through the canonical
action fabric; `executeDaemonAction`/`executeUiAction` refuse them outright
(fail-closed) until wired to Authority after Lane 4 lands.

## LLM-facing tools (`src/plugins/mataDewa`)

Read-only tools in the Tool Intelligence path:
`mataDewa_status`, `mataDewa_hazard_query`, `mataDewa_timeline_query`,
`mataDewa_providers`, `mataDewa_assets_near`.
No state-writing tool is exposed to the LLM on purpose.

## Voice path

"Damar, aktifkan mode Mata Dewa" → Damar VoiceRuntime (untouched) →
`host.channels` → Manager → capability routing. The upstream OpenAI Realtime
runtime is not imported anywhere.
