# AETHER CHARACTER — CANONICAL IMPLEMENTATION RULES

Aether is a DIGITAL ENTITY. Aether is NOT a humanoid robot.
The character must be constructed from independent floating holographic components.

Sumber kebenaran: file JSON di direktori ini (schema, geometry, materials, state).
Implementasi runtime: `apps/console/renderer/lib/avatar/entity.js`
 + `states.js`. Jika implementasi berkonflik dengan JSON, JSON yang benar.

## PRIMARY SILHOUETTE (mandatory)

1. Crown Halo — torus elips 240/205mm, z-scale 0.72, y=690
2. Spherical Interface Head — Ø210mm @ y=560, interior digital void,
   2 mata cyan oval-vertikal 15×25mm (separasi 55mm), tanpa mulut/hidung/telinga
3. Fragmented Orbital Shell — 8–16 curved shard TERPISAH, 115–180mm dari pusat
4. Central Diamond Cognitive Core — 145×105×80mm @ y=340, kolom energi vertikal
5. Vertical Energy Spine — 3–5 node diamond + beam, sumbu Y
6. Terminal Diamond — 35–50mm @ y=70
7. Concentric Levitation Field — 3–6 cincin horizontal 100–400mm @ y=0
8. Particle System — radial_dynamic 0.5–3mm

Tinggi referensi 700mm, Y_UP, 1 unit scene = 100mm.

## LARANGAN KERAS

Tidak ada: arms, hands, legs, feet, torso, armor, clothing,
mechanical joints, humanoid anatomy, robot body, metallic shell,
chrome, plastic robot shell, opaque armored material.

Fragmen orbital TIDAK boleh dilebur jadi satu mesh — harus terlihat
ruang negatif di antaranya.

## WARNA (aether-materials.json)

primary #00D9FF · secondary #0FAAFF · cognitive #7C5CFF ·
highlight #E8FCFF · error #FF3B3B · recovery #21E6A4 · background #050814

## STATE (aether-state.json)

IDLE FOCUSED THINKING ANALYZING EXECUTING CURIOUS HAPPY UNDERSTANDING
ALERT SURPRISED ERROR SLEEP RECOVERY
Transisi smooth-damped default 450ms; ANY→ALERT 150ms, ANY→ERROR 100ms,
ERROR→RECOVERY 1200ms, RECOVERY→IDLE 1000ms.
Ekspresi = geometri mata + brightness + partikel + orbit + core.
TANPA wajah manusia.
