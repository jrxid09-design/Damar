(function (root) {
  'use strict';
  // Damar Notch character - 3D STAGE (feat/notch-3d-base, 2026-11-25).
  // The Owner's final base model (Character_Base_Damar.blend, built by the
  // Owner after rejecting the v4 per-part 2D rig: "2D yang dipaksakan
  // bergerak") rendered live with three.js: a skinned GLB (47 joints) whose
  // baked clips are the Owner's own performance - Character_RigAction
  // (bone life, 120 frames @24fps, looped), Body_Head (Jaw_Open), Eyelid.L/R
  // (Blink) and Mouth_Details + Speech_Mouth (Mouth_Open/Wide/Round).
  //
  // HIDUP overhaul (Owner: "Gasss", 2026-11-25 09:43 WIB - the frozen build
  // was "diem kayak patung, gerak pun terbata-bata kayak robot"), with the
  // Owner's parity directive (10:07 WIB): "Buat sama persis seperti Coucou,
  // cuma karakternya aja yang diubah." The character layer therefore
  // mirrors Coucou's behavior engine numbers (read from its MIT source;
  // behavior patterns only - no Coucou assets, name or voice) with the
  // Owner's 3D model, anime/cel materials, black eyes and full-body
  // framing as the only substitutions. Where the 2D source cannot map
  // 1:1 onto a boned 3D model, the adaptation is noted inline and in
  // NOTCH-HIDUP.md.
  //
  // - PROCEDURAL LIFE is the primary driver: breath (Coucou's group-scale
  //   breathing, ALWAYS on for Damar per Owner - plus a bone-level breath
  //   Coucou cannot do), sway, weight shift, gaze, blink, idle activities.
  //   Everything is smooth functions + springs integrated with 240 Hz
  //   sub-steps (Coucou's spring model: SwiftUI response/damping), delta-
  //   clamped and framerate-independent. The bind pose is a natural
  //   standing pose (verified by render), so the baked rig clip is DEMOTED
  //   to an accent (dance windows); the baked eyelid clips are off -
  //   procedural blink owns the lids (Coucou timing: 70 ms close to 0.94,
  //   130 ms open, every 2.2 + rand*3.2 s, 22% double at +230 ms).
  // - GREETING: Coucou's 4.6 s launch choreography (grow + fall, landing
  //   squash, stretch, side slide, wave, tuck, scripted blinks/gaze, gold
  //   ember bursts in place of their warp streaks) runs when the notch
  //   appears; a 2 s small greet runs on expanded entry / greet().
  // - ANIME/CEL look: every material gets a luminance-banding patch
  //   (hue-preserving, 4 bands - the recipe of the Owner-approved
  //   reference renders) at the tail of the fragment shader; Eye_Detail
  //   materials get the black-eye variant (iris collapses near-black,
  //   sparkles/specular > 0.72 survive, glossy roughness 0.22).
  // - Framing: stage camera fits the FULL BODY (flame tip to boots); the
  //   compact head slot keeps its peek framing (physical 288x32 pill).
  // - INSIDE (Owner correction 2026-11-25 13:56 WIB: "Karakternya kok di
  //   luar notch" - the PERCH apron of 2b501dbb is SUPERSEDED): like
  //   Coucou, the character lives INSIDE the island in every state. In
  //   compact/morph it is the in-bar mini (the head view, face framing,
  //   sitting at the bar's left like Coucou's compact mini); in the
  //   expanded island the stage shows it FULL BODY, uncut, inside the
  //   box. The ambient stroll (procedural thigh/shin/foot walk cycle on
  //   the rig bones, heading turn at the ends) now walks the STAGE view
  //   inside the open island, its rendered corridor scaled to whatever
  //   width the stage framing actually shows; any interaction or
  //   higher-priority state preempts it.
  // - Speech stays the existing envelope path, layered UNDER the life
  //   layer; the life layer never writes mouth channels. The mouth spring
  //   uses Coucou's speech spring (response 0.25 s, damping 0.6).
  // - Costumes: the base model ships ONE outfit. setCostume keeps the 2D
  //   rig's validation contract and records the choice; a costume change
  //   still performs Coucou's swap envelope (out 180 ms, in 350 ms +
  //   squash) on the stage root - never an instant swap - ready to carry
  //   the real swap when costume models land (Owner: costumes later).
  // - The model bytes arrive over the allowlisted IPC bridge
  //   (window.damarDesktop.getNotchModel) - the renderer has no fetch
  //   (CSP connect-src 'none', scheme supportFetchAPI:false by design).
  // - Any failure (no WebGL, no three.js, bad bytes) degrades the slot to
  //   the static flame mark; the island never breaks.

  const EMOTES = ['senang', 'berpikir', 'siaga', 'pulih', 'orbStandby', 'annoyed', 'dizzy'];
  const COSTUMES = ['chef', 'hacker', 'engineer', 'detective', 'artist', 'matadewa'];
  const CLIP = {
    rig: 'Character_RigAction', head: 'Body_Head_MeshAction',
    lidL: 'Eyelid.L_MeshAction', lidR: 'Eyelid.R_MeshAction',
    mouthDetails: 'Mouth_Details_MeshAction', speech: 'Speech Mouth MeshAction.001',
  };
  const SPEECH_CLIP_KEYS = ['head', 'mouthDetails', 'speech'];
  const FALLBACK_IMG = '/damaricon-clean.png';

  const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
  const clampGaze = (x, y) => { const m = Math.hypot(x || 0, y || 0); const s = m > 1 ? 1 / m : 1; return { x: (x || 0) * s, y: (y || 0) * s }; };
  function stepSpring(st, target, dt, k, d) {                     // semi-implicit Euler spring (same as the 2D rig)
    const a = (target - st.x) * k - st.v * d;
    st.v += a * dt; st.x += st.v * dt;
    return st;
  }
  // Coucou spring model: SwiftUI-style (omega0 = 2PI/response, zeta =
  // dampingFraction), integrated with 240 Hz sub-steps for stability.
  function swiftSpring(response, damping) {
    const w = (Math.PI * 2) / response;
    return { k: w * w, d: 2 * damping * w };
  }
  const SPRING_MAIN = swiftSpring(0.5, 0.72);   // Coucou default character spring
  const SPRING_MOUTH = swiftSpring(0.25, 0.6);  // Coucou speech spring
  function stepSpringSub(st, target, dt, k, d) {
    const n = Math.max(1, Math.min(16, Math.ceil(dt / (1 / 240))));
    const h = dt / n;
    for (let i = 0; i < n; i++) stepSpring(st, target, h, k, d);
    return st;
  }
  const easeOutCubic = (u) => 1 - Math.pow(1 - clamp01(u), 3);
  const easeInQuad = (u) => { const x = clamp01(u); return x * x; };
  const easeInOutQuad = (u) => { const x = clamp01(u); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; };
  function easeOutBack(u) {
    const x = clamp01(u);
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);
  }
  // Poke verdicts, Coucou slap rules: 3 slaps inside 1.7 s -> dizzy;
  // a rapid second slap -> annoyed; a lone poke -> squash.
  function pokeVerdict(times, now) {
    const w = times.filter(t => now - t < 1700);
    if (w.length >= 3) return 'dizzy';
    if (w.length >= 2) return 'annoyed';
    return 'squash';
  }
  // Voice envelope -> viseme-ish morph weights. Deterministic in (level, t):
  // open tracks the envelope 1:1; wide/round are slower envelope-gated
  // swells so the mouth changes shape while talking instead of flapping on
  // one axis. Everything is exactly 0 at level 0 - silence is a closed mouth.
  function speechMorphs(level, t) {
    const l = clamp01(level);
    if (l <= 0.001) return { Mouth_Open: 0, Mouth_Wide: 0, Mouth_Round: 0, Jaw_Open: 0 };
    return {
      Mouth_Open: l,
      Mouth_Wide: l * 0.45 * (0.5 + 0.5 * Math.sin(t * 6.3)),
      Mouth_Round: l * 0.30 * Math.max(0, Math.sin(t * 2.9 + 1.3)),
      Jaw_Open: l * 0.85,
    };
  }
  // Emote -> emphasis only (radians / unitless). The behavior engine picks
  // the emote; the 3D model has one face, so an emote leans the head, slows
  // or quickens the baked life and stills or frees the bob. No fake faces.
  const EMOTE_EMPHASIS = {
    senang: { pitch: -0.03, roll: 0.00, rate: 1.00, bob: 1.0 },
    berpikir: { pitch: 0.06, roll: 0.07, rate: 0.95, bob: 0.7 },
    siaga: { pitch: -0.07, roll: 0.00, rate: 1.06, bob: 0.4 },
    pulih: { pitch: 0.12, roll: 0.02, rate: 0.80, bob: 0.5 },
    orbStandby: { pitch: 0.10, roll: 0.00, rate: 0.70, bob: 0.4 },
    annoyed: { pitch: 0.03, roll: -0.06, rate: 1.00, bob: 0.6 },
    dizzy: { pitch: 0.02, roll: 0.10, rate: 0.90, bob: 0.8 },
  };
  function emoteEmphasis(e) { return EMOTE_EMPHASIS[e] || EMOTE_EMPHASIS.senang; }
  // The Owner's Blender export carries an emissive factor + strength on the
  // outfit materials but no emissive texture (in Blender the emission is
  // texture-masked). Unmasked, three.js glows the whole outfit orange and
  // washes out the navy design. Masking the emission with the material's own
  // diffuse map reproduces the Blender look: dark cloth stays dark, the gold
  // trim glows. Materials without a diffuse map keep their flat emission.
  function maskEmissiveWithDiffuse(rootObj) {
    let masked = 0;
    if (!rootObj || typeof rootObj.traverse !== 'function') return 0;
    rootObj.traverse((obj) => {
      if (!obj || !obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if (!m || !m.emissive || !m.map || m.emissiveMap) return;
        const strength = typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1;
        if ((m.emissive.r + m.emissive.g + m.emissive.b) * strength <= 0.01) return;
        m.emissiveMap = m.map;
        masked += 1;
      });
    });
    return masked;
  }

  // ---- anime/cel shading + black eyes -------------------------------------
  // JS mirrors of the shader math (single source of truth for the tests;
  // the GLSL below implements the identical recipe at the tail of the
  // fragment shader, i.e. on final display-space color - the same place
  // the approved reference renders were banded).
  // 4 cel bands over luminance, hue preserved by ratio scaling.
  function celBandLum(lum) {
    const l = Math.max(0, lum || 0);
    if (l < 0.16) return 0.30;
    if (l < 0.38) return 0.55;
    if (l < 0.62) return 0.78;
    return 1.0;
  }
  // Eye rule: bright sparkle/specular (lum > 0.72) is kept verbatim (null);
  // everything else collapses to near-black with a whisper of the original
  // shading so the eyeball keeps its form.
  function eyeShadeLum(lum) {
    const l = Math.max(0, lum || 0);
    if (l > 0.72) return null;
    return 0.040 + 0.06 * l;
  }
  // Band gain, clamped: an uncapped band/lum ratio blows very dark
  // saturated pixels out (measured in the A/B harness: the eyelid crease's
  // dark crimson, lum ~0.07, would scale x4.5 into a vivid red band over
  // the eye, and the navy hood blew out to royal blue). Cap x2.0, floor
  // x0.55 so banding lifts shadows without inventing color.
  function celScale(lum) {
    const l = Math.max(0, lum || 0);
    if (l <= 0.004) return 1;
    return Math.max(0.55, Math.min(2.0, celBandLum(l) / l));
  }
  const CEL_GLSL = `
  {
    vec3 dnCel = gl_FragColor.rgb;
    float dnLum = dot(dnCel, vec3(0.299, 0.587, 0.114));
    float dnBand = dnLum < 0.16 ? 0.30 : (dnLum < 0.38 ? 0.55 : (dnLum < 0.62 ? 0.78 : 1.0));
    float dnScale = dnLum > 0.004 ? clamp(dnBand / dnLum, 0.55, 2.0) : 1.0;
    dnCel *= dnScale;
    float dnLum2 = dot(dnCel, vec3(0.299, 0.587, 0.114));
    gl_FragColor.rgb = mix(vec3(dnLum2), dnCel, 1.10);
  }
  `;
  const CEL_EYE_GLSL = `
  {
    vec3 dnEye = gl_FragColor.rgb;
    float dnEyeLum = dot(dnEye, vec3(0.299, 0.587, 0.114));
    if (dnEyeLum <= 0.72) dnEye = vec3(0.040, 0.032, 0.042) + dnEye * 0.06;
    else dnEye = mix(dnEye, vec3(dnEyeLum), 0.65);
    gl_FragColor.rgb = dnEye;
  }
  `;
  function celPatchGeneric(shader) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>', CEL_GLSL + '\n#include <dithering_fragment>');
  }
  function celPatchEye(shader) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>', CEL_EYE_GLSL + '\n#include <dithering_fragment>');
  }
  // Patch every material of the parsed model once (SkeletonUtils clones
  // share materials, so all views inherit). Eye materials are the ones the
  // Eye_Detail meshes use. Returns the number of materials patched.
  function celShadeModel(rootObj) {
    if (!rootObj || typeof rootObj.traverse !== 'function') return 0;
    const eyeMats = new Set(); const allMats = new Set();
    rootObj.traverse((obj) => {
      if (!obj || !obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if (!m) return;
        allMats.add(m);
        if (typeof obj.name === 'string' && obj.name.indexOf('Eye_Detail') === 0) eyeMats.add(m);
      });
    });
    let patched = 0;
    allMats.forEach((m) => {
      m.userData = m.userData || {};
      if (m.userData.__cel) return;
      if (eyeMats.has(m)) {
        m.userData.__cel = 'eye';
        m.onBeforeCompile = celPatchEye;
        if ('roughness' in m) m.roughness = 0.22;   // glossy: light glints survive as sparkle
        if ('metalness' in m) m.metalness = 0.0;
      } else {
        m.userData.__cel = 'cel';
        m.onBeforeCompile = celPatchGeneric;
      }
      patched += 1;
    });
    return patched;
  }

  // ---- procedural life: pure helpers (Coucou numbers) ----------------------
  // One blink, Coucou timing: close to depth 0.94 in 70 ms (easeInOut),
  // reopen in 130 ms (easeOut). Argument is ms since blink start.
  function blinkWeight(ms) {
    if (!(ms >= 0) || ms >= 200) return 0;
    if (ms < 70) return 0.94 * easeInOutQuad(ms / 70);
    return 0.94 * Math.pow(1 - (ms - 70) / 130, 3);
  }
  // Next idle blink delay in seconds: 2.2 + rand*3.2 (Coucou).
  function blinkDelay(rand) { return 2.2 + clamp01(rand) * 3.2; }
  // Wander gaze target inside the comfortable cone.
  function gazeWander(r1, r2) { return { x: (r1 * 2 - 1) * 0.72, y: (r2 * 2 - 1) * 0.38 + 0.04 }; }
  // Poke squash timeline (Coucou): sy 1 -> 0.78 in 70 ms, -> 1.10 in the
  // next 130 ms, -> 1 in the last 170 ms. Returns {sx, sy} multipliers.
  function pokeSquash(ms) {
    if (!(ms >= 0) || ms >= 370) return { sx: 1, sy: 1 };
    let sy;
    if (ms < 70) sy = 1 - 0.22 * easeOutCubic(ms / 70);
    else if (ms < 200) sy = 0.78 + 0.32 * easeInOutQuad((ms - 70) / 130);
    else sy = 1.10 - 0.10 * easeOutCubic((ms - 200) / 170);
    return { sx: 1 - (sy - 1) * 0.6, sy };
  }
  // Error head-shake (Coucou): segment times 50/70/70/90 ms, yaw keyframes.
  const SHAKE_KEYS = [[0, 0], [50, 0.14], [120, -0.14], [190, 0.09], [280, 0]];
  function headShake(ms) {
    if (!(ms >= 0) || ms >= 280) return 0;
    for (let i = 1; i < SHAKE_KEYS.length; i++) {
      if (ms <= SHAKE_KEYS[i][0]) {
        const [t0, v0] = SHAKE_KEYS[i - 1]; const [t1, v1] = SHAKE_KEYS[i];
        return v0 + (v1 - v0) * ((ms - t0) / (t1 - t0));
      }
    }
    return 0;
  }
  // Costume swap envelope (Coucou): out 180 ms, in 350 ms back-ease.
  function costumeScale(sec) {
    if (!(sec >= 0) || sec >= 0.53) return 1;
    if (sec < 0.18) return 1 - 0.10 * easeInQuad(sec / 0.18);
    return 0.90 + 0.10 * easeOutBack((sec - 0.18) / 0.35);
  }
  // ---- stage stroll: pure walk math ---------------------------------------
  // Horizontal travel of the stroll, in world units (the model stands
  // ~1.71 tall). The simulation corridor is +-1.35; the stage view scales
  // the rendered offset to the width its framing actually shows, so the
  // character always stays inside the island (see walkScale at the stage
  // root composition).
  const WALK_RANGE = 1.35;
  const WALK_SPEED = 0.5; // world units / s - a stroll, not a commute
  // One walk cycle as a pure pose function of phase (radians; 2PI = two
  // steps). Sign convention of the rig: rotation.x negative swings a limb
  // FORWARD (the point gesture raises the arm at x -1.32); a knee bends
  // at positive x. Legs anti-phase, knees lift on the swing-through, arms
  // counter-swing against their leg, the body bobs twice per cycle and
  // leans into the walk.
  function walkPose(phase) {
    const s = Math.sin(phase), c = Math.cos(phase);
    const thighL = -0.52 * s, thighR = 0.52 * s;
    const shinL = 0.62 * Math.max(0, Math.cos(phase - 0.5));
    const shinR = 0.62 * Math.max(0, -Math.cos(phase - 0.5));
    return {
      thighL, thighR, shinL, shinR,
      footL: -(thighL + shinL) * 0.5, footR: -(thighR + shinR) * 0.5,
      armL: 0.30 * s, armR: -0.30 * s,
      bob: Math.abs(c) * 0.022, lean: 0.07,
      pelvisRoll: s * 0.045, pelvisYaw: c * 0.05,
    };
  }
  // Pick a stroll target: always inside the corridor, always a real walk
  // (the longer side wins; >= 0.7 of travel whenever the corridor allows).
  function pickWalkTarget(x, rand) {
    const r = clamp01(rand);
    const dir = x > 0.12 ? -1 : x < -0.12 ? 1 : (r < 0.5 ? -1 : 1);
    const room = dir > 0 ? WALK_RANGE - x : x + WALK_RANGE;
    const dist = Math.min(room, 0.7 + r * 0.9);
    return x + dir * dist;
  }
  // Ease the stroll near its target (full speed mid-walk, gentle arrival).
  function walkSpeedFactor(dist) { return Math.min(1, Math.max(0.3, (dist || 0) / 0.3)); }
  const seg01 = (tt, a, b) => clamp01((tt - a) / (b - a));
  const bump01 = (tt, a, b) => { const u = seg01(tt, a, b); return (tt < a || tt > b) ? 0 : Math.sin(Math.PI * u); };
  // Coucou's 4.6 s greeting choreography as a pure pose function of the
  // elapsed seconds. Wave/particles are events (fired by the frame loop);
  // this returns the continuous pose: grow/fall, landing squash + stretch,
  // side slide, tuck, scripted lids/blinks and scripted gaze.
  function greetingPose(tt) {
    const grow = tt < 0.2 ? 0 : easeOutBack(seg01(tt, 0.2, 0.6));
    const scale = 0.15 + 0.85 * grow;
    let yOff = 0.12 * (tt <= 0.2 ? 1 : 1 - easeInQuad(seg01(tt, 0.2, 0.6)));
    let sy = 1 - 0.14 * bump01(tt, 0.52, 0.68) + 0.18 * bump01(tt, 0.62, 0.84);
    yOff -= 0.035 * bump01(tt, 1.18, 1.46);                    // plunge
    let xOff = 0;                                              // side slide out + home
    if (tt > 0.85 && tt <= 2.85) xOff = -0.10 * easeInOutQuad(seg01(tt, 0.85, 2.4));
    else if (tt > 2.85) xOff = -0.10 * (1 - easeInOutQuad(seg01(tt, 2.85, 3.45)));
    yOff -= 0.02 * bump01(tt, 2.4, 2.7);                       // tuck
    sy -= 0.06 * bump01(tt, 3.7, 3.82);                        // micro-squash
    const lid = Math.max(0.9 * bump01(tt, 0.55, 0.8), 0.5 * bump01(tt, 2.4, 2.62));
    let blink = 0;                                             // scripted blinks, 0.12 s, depth 0.94
    for (const bt of [1.95, 3.05, 3.7]) { const u = (tt - bt) / 0.12; if (u > 0 && u < 1) blink = Math.max(blink, 0.94 * Math.sin(Math.PI * u)); }
    let gazeX = 0, gazeY = 0;                                  // scripted gaze: up, then down, then neutral
    if (tt >= 1.45 && tt < 2.4) gazeY = -0.5;
    else if (tt >= 2.4 && tt < 3.45) { gazeY = 0.45; gazeX = 0.15; }
    return { scale, sx: 1 - (sy - 1) * 0.6, sy, xOff: xOff + 0, yOff: yOff + 0, lid, blink, gazeX, gazeY }; // +0: normalize -0
  }
  // The small greet (expanded entry / greet()): 2 s - quick grow, a happy
  // lid hold, scripted blinks at 0.55 and 1.5 s; the wave is event-fired.
  function greetPose(tt) {
    const scale = 0.7 + 0.3 * easeOutBack(seg01(tt, 0, 0.35));
    const lid = 0.7 * bump01(tt, 0.2, 0.7);
    let blink = 0;
    for (const bt of [0.55, 1.5]) { const u = (tt - bt) / 0.12; if (u > 0 && u < 1) blink = Math.max(blink, 0.94 * Math.sin(Math.PI * u)); }
    return { scale, lid, blink };
  }

  // Gesture -> additive bone targets (radians at amt=1, right arm; the 2D
  // rig gestured with the same arm). waveOsc: extra forearm sway (rad)
  // while the wave spring is up, phase-lagged in the frame loop.
  function gestureTargets(name) {
    if (name === 'wave') return { upperArm: { x: 0.15, y: 0, z: -2.02 }, forearm: { x: 0, y: 0, z: -0.38 }, waveOsc: 0.17 };
    if (name === 'point') return { upperArm: { x: -1.32, y: 0, z: -0.22 }, forearm: { x: -0.14, y: 0, z: 0 }, waveOsc: 0 };
    return null;
  }
  // Baked speech clips fade to this weight while the envelope drives.
  const SPEECH_BAKED_WEIGHT = 0.15;
  const MUSIC_BPM = 112;

  const CSS = `
.dnc-slot { position: relative; }
.dn3d-view { position: absolute; inset: 0; overflow: hidden; border-radius: 14px; background: radial-gradient(ellipse 78% 62% at 50% 42%, rgba(245,185,66,.15), rgba(245,185,66,0) 68%); }
.dn3d-view canvas { display: block; }
.dn3d-fallback { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; }
.dn3d-fallback.on { display: flex; }
.dn3d-fallback img { height: 94%; max-width: 94%; object-fit: contain; filter: drop-shadow(0 1px 3px rgba(245,185,66,.45)); }`;

  function create(opts = {}) {
    const THREE = opts.THREE || root.THREE || null;
    const isVisible = opts.isVisible || (() => true);
    const reducedMotion = opts.reducedMotion || (() => false);
    const loadBytes = opts.loadBytes || (() => {
      const d = root.damarDesktop;
      if (!d || typeof d.getNotchModel !== 'function') return Promise.reject(new Error('notch model bridge unavailable'));
      return d.getNotchModel();
    });
    const spr = () => ({ x: 0, v: 0 });
    const S = {
      emote: 'senang', baseEmote: 'senang', costume: null,
      emph: { pitch: -0.03, roll: 0, rate: 1, bob: 1 },
      gaze: { x: 0, y: 0, tx: 0, ty: 0 }, hover: false, hoverAmt: 0,
      hop: spr(), talkEnv: spr(),
      pointAmt: spr(), waveAmt: spr(),
      gesture: null, gestureUntil: 0,
      speaking: false, speechLevel: 0, speechAt: 0,
      danceUntil: 0, emoteHoldUntil: 0, shakeUntil: 0, accentUntil: 0,
      pokes: [], started: false, raf: 0, last: 0, t: 0,
      gazeSetAt: 0, gazeChangeAt: 0,
      modelStatus: 'idle', // idle -> loading -> ready | failed
      template: null, clips: null, bbox: null, headFrame: null,
      // Procedural life layer state (S.t clock = visible seconds).
      life: {
        wanderAt: 3,
        shift: { x: 0, v: 0, target: 0, nextAt: 5 },
        swayLag: { x: 0, v: 0 },
        tilt: { x: 0, v: 0 },
        accent: { x: 0, v: 0 },
        cape: { x: 0, v: 0 }, hood: { x: 0, v: 0 },
        blink: { nextAt: 1.6, startAt: -1, second: false, count: 0 },
        lastInteractT: 0,
        stretchStart: -10, nextStretchAt: 55,
        ambientAt: 6, winkAt: -10,
        mediaPlaying: false, mediaAmt: 0, danceUntilT: -1,
        greet: { startT: -10, full: false, firedWave: false, firedBurst: false, firedBadge: false },
        walk: { x: 0, target: 0, active: false, phase: 0, yaw: 0, amt: 0, nextAt: 30, lastPreempt: '' },
        greetWaveUntil: 0, // greeting wave lives on its own channel: the island behavior engine re-asserts setGesture every 1.2 s and would stomp it
        pokeAtMs: -1e9, errAt: -10, questionAt: -10, spinAt: -10,
        dizzyStart: -10, costumeFxAt: -10, pointSinceT: -10,
        burstSeq: 0, burstKind: 'small',
        prevGazeX: 0, scanAmt: 0,
      },
    };
    const views = [];
    const touch = () => { S.life.lastInteractT = S.t; };

    function buildView(el) {
      el.innerHTML = '';
      const view = document.createElement('div'); view.className = 'dn3d-view';
      const fb = document.createElement('div'); fb.className = 'dn3d-fallback';
      const img = document.createElement('img'); img.alt = ''; img.src = FALLBACK_IMG;
      fb.appendChild(img); view.appendChild(fb); el.appendChild(view);
      return {
        el, view, fb, kind: (el.getAttribute && el.getAttribute('data-dnc')) || (views.length ? 'stage' : 'head'),
        renderer: null, scene: null, camera: null, mixer: null, actions: {},
        bones: {}, morphs: {}, group: null, w: 0, h: 0, hadSize: false,
        parts: null, zzz: [], burstSeen: 0,
      };
    }
    function showFallback(v) { v.fb.classList.add('on'); }
    function failAll(err) {
      S.modelStatus = 'failed'; S.error = String((err && err.message) || err);
      for (const v of views) showFallback(v);
    }

    // ---- model loading (once; every view clones the parsed template)
    function initModel() {
      if (S.modelStatus === 'loading' || S.modelStatus === 'ready') return;
      if (!THREE || !THREE.GLTFLoader || !THREE.SkeletonUtils) { failAll(new Error('three.js unavailable')); return; }
      S.modelStatus = 'loading';
      Promise.resolve().then(loadBytes).then(bytes => {
        if (!bytes) throw new Error('empty model bytes');
        const buf = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset || 0, (bytes.byteOffset || 0) + bytes.byteLength) : bytes;
        new THREE.GLTFLoader().parse(buf, '', gltf => {
          maskEmissiveWithDiffuse(gltf.scene);
          celShadeModel(gltf.scene);
          S.template = gltf.scene; S.clips = gltf.animations || [];
          S.template.updateMatrixWorld(true); // bind-pose world matrices before measuring
          const box = new THREE.Box3().setFromObject(S.template);
          S.bbox = { size: box.getSize(new THREE.Vector3()), center: box.getCenter(new THREE.Vector3()) };
          // Head framing from the BONES, not the bbox: the head bone sits
          // at neck height (y 0.84 of a 1.71 body) while the face mesh
          // rides far above it - a bbox fraction aims the head camera at
          // the hood tip and the face falls out of the compact pill
          // (measured in the proof harness, 2026-11-25). The face lives
          // between the head bone and the hood tip.
          let hb = null, ht = null;
          S.template.traverse(o => { if (o.isBone && o.name === 'head') hb = o; if (o.isBone && o.name === 'hood_tip') ht = o; });
          if (hb && ht) {
            const hp = hb.getWorldPosition(new THREE.Vector3());
            const tp = ht.getWorldPosition(new THREE.Vector3());
            const span = tp.y - hp.y;
            if (span > 0.05) S.headFrame = { ty: hp.y + span * 0.40, fitH: span * 1.18, fitW: S.bbox.size.x * 0.66 };
          }
          S.modelStatus = 'ready';
          for (const v of views) buildStage(v);
        }, err => failAll(err));
      }).catch(err => failAll(err));
    }
    function findClip(name) { return (S.clips || []).find(c => c.name === name) || null; }
    // Gold ember particles (our fire equivalent of Coucou's warp streaks /
    // spark bursts): one additive Points cloud per view, ring-buffered.
    function makeParticles(v) {
      const N = 110;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(N * 3); const col = new Float32Array(N * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const sizeY = S.bbox ? S.bbox.size.y : 1;
      const mat = new THREE.PointsMaterial({ size: 0.030 * sizeY, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      v.scene.add(points);
      v.parts = { N, pos, col, vel: new Float32Array(N * 3), life: new Float32Array(N), max: new Float32Array(N), base: new Float32Array(N * 3), head: 0, geo };
      for (let i = 0; i < N; i++) pos[i * 3 + 1] = -999;
    }
    function spawnP(v, x, y, z, vx, vy, vz, life, r, g, b) {
      const P = v.parts; if (!P) return;
      const i = P.head; P.head = (P.head + 1) % P.N;
      P.pos[i * 3] = x; P.pos[i * 3 + 1] = y; P.pos[i * 3 + 2] = z;
      P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz;
      P.life[i] = life; P.max[i] = life;
      P.base[i * 3] = r; P.base[i * 3 + 1] = g; P.base[i * 3 + 2] = b;
    }
    function burst(v, big) {
      if (!v.parts || !S.bbox) return;
      const { size, center } = S.bbox;
      const n = big ? 42 : 16, pow = big ? 0.85 : 0.5;
      for (let i = 0; i < n; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), sp = (0.25 + Math.random() * 0.75) * pow * size.y;
        spawnP(v, center.x, center.y + size.y * 0.22, center.z + size.y * 0.10,
          Math.sin(ph) * Math.cos(th) * sp, Math.abs(Math.cos(ph)) * sp * 0.9 + size.y * 0.25, Math.sin(ph) * Math.sin(th) * sp * 0.4,
          0.55 + Math.random() * 0.5, 1.0, 0.72 + Math.random() * 0.2, 0.30);
      }
    }
    function streak(v) {
      if (!v.parts || !S.bbox) return;
      const { size, center } = S.bbox;
      spawnP(v, center.x + (Math.random() * 2 - 1) * size.x * 0.55, center.y + size.y * (0.55 + Math.random() * 0.3), center.z + size.y * 0.12,
        0, -size.y * (1.4 + Math.random()), 0, 0.5, 1.0, 0.80, 0.38);
    }
    function stepParticles(v, dt) {
      const P = v.parts; if (!P) return;
      const g = (S.bbox ? S.bbox.size.y : 1) * 1.7;
      for (let i = 0; i < P.N; i++) {
        if (P.life[i] <= 0) continue;
        P.life[i] -= dt;
        if (P.life[i] <= 0) { P.pos[i * 3 + 1] = -999; P.col[i * 3] = P.col[i * 3 + 1] = P.col[i * 3 + 2] = 0; continue; }
        P.vel[i * 3 + 1] -= g * dt;
        P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
        const f = P.life[i] / P.max[i];
        P.col[i * 3] = P.base[i * 3] * f; P.col[i * 3 + 1] = P.base[i * 3 + 1] * f; P.col[i * 3 + 2] = P.base[i * 3 + 2] * f;
      }
      P.geo.attributes.position.needsUpdate = true;
      P.geo.attributes.color.needsUpdate = true;
    }
    // Sleepy "Zzz": three gold sprites rising beside the hood (Coucou's
    // sleeping particles, in our ember-gold register).
    function makeZzz(v) {
      try {
        const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
        const cx = cv.getContext('2d');
        cx.font = '900 96px Georgia, serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
        cx.fillStyle = '#f5c95e'; cx.shadowColor = 'rgba(245,185,66,.8)'; cx.shadowBlur = 10;
        cx.fillText('Z', 64, 70);
        const tex = new THREE.CanvasTexture(cv);
        for (let i = 0; i < 3; i++) {
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
          sp.visible = false;
          v.scene.add(sp); v.zzz.push(sp);
        }
      } catch { /* Zzz are garnish; never break the stage */ }
    }
    function buildStage(v) {
      if (!S.template || v.scene) return;
      try {
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
        renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 1.5));
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.06;
        v.renderer = renderer;
        v.view.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        const hemi = new THREE.HemisphereLight(0xfff3d6, 0x1a1626, 0.85);
        const key = new THREE.DirectionalLight(0xffe9b8, 1.15); key.position.set(1.6, 2.6, 2.4);
        const rim = new THREE.DirectionalLight(0xf5b942, 0.55); rim.position.set(-2.2, 1.4, -1.8);
        scene.add(hemi, key, rim);
        const group = new THREE.Group();
        const model = THREE.SkeletonUtils.clone(S.template);
        group.add(model); scene.add(group);
        v.scene = scene; v.group = group;
        v.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 60);
        // index bones + morph meshes by name
        model.traverse(o => {
          if (o.isBone) v.bones[o.name] = o;
          if (o.isMesh && o.morphTargetDictionary) v.morphs[o.name] = o;
        });
        // Bind-pose snapshot: the frame loop resets every bone to bind
        // before each mixer update. three r147 does not restore bones
        // whose actions sit at weight 0, so the life layer's additive
        // quaternion multiplies would otherwise INTEGRATE frame over
        // frame - measured in the proof harness: after ~20 s of idle the
        // island head sank out of the compact pill (spine quaternion
        // drifted to (0.57, 0.06, 0.56, 0.60) from identity).
        v.bindQ = {}; v.bindP = {};
        for (const bn of Object.keys(v.bones)) {
          v.bindQ[bn] = v.bones[bn].quaternion.clone();
          v.bindP[bn] = v.bones[bn].position.clone();
        }
        v.mixer = new THREE.AnimationMixer(model);
        for (const key2 of Object.keys(CLIP)) {
          const clip = findClip(CLIP[key2]);
          if (!clip) continue;
          const a = v.mixer.clipAction(clip);
          a.setLoop(THREE.LoopRepeat, Infinity); a.weight = 1; a.play();
          v.actions[key2] = a;
        }
        // HIDUP roles: the baked eyelid clips stay at 0 (procedural blink
        // owns the lids); the rig clip starts demoted - the accent spring
        // in the frame loop owns its weight from here.
        if (v.actions.lidL) v.actions.lidL.setEffectiveWeight(0);
        if (v.actions.lidR) v.actions.lidR.setEffectiveWeight(0);
        if (v.actions.rig) v.actions.rig.setEffectiveWeight(0);
        makeParticles(v);
        makeZzz(v);
        frameCamera(v, true);
      } catch (err) { showFallback(v); S.error = String((err && err.message) || err); }
    }
    // Camera framing from the model bbox: the head slot is the in-bar
    // mini (the bar is 288x32 - a face inside it is the physical truth);
    // the stage slot fits the FULL BODY, flame tip to boots (Owner spec),
    // inside the expanded island.
    function frameCamera(v, force) {
      if (!v.camera || !S.bbox) return;
      const w = v.el.clientWidth || 0, h = v.el.clientHeight || 0;
      if (!w || !h) { v.hadSize = false; v.w = 0; v.h = 0; return; } // zeroed so the frame loop really skips hidden slots
      v.hadSize = true;
      if (!force && w === v.w && h === v.h) return;
      v.w = w; v.h = h;
      v.renderer.setSize(w, h, false);
      const { size, center } = S.bbox;
      const fov = v.camera.fov * Math.PI / 180;
      let fitH, ty, fitW = 0;
      if (v.kind === 'head') {
        if (S.headFrame) { fitH = S.headFrame.fitH; ty = S.headFrame.ty; fitW = S.headFrame.fitW || 0; }
        else { fitH = size.y * 0.46; ty = center.y + size.y * 0.30; }
      }
      else { fitH = size.y * 1.05; ty = center.y - size.y * 0.015; fitW = size.x * 1.15; }
      const distH = (fitH / 2) / Math.tan(fov / 2);
      const distW = fitW ? (fitW / 2) / (Math.tan(fov / 2) * (w / h)) : 0;
      const dist = Math.max(distH, distW);
      v.camera.aspect = w / h;
      v.camera.position.set(center.x, ty, center.z + dist * 1.04);
      v.camera.lookAt(center.x, ty, center.z);
      v.camera.updateProjectionMatrix();
      // Visible world size at the model plane (stage stroll scaling).
      v.visW = 2 * dist * 1.04 * Math.tan(fov / 2) * (w / h);
      v.visH = 2 * dist * 1.04 * Math.tan(fov / 2);
    }
    // Additive bone rotation on top of the (bind/accent) pose (post-mixer).
    const _e = () => new THREE.Euler();
    function addRot(bone, x, y, z) {
      if (!bone || (!x && !y && !z)) return;
      const q = new THREE.Quaternion().setFromEuler(_e().set(x, y, z));
      bone.quaternion.multiply(q);
    }
    function setMorph(mesh, name, value) {
      if (!mesh) return;
      const i = mesh.morphTargetDictionary[name];
      if (i !== undefined) mesh.morphTargetInfluences[i] = value;
    }
    function startGreet(full) {
      const L = S.life;
      L.greet.startT = S.t; L.greet.full = !!full;
      L.greet.firedWave = false; L.greet.firedBurst = false; L.greet.firedBadge = false;
      touch();
    }

    function frame(now) {
      S.raf = requestAnimationFrame(frame);
      if (!isVisible() || document.hidden) { S.last = now; return; }
      const dt = Math.min(0.05, (now - S.last) / 1000 || 0.016); S.last = now;
      S.t += dt;
      const t = S.t, rm = reducedMotion(), amp = rm ? 0.3 : 1;
      const L = S.life;
      // emote emphasis, exponentially mixed (Coucou state-transition mix).
      const emphT = emoteEmphasis(S.emote);
      const mixK = 1 - Math.pow(0.002, dt);
      for (const k of ['pitch', 'roll', 'rate', 'bob']) S.emph[k] += (emphT[k] - S.emph[k]) * mixK;
      const emph = S.emph;
      if (S.gesture && now > S.gestureUntil) S.gesture = null;
      if (S.emoteHoldUntil && now > S.emoteHoldUntil && S.emote !== S.baseEmote) S.emote = S.baseEmote;
      const gestureNow = S.gesture || (now < L.greetWaveUntil ? 'wave' : null);
      // springs (240 Hz sub-stepped, Coucou model)
      stepSpringSub(S.hop, 0, dt, SPRING_MAIN.k, SPRING_MAIN.d);
      stepSpringSub(S.pointAmt, gestureNow === 'point' ? 1 : 0, dt, 150, 12.5);
      stepSpringSub(S.waveAmt, gestureNow === 'wave' ? 1 : 0, dt, 170, 14);
      const talkTarget = S.speaking ? (now - S.speechAt < 260 ? S.speechLevel : 0.32) : 0;
      stepSpringSub(S.talkEnv, talkTarget, dt, SPRING_MOUTH.k, SPRING_MOUTH.d);
      const talk = S.talkEnv.x;
      S.hoverAmt += ((S.hover ? 1 : 0) - S.hoverAmt) * Math.min(1, dt * 8);
      const dancing = now < S.danceUntil && !rm;
      const sizeY = S.bbox ? S.bbox.size.y : 1;
      const idleFor = t - L.lastInteractT;

      // ---- life layer: shared signals (computed once, applied per view)
      // breath (Coucou, ALWAYS for Damar): group sy breathes at 1.8 rad/s;
      // the same phase drives a bone-level chest breath Coucou cannot do.
      const brS = Math.sin(t * 1.8);
      const breathSy = 1 + brS * 0.035 * amp;
      const breathSx = 1 - brS * 0.035 * 0.57 * amp;
      // body sway: two detuned sines - reads as alive, never loops visibly.
      const swayZ = (Math.sin(t * 0.43) * 0.020 + Math.sin(t * 0.71 + 1.7) * 0.012) * amp;
      const swayX = Math.sin(t * 0.31 + 0.6) * 0.012 * amp;
      stepSpringSub(L.swayLag, swayZ, dt, 18, 6);
      // weight shift: a spring target that wanders every 5-9 s.
      if (t >= L.shift.nextAt) { L.shift.target = (Math.random() * 2 - 1) * 0.9; L.shift.nextAt = t + 5 + Math.random() * 4; }
      stepSpringSub(L.shift, L.shift.target, dt, 7, 4.5);
      // poke head-tilt spring (impulse in poke()).
      stepSpringSub(L.tilt, 0, dt, SPRING_MAIN.k, SPRING_MAIN.d);
      // baked-clip accent: dance windows only; ~0 at idle.
      stepSpringSub(L.accent, (dancing || now < S.accentUntil) ? 1 : 0, dt, 55, 11);
      // gaze: Coucou exponential smoothing; island target is law while
      // fresh, stale -> the eyes wander on their own.
      const gazeStale = (now - S.gazeSetAt > 2600) || (now - S.gazeChangeAt > 5000);
      const greetActive = t - L.greet.startT < (L.greet.full ? 4.6 : 2.0);
      if (gazeStale && !S.hover && talk <= 0.01 && !gestureNow && !greetActive && t >= L.wanderAt) {
        const w = gazeWander(Math.random(), Math.random());
        S.gaze.tx = w.x; S.gaze.ty = w.y;
        L.wanderAt = t + 1.3 + Math.random() * 1.7;
      }
      const gk = 1 - Math.pow(0.0025, dt);
      S.gaze.x += (S.gaze.tx - S.gaze.x) * gk;
      S.gaze.y += (S.gaze.ty - S.gaze.y) * gk;
      const yawVel = dt > 0 ? (S.gaze.x - L.prevGazeX) / dt : 0;
      L.prevGazeX = S.gaze.x;
      // soft-part physics (Coucou: stiffness 60, damping 9; targets from
      // yaw velocity, tilt and body velocity - adapted gains for 3D units).
      const capeTarget = Math.max(-0.45, Math.min(0.45, -0.35 * yawVel * 0.35 + S.hop.v * 0.06));
      stepSpringSub(L.cape, capeTarget, dt, 60, 9);
      const hoodTarget = Math.max(-0.4, Math.min(0.4, -2 * L.tilt.v * 0.05 - 0.35 * yawVel * 0.2));
      stepSpringSub(L.hood, hoodTarget, dt, 60, 9);
      // blink scheduler (procedural; the baked lid clips are off).
      const sleepy = idleFor > ((S.emote === 'pulih' || S.emote === 'orbStandby') ? 30 : 75);
      const B = L.blink;
      if (B.startAt < 0 && t >= B.nextAt) { B.startAt = t; B.count += 1; }
      let blinkW = 0;
      if (B.startAt >= 0) {
        const ms = (t - B.startAt) * 1000;
        blinkW = blinkWeight(ms);
        if (ms >= 200) {
          B.startAt = -1;
          if (!B.second && Math.random() < 0.22) { B.second = true; B.nextAt = t + 0.23; }
          else { B.second = false; B.nextAt = t + blinkDelay(Math.random()); }
        }
      }
      // ambient micro-activities (Coucou's ambient picker, our register):
      // every 2-5.5 s of quiet, one of bounce / mini shake / wink+tilt /
      // ember puff - the character has a life of its own.
      if (!rm && idleFor > 4 && talk <= 0.01 && !gestureNow && !greetActive && t >= L.ambientAt) {
        L.ambientAt = t + 2 + Math.random() * 3.5;
        const pick = Math.random();
        if (pick < 0.30) S.hop.v += 1.3;
        else if (pick < 0.55) { L.errAt = t; }
        else if (pick < 0.85) { L.winkAt = t; L.questionAt = t; if (B.startAt < 0) B.nextAt = Math.min(B.nextAt, t + 0.3); }
        else { L.burstSeq += 1; L.burstKind = 'small'; }
      }
      // sleepy nod: a slow droop that keeps catching itself.
      const droop = sleepy && !rm ? Math.pow(Math.max(0, Math.sin(t * 0.55 + 0.8)), 2) * 0.13 : 0;
      // idle stretch: arms up + arch, every ~50-85 s of quiet.
      let stretchEnv = 0;
      if (!rm && idleFor > 20 && talk <= 0.01 && !gestureNow && t >= L.nextStretchAt) { L.stretchStart = t; L.nextStretchAt = t + 50 + Math.random() * 35; }
      if (L.stretchStart > 0) {
        const u = (t - L.stretchStart) / 1.9;
        if (u >= 1) L.stretchStart = -10; else stretchEnv = Math.pow(Math.sin(Math.PI * u), 1.35);
      }
      // ---- stage stroll: an ambient act inside the open island.
      // Starts only in long quiet while the expanded stage is on screen;
      // any interaction or higher-priority state (gesture, greeting,
      // speech, music, spin, dizzy) preempts it - the character stops
      // where it stands, the legs settle, and it may stroll again later.
      const stageView = views.find(v => v.kind === 'stage');
      const stageLive = !!(stageView && stageView.scene && stageView.hadSize);
      const WK = L.walk;
      const walkBusy = !!gestureNow || greetActive || talk > 0.01 || L.mediaAmt > 0.02 || L.spinAt >= 0 || L.dizzyStart >= 0;
      if (WK.active && (walkBusy || !stageLive || idleFor < 0.5)) { WK.active = false; WK.nextAt = t + 20 + Math.random() * 20; WK.lastPreempt = walkBusy ? 'busy' : (!stageLive ? 'gone' : 'interacted'); }
      if (!WK.active && !rm && stageLive && !walkBusy && idleFor > 10 && t >= WK.nextAt) {
        WK.target = pickWalkTarget(WK.x, Math.random());
        WK.active = true;
      }
      if (WK.active) {
        const distLeft = WK.target - WK.x;
        const dir = Math.sign(distLeft);
        if (Math.abs(distLeft) < 0.02) { WK.active = false; WK.nextAt = t + 26 + Math.random() * 30; }
        else {
          const stepLen = Math.min(Math.abs(distLeft), WALK_SPEED * walkSpeedFactor(Math.abs(distLeft)) * dt);
          WK.x += dir * stepLen;
          WK.phase += (stepLen / 0.30) * Math.PI; // ~0.30 world per half-cycle
          WK.yaw += ((dir * 0.82) - WK.yaw) * Math.min(1, dt * 6);
        }
      } else {
        WK.yaw += (0 - WK.yaw) * Math.min(1, dt * 6);
      }
      const amtTarget = WK.active ? 1 : 0;
      WK.amt += Math.max(-dt / 0.3, Math.min(dt / 0.25, amtTarget - WK.amt));
      WK.amt = Math.max(0, Math.min(1, WK.amt));
      const wp = WK.amt > 0.003 ? walkPose(WK.phase) : null;
      const walkBob = wp ? wp.bob * sizeY * WK.amt : 0;
      // music dance (Coucou): 112 BPM, fade-in 0.3 s / fade-out 0.5 s.
      const musicOn = (L.mediaPlaying || t < L.danceUntilT) && !rm;
      L.mediaAmt = Math.max(0, Math.min(1, L.mediaAmt + (musicOn ? dt / 0.3 : -dt / 0.5)));
      const beat = t * (MUSIC_BPM / 60);
      const hopN = Math.abs(Math.sin(Math.PI * beat));
      const musicY = hopN * 0.045 * sizeY * L.mediaAmt;
      const musicRoll = Math.sin(Math.PI * beat) * 0.08 * L.mediaAmt;
      const musicLand = Math.pow(1 - hopN, 6) * L.mediaAmt;
      // searching scan (Coucou): yaw sweeps while the engine thinks.
      L.scanAmt = Math.max(0, Math.min(1, L.scanAmt + ((S.emote === 'berpikir' && !greetActive) ? dt / 0.4 : -dt / 0.4)));
      const scanYaw = Math.sin(t * 2.6) * 0.6 * L.scanAmt;
      // greeting pose + event beats.
      let gp = null;
      if (greetActive) {
        const el = t - L.greet.startT;
        gp = Object.assign({ sx: 1, sy: 1, xOff: 0, yOff: 0, lid: 0, blink: 0 }, L.greet.full ? greetingPose(el) : greetPose(el));
        const waveAt = L.greet.full ? 1.45 : 0.45, waveLen = L.greet.full ? 1000 : 1100;
        if (!L.greet.firedWave && el >= waveAt) { L.greet.firedWave = true; L.greetWaveUntil = now + waveLen; }
        if (L.greet.full && !L.greet.firedBurst && el >= 0.45) { L.greet.firedBurst = true; L.burstSeq += 1; L.burstKind = 'big'; }
        if (L.greet.full && !L.greet.firedBadge && el >= 2.72) { L.greet.firedBadge = true; L.burstSeq += 1; L.burstKind = 'small'; }
        if (L.greet.full) { S.gaze.tx = gp.gazeX || 0; S.gaze.ty = gp.gazeY || 0; } // scripted gaze owns the target, incl. the return to neutral
      }
      // finished spin (Coucou: full roll 950 ms) - on the body Y axis in 3D.
      let spinRot = 0;
      if (L.spinAt >= 0) {
        const u = (t - L.spinAt) / 0.95;
        if (u >= 1) L.spinAt = -10; else spinRot = Math.PI * 2 * easeOutCubic(u);
      }
      // dizzy (Coucou, 3D-adapted): gaze yaw sin(t*9)*0.25 + a light body
      // sway-turn for ~1.3 s (their spiral eyes have no 3D equivalent).
      let dizzyYaw = 0, dizzyRot = 0;
      if (L.dizzyStart >= 0) {
        const u = (t - L.dizzyStart) / 1.3;
        if (u >= 1) L.dizzyStart = -10;
        else { dizzyYaw = Math.sin(t * 9) * 0.25; dizzyRot = Math.sin(u * Math.PI) * 0.5; }
      }
      // poke squash timeline + error shake + question tilt.
      const pokeFx = pokeSquash((now - L.pokeAtMs));
      const shakeYaw = headShake((t - L.errAt) * 1000);
      const qTilt = (t - L.questionAt >= 0 && t - L.questionAt < 0.9) ? 0.17 * Math.sin(Math.PI * (t - L.questionAt) / 0.9) : 0;
      const winkW = L.winkAt > 0 ? blinkWeight((t - L.winkAt) * 1000) : 0;
      if (L.winkAt > 0 && (t - L.winkAt) * 1000 >= 200) L.winkAt = -10;
      // approval waiting bounce (Coucou): -|sin(t*5.2)|*0.07 while a
      // point stands (approval / alert), on top of everything else.
      const approvalDip = gestureNow === 'point' ? -Math.abs(Math.sin(t * 5.2)) * 0.07 * sizeY : 0;
      // costume swap envelope.
      const costumeS = costumeScale(t - L.costumeFxAt);

      for (const v of views) {
        if (!v.scene) continue;
        frameCamera(v, false);
        if (!v.w || !v.h) continue; // hidden slot - do not burn render time
        // clip roles: rig = accent spring; speech clips whisper under the
        // live envelope and are 0 at idle; lids stay 0 (procedural blink).
        if (v.actions.rig) v.actions.rig.setEffectiveWeight(Math.max(0, Math.min(1, L.accent.x)));
        const speechW = talk > 0.01 ? SPEECH_BAKED_WEIGHT : 0;
        for (const k of SPEECH_CLIP_KEYS) if (v.actions[k]) v.actions[k].setEffectiveWeight(speechW);
        // Bind reset (see buildStage): the mixer writes clip poses on top
        // of bind; the life layer then adds exactly one frame of rotation.
        if (v.bindQ) for (const bn of Object.keys(v.bindQ)) { const b = v.bones[bn]; if (b) { b.quaternion.copy(v.bindQ[bn]); b.position.copy(v.bindP[bn]); } }
        v.mixer.update(dt * emph.rate);
        // ---- speech morphs (the speech subsystem owns these channels)
        const sm = v.morphs['Speech_Mouth'], md = v.morphs['Mouth_Details'], hd = v.morphs['Body_Head'];
        if (talk > 0.01) {
          const m = speechMorphs(talk, t);
          setMorph(sm, 'Mouth_Open', m.Mouth_Open); setMorph(sm, 'Mouth_Wide', m.Mouth_Wide); setMorph(sm, 'Mouth_Round', m.Mouth_Round);
          setMorph(md, 'Mouth_Open', m.Mouth_Open); setMorph(md, 'Mouth_Wide', m.Mouth_Wide); setMorph(md, 'Mouth_Round', m.Mouth_Round);
          setMorph(hd, 'Jaw_Open', m.Jaw_Open);
        } else {
          setMorph(sm, 'Mouth_Open', 0); setMorph(sm, 'Mouth_Wide', 0); setMorph(sm, 'Mouth_Round', 0);
          setMorph(md, 'Mouth_Open', 0); setMorph(md, 'Mouth_Wide', 0); setMorph(md, 'Mouth_Round', 0);
          setMorph(hd, 'Jaw_Open', 0);
        }
        // ---- blink morphs (life layer; never touches the mouth).
        // Greeting lids (happy/content holds + scripted blinks) and the
        // ambient wink (left eye) compose over the scheduler blink.
        const greetLid = gp ? Math.max(gp.lid || 0, gp.blink || 0) : 0;
        const lidL = Math.max(blinkW, greetLid, winkW);
        const lidR = Math.max(blinkW, greetLid);
        if (lidL > 0.001 || lidR > 0.001 || B.startAt < 0) {
          setMorph(v.morphs['Eyelid.L'], 'Blink', lidL);
          setMorph(v.morphs['Eyelid.R'], 'Blink', lidR);
        }
        // ---- gesture arms (existing additive path) + idle stretch
        const gt = gestureTargets(gestureNow);
        const gAmt = gestureNow === 'wave' ? S.waveAmt.x : gestureNow === 'point' ? S.pointAmt.x : 0;
        if (gt && gAmt > 0.003) {
          const osc = gt.waveOsc ? Math.sin(t * Math.PI * 2 * 5 - 0.75) * gt.waveOsc * gAmt : 0; // Coucou wave: 5 Hz
          addRot(v.bones['upper_arm.R'], gt.upperArm.x * gAmt * amp, gt.upperArm.y * gAmt, gt.upperArm.z * gAmt * amp);
          addRot(v.bones['forearm.R'], gt.forearm.x * gAmt * amp, gt.forearm.y * gAmt, (gt.forearm.z + osc) * amp);
        }
        if (stretchEnv > 0.003) {
          addRot(v.bones['upper_arm.R'], 0.10 * stretchEnv, 0, -1.80 * stretchEnv);
          addRot(v.bones['upper_arm.L'], 0.10 * stretchEnv, 0, 1.80 * stretchEnv);
          addRot(v.bones['forearm.R'], -0.25 * stretchEnv, 0, 0);
          addRot(v.bones['forearm.L'], -0.25 * stretchEnv, 0, 0);
        }
        // ---- stage stroll limbs (the stage view only: the stroll lives
        // inside the open island; the in-bar mini never inherits its gait).
        if (wp && v.kind === 'stage') {
          const wa = WK.amt * amp;
          addRot(v.bones['thigh.L'], wp.thighL * wa, 0, 0);
          addRot(v.bones['thigh.R'], wp.thighR * wa, 0, 0);
          addRot(v.bones['shin.L'], wp.shinL * wa, 0, 0);
          addRot(v.bones['shin.R'], wp.shinR * wa, 0, 0);
          addRot(v.bones['foot.L'], wp.footL * wa, 0, 0);
          addRot(v.bones['foot.R'], wp.footR * wa, 0, 0);
          addRot(v.bones['pelvis'], wp.lean * wa, wp.pelvisYaw * wa, wp.pelvisRoll * wa);
          addRot(v.bones['upper_arm.L'], wp.armL * wa, 0, 0);
          if (!gt || gAmt <= 0.003) addRot(v.bones['upper_arm.R'], wp.armR * wa, 0, 0);
        }
        // ---- breath + sway into the spine chain (life layer core)
        addRot(v.bones['spine'], (Math.sin(t * 1.8) * 0.012 + swayX) * amp, 0, (swayZ + L.shift.x * 0.028) * amp);
        addRot(v.bones['chest'], Math.sin(t * 1.8) * 0.022 * amp, 0, -swayZ * 0.5 * amp);
        addRot(v.bones['upper_arm.L'], 0, 0, Math.sin(t * 1.8) * 0.010 * amp);
        addRot(v.bones['upper_arm.R'], 0, 0, -Math.sin(t * 1.8) * 0.010 * amp);
        // secondary motion: cape + hood tip on their soft springs.
        addRot(v.bones['cape.L'], (L.cape.x + Math.sin(t * 1.8) * 0.008) * amp, 0, 0);
        addRot(v.bones['cape.R'], (L.cape.x * 0.85 - Math.sin(t * 1.8) * 0.006) * amp, 0, 0);
        addRot(v.bones['hood_tip'], (L.hood.x * 0.7 + Math.sin(t * 1.8) * 0.014 + droop * 0.4) * amp, 0, 0);
        // ---- gaze (Coucou gains) + emphasis + life terms on neck/head
        const yaw = (S.gaze.x * 0.62 + scanYaw + dizzyYaw) * amp + shakeYaw;
        const pitch = S.gaze.y * 0.5 + emph.pitch + Math.sin(t * 1.8) * 0.008 * amp + droop - stretchEnv * 0.10 - S.hoverAmt * 0.03 + (sleepy ? 0.14 * 0.4 : 0);
        const roll = emph.roll - L.shift.x * 0.022 + L.tilt.x + musicRoll + qTilt + (gestureNow === 'wave' ? (Math.sin(t * Math.PI * 2 * 1.2) * 0.07 - 0.06) * gAmt : 0) + (S.emote === 'dizzy' ? Math.sin(t * 2.2) * 0.05 * amp : 0);
        addRot(v.bones['neck'], pitch * 0.45, yaw * 0.45, roll * 0.4);
        addRot(v.bones['head'], pitch * 0.55, yaw * 0.55, roll * 0.6);
        // ---- stage root: compose every scale/offset channel
        const waveBob = gestureNow === 'wave' ? Math.sin(t * Math.PI * 2 * 5) * 0.02 * sizeY * gAmt : 0; // Coucou wave bob 5 Hz, 2%
        const danceBounce = dancing ? Math.abs(Math.sin(t * 7.5)) * 0.022 * sizeY : 0;
        // The stroll's rendered corridor scales to the stage's visible
        // width: the simulation walks +-WALK_RANGE, the stage shows only
        // the part of that corridor that fits inside the island.
        const walkScale = v.kind === 'stage' && v.visW && S.bbox ? Math.max(0, Math.min(1, (v.visW / 2 - S.bbox.size.x * 0.55) / WALK_RANGE)) : 0;
        v.group.position.y = S.hop.x * sizeY * 0.12 + danceBounce + musicY + waveBob + approvalDip + S.hoverAmt * 0.004 * sizeY + (gp ? gp.yOff * sizeY : 0) + (v.kind === 'stage' ? walkBob : 0);
        v.group.position.x = L.shift.x * 0.010 * sizeY * amp + (gp ? gp.xOff * sizeY : 0) + (v.kind === 'stage' ? WK.x * walkScale : 0);
        const gScale = gp ? gp.scale : 1;
        const sy = pokeFx.sy * (gp ? gp.sy : 1) * breathSy * costumeS * (1 - 0.06 * musicLand) * (1 + S.hoverAmt * 0.03);
        const sx = pokeFx.sx * (gp ? gp.sx : 1) * breathSx * costumeS * (1 + 0.045 * musicLand);
        v.group.scale.set(sx * gScale, sy * gScale, sx * gScale);
        v.group.rotation.y = spinRot + dizzyRot + (v.kind === 'stage' ? WK.yaw * WK.amt : 0);
        v.group.rotation.z = now < S.shakeUntil && !rm ? Math.sin(now * 0.11) * 0.03 * Math.max(0, (S.shakeUntil - now) / 900) : 0;
        // ---- particles: bursts on request, streaks during the greeting
        if (v.burstSeen !== L.burstSeq) { v.burstSeen = L.burstSeq; burst(v, L.burstKind === 'big'); }
        if (gp && L.greet.full && (t - L.greet.startT) < 0.55 && !rm) { streak(v); streak(v); }
        stepParticles(v, dt);
        // ---- Zzz while sleepy
        const showZ = sleepy && !rm && v.zzz.length && S.bbox;
        for (let i = 0; i < v.zzz.length; i++) {
          const sp = v.zzz[i];
          if (!showZ) { sp.visible = false; continue; }
          const ph = ((t / 3.9) + i / 3) % 1;
          const { size, center } = S.bbox;
          sp.visible = true;
          sp.position.set(center.x + size.x * 0.16 + Math.sin(ph * 5 + i) * 0.03 * size.y + ph * 0.08 * size.y, center.y + size.y * (0.52 + ph * 0.38), center.z + size.y * 0.15);
          const sc = (0.05 + ph * 0.075) * size.y;
          sp.scale.set(sc, sc, 1);
          sp.material.opacity = Math.sin(Math.PI * ph) * 0.85;
        }
        v.renderer.render(v.scene, v.camera);
      }
    }

    const api = {
      attach(el) {
        if (!el) return null;
        const v = buildView(el);
        views.push(v);
        if (S.modelStatus === 'ready') buildStage(v);
        else if (S.modelStatus === 'failed') showFallback(v);
        else initModel();
        return v;
      },
      start() {
        if (S.started) return; S.started = true;
        if (!document.getElementById('dn3d-style')) {
          const st = document.createElement('style'); st.id = 'dn3d-style'; st.textContent = CSS; document.head.appendChild(st);
        }
        initModel();
        S.last = performance.now();
        S.raf = requestAnimationFrame(frame);
      },
      stop() { S.started = false; cancelAnimationFrame(S.raf); },
      playIntro() { startGreet(true); },
      playGreet() { startGreet(false); },
      setMediaPlaying(on) { S.life.mediaPlaying = !!on; if (on) touch(); },
      reactError() { S.life.errAt = S.t; touch(); },
      reactQuestion() {
        S.life.questionAt = S.t;
        if (S.life.blink.startAt < 0) S.life.blink.nextAt = Math.min(S.life.blink.nextAt, S.t);
        touch();
      },
      setEmote(e, holdMs = 0) {
        if (!EMOTES.includes(e)) return;
        S.baseEmote = e; S.emote = e;
        S.emoteHoldUntil = holdMs ? performance.now() + holdMs : 0;
      },
      // Contract parity with the 2D rig (validation + record). The base
      // model has one outfit; the choice applies when costume models land.
      // A change still performs the swap envelope - never an instant swap.
      setCostume(name) {
        if (name !== null && !COSTUMES.includes(name)) return false;
        if (name !== S.costume && name !== null) S.life.costumeFxAt = S.t;
        S.costume = name;
        return true;
      },
      getCostume() { return S.costume; },
      setGesture(g, holdMs = 2600) {
        if (g !== null && g !== 'wave' && g !== 'point') return false;
        if (g === 'point' && S.gesture !== 'point') { S.life.pointSinceT = S.t; if (!reducedMotion()) S.hop.v += 1.2; } // approval entry bounce
        S.gesture = g;
        S.gestureUntil = g ? performance.now() + holdMs : 0;
        if (g) touch();
        return true;
      },
      getGesture() { return S.gesture; },
      setSpeaking(on) { S.speaking = !!on; if (!on) S.speechLevel = 0; else touch(); },
      setSpeechLevel(v) { S.speechLevel = clamp01(v); S.speechAt = performance.now(); },
      celebrate() {
        // Coucou "finished": a full spin in 950 ms + a spark burst.
        S.life.spinAt = S.t;
        S.life.burstSeq += 1; S.life.burstKind = 'big';
        touch();
        if (reducedMotion()) { api.setEmote('senang', 1200); return; }
        S.hop.v += 1.2;
        api.setEmote('senang', 1400);
      },
      dance(ms = 1600) {
        if (reducedMotion()) return;
        S.danceUntil = performance.now() + ms;
        S.life.danceUntilT = S.t + ms / 1000;
        S.accentUntil = performance.now() + ms;
        api.setEmote('senang', ms);
        touch();
      },
      greet() {
        startGreet(false);
        api.setEmote('senang', 1600);
      },
      poke() {
        const now = performance.now();
        S.pokes = S.pokes.filter(x => now - x < 1700); S.pokes.push(now);
        const verdict = pokeVerdict(S.pokes, now);
        touch();
        if (reducedMotion()) return verdict;
        // Coucou slap: squash timeline + physics kick + annoyed face 0.8 s.
        S.life.pokeAtMs = now;
        S.hop.v += 2.0;
        S.life.tilt.v += (Math.random() < 0.5 ? -0.7 : 0.7);
        if (S.life.blink.startAt < 0) S.life.blink.nextAt = Math.min(S.life.blink.nextAt, S.t);
        if (verdict === 'dizzy') {
          S.life.dizzyStart = S.t;
          api.setEmote('dizzy', 1500);
          S.shakeUntil = now + 900;
          S.pokes = [];
        } else {
          api.setEmote('annoyed', 800);
        }
        return verdict;
      },
      setGaze(nx, ny) {
        const g = clampGaze(nx, ny);
        const nowMs = performance.now();
        if (Math.abs(g.x - S.gaze.tx) > 0.05 || Math.abs(g.y - S.gaze.ty) > 0.05) { S.gazeChangeAt = nowMs; touch(); }
        S.gaze.tx = g.x; S.gaze.ty = g.y; S.gazeSetAt = nowMs;
      },
      setHover(on) {
        const was = S.hover;
        S.hover = !!on;
        if (S.hover && !was && !reducedMotion()) S.hop.v += 0.9; // small enthusiastic bounce
        touch();
      },
      relayout() { for (const v of views) { v.w = 0; frameCamera(v, true); } },
      // Ask the character to take a stroll inside the open island (the
      // ambient system also starts these on its own in long quiet). The
      // frame loop's preempt rules still apply - a stroll asked for in a
      // busy moment settles instead of forcing its way through.
      stroll() {
        const pv = views.find(v => v.kind === 'stage');
        if (!pv || !pv.hadSize) return false;
        const WK = S.life.walk;
        if (!WK.active) { WK.target = pickWalkTarget(WK.x, Math.random()); WK.active = true; }
        return true;
      },
      _state: S,
    };
    return api;
  }

  root.DamarNotch3D = {
    create, EMOTES, COSTUMES, CLIP, SPEECH_BAKED_WEIGHT,
    _pure: { clampGaze, clamp01, stepSpring, swiftSpring, pokeVerdict, speechMorphs, emoteEmphasis, gestureTargets, maskEmissiveWithDiffuse, celShadeModel, celBandLum, celScale, eyeShadeLum, blinkWeight, blinkDelay, gazeWander, easeOutBack, greetingPose, greetPose, headShake, pokeSquash, costumeScale, walkPose, pickWalkTarget, walkSpeedFactor, WALK_RANGE, WALK_SPEED },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DamarNotch3D;
})(typeof window !== 'undefined' ? window : globalThis);
