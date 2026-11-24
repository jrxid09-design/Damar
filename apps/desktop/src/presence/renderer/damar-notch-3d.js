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
  // Same contract as damar-notch-character.js (the island drives either
  // through one API): attach/start/stop, setEmote, setCostume, setGesture,
  // setSpeaking/setSpeechLevel, celebrate, dance, greet, poke, setGaze,
  // setHover, relayout. Differences, all deliberate:
  // - Life comes from the baked clips, not from per-frame drivers; this
  //   module adds only thin, honest overlays on top: gaze (neck/head),
  //   emote EMPHASIS (small head pitch/roll + clip rate + bob - the
  //   behavior engine's emotes have no separate 3D art and none is faked),
  //   wave/point arm gestures (additive bone rotations), poke squash,
  //   celebrate/dance hops on the stage root.
  // - Speech: while the Core voice is active the island feeds a real voice
  //   envelope (setSpeechLevel, from the page voiceAmp). The baked mouth
  //   clips are faded to a whisper and the Speech_Mouth / Mouth_Details
  //   morphs + Jaw_Open are driven procedurally from that envelope
  //   (speechMorphs below - a deterministic function of the envelope, never
  //   random chatter). When speech ends the baked clips rule again.
  // - Blink is the Owner's baked eyelid clips; no procedural blink is
  //   layered on top (it would fight the baked weights).
  // - Costumes: the base model ships ONE outfit. setCostume keeps the 2D
  //   rig's validation contract and records the choice; the visual swap
  //   arrives with the costume models (Owner: costume integration later).
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
  function pokeVerdict(times, now) {                              // bounded poke reactions (same semantics as v4)
    const w = times.filter(t => now - t < 4000);
    if (w.length >= 6) return 'dizzy';
    if (w.length >= 3) return 'annoyed';
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

  const CSS = `
.dnc-slot { position: relative; }
.dn3d-view { position: absolute; inset: 0; overflow: hidden; border-radius: 14px; }
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
      gaze: { x: 0, y: 0, tx: 0, ty: 0 }, hover: false, hoverAmt: 0,
      squash: { x: 1, v: 0 }, hop: spr(), talkEnv: spr(),
      pointAmt: spr(), waveAmt: spr(),
      gesture: null, gestureUntil: 0,
      speaking: false, speechLevel: 0, speechAt: 0,
      danceUntil: 0, emoteHoldUntil: 0, shakeUntil: 0,
      pokes: [], started: false, raf: 0, last: 0, t: 0,
      modelStatus: 'idle', // idle -> loading -> ready | failed
      template: null, clips: null, bbox: null,
    };
    const views = [];

    function buildView(el) {
      el.innerHTML = '';
      const view = document.createElement('div'); view.className = 'dn3d-view';
      const fb = document.createElement('div'); fb.className = 'dn3d-fallback';
      const img = document.createElement('img'); img.alt = ''; img.src = FALLBACK_IMG;
      fb.appendChild(img); view.appendChild(fb); el.appendChild(view);
      return {
        el, view, fb, kind: (el.getAttribute && el.getAttribute('data-dnc')) || (views.length ? 'stage' : 'head'),
        renderer: null, scene: null, camera: null, mixer: null, actions: {},
        bones: {}, morphs: {}, group: null, w: 0, h: 0,
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
          S.template = gltf.scene; S.clips = gltf.animations || [];
          const box = new THREE.Box3().setFromObject(S.template);
          S.bbox = { size: box.getSize(new THREE.Vector3()), center: box.getCenter(new THREE.Vector3()) };
          S.modelStatus = 'ready';
          for (const v of views) buildStage(v);
        }, err => failAll(err));
      }).catch(err => failAll(err));
    }
    function findClip(name) { return (S.clips || []).find(c => c.name === name) || null; }
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
        v.mixer = new THREE.AnimationMixer(model);
        for (const key2 of Object.keys(CLIP)) {
          const clip = findClip(CLIP[key2]);
          if (!clip) continue;
          const a = v.mixer.clipAction(clip);
          a.setLoop(THREE.LoopRepeat, Infinity); a.weight = 1; a.play();
          v.actions[key2] = a;
        }
        frameCamera(v, true);
      } catch (err) { showFallback(v); S.error = String((err && err.message) || err); }
    }
    // Camera framing from the model bbox: the head slot frames the head,
    // the stage slot frames the bust (the 2D stage cover-cropped the same
    // way - the expanded island stage is wide and short).
    function frameCamera(v, force) {
      if (!v.camera || !S.bbox) return;
      const w = v.el.clientWidth || 0, h = v.el.clientHeight || 0;
      if (!w || !h) return;
      if (!force && w === v.w && h === v.h) return;
      v.w = w; v.h = h;
      v.renderer.setSize(w, h, false);
      const { size, center } = S.bbox;
      const fov = v.camera.fov * Math.PI / 180;
      let fitH, ty;
      if (v.kind === 'head') { fitH = size.y * 0.36; ty = center.y + size.y * 0.30; }
      else { fitH = size.y * 0.66; ty = center.y + size.y * 0.14; }
      const dist = (fitH / 2) / Math.tan(fov / 2);
      v.camera.aspect = w / h;
      v.camera.position.set(center.x, ty, center.z + dist * 1.04);
      v.camera.lookAt(center.x, ty, center.z);
      v.camera.updateProjectionMatrix();
    }
    // Additive bone rotation on top of the baked pose (post-mixer).
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

    function frame(now) {
      S.raf = requestAnimationFrame(frame);
      if (!isVisible() || document.hidden) { S.last = now; return; }
      const dt = Math.min(0.05, (now - S.last) / 1000 || 0.016); S.last = now;
      S.t += dt;
      const t = S.t, rm = reducedMotion(), amp = rm ? 0.3 : 1;
      const emph = emoteEmphasis(S.emote);
      if (S.gesture && now > S.gestureUntil) S.gesture = null;
      if (S.emoteHoldUntil && now > S.emoteHoldUntil && S.emote !== S.baseEmote) S.emote = S.baseEmote;
      // springs
      S.gaze.x += (S.gaze.tx - S.gaze.x) * Math.min(1, dt * 10);
      S.gaze.y += (S.gaze.ty - S.gaze.y) * Math.min(1, dt * 10);
      stepSpring(S.squash, 1, dt, 170, 13);
      stepSpring(S.hop, 0, dt, 110, 10.5);
      stepSpring(S.pointAmt, S.gesture === 'point' ? 1 : 0, dt, 150, 12.5);
      stepSpring(S.waveAmt, S.gesture === 'wave' ? 1 : 0, dt, 170, 14);
      const talkTarget = S.speaking ? (now - S.speechAt < 260 ? S.speechLevel : 0.32) : 0;
      stepSpring(S.talkEnv, talkTarget, dt, 300, 21);
      const talk = S.talkEnv.x;
      S.hoverAmt += ((S.hover ? 1 : 0) - S.hoverAmt) * Math.min(1, dt * 8);
      const dancing = now < S.danceUntil && !rm;
      const sizeY = S.bbox ? S.bbox.size.y : 1;

      for (const v of views) {
        if (!v.scene) continue;
        frameCamera(v, false);
        // clip rate carries the emote emphasis; speech clips fade while
        // the live envelope drives the mouth.
        const speechW = talk > 0.01 ? SPEECH_BAKED_WEIGHT : 1;
        for (const k of SPEECH_CLIP_KEYS) if (v.actions[k]) v.actions[k].setEffectiveWeight(speechW);
        v.mixer.update(dt * emph.rate);
        // ---- overlays (post-mixer, additive / morph writes)
        if (talk > 0.01) {
          const m = speechMorphs(talk, t);
          const sm = v.morphs['Speech_Mouth'], md = v.morphs['Mouth_Details'], hd = v.morphs['Body_Head'];
          setMorph(sm, 'Mouth_Open', m.Mouth_Open); setMorph(sm, 'Mouth_Wide', m.Mouth_Wide); setMorph(sm, 'Mouth_Round', m.Mouth_Round);
          setMorph(md, 'Mouth_Open', m.Mouth_Open); setMorph(md, 'Mouth_Wide', m.Mouth_Wide); setMorph(md, 'Mouth_Round', m.Mouth_Round);
          setMorph(hd, 'Jaw_Open', m.Jaw_Open);
        }
        const gt = gestureTargets(S.gesture);
        const gAmt = S.gesture === 'wave' ? S.waveAmt.x : S.gesture === 'point' ? S.pointAmt.x : 0;
        if (gt && gAmt > 0.003) {
          const osc = gt.waveOsc ? Math.sin(t * 9.2 - 0.75) * gt.waveOsc * gAmt : 0;
          addRot(v.bones['upper_arm.R'], gt.upperArm.x * gAmt * amp, gt.upperArm.y * gAmt, gt.upperArm.z * gAmt * amp);
          addRot(v.bones['forearm.R'], gt.forearm.x * gAmt * amp, gt.forearm.y * gAmt, (gt.forearm.z + osc) * amp);
        }
        // gaze + emote emphasis lean the neck/head over the baked pose
        const yaw = S.gaze.x * 0.20 * amp, pitch = (S.gaze.y * 0.12 + emph.pitch) * (amp < 1 ? 0.6 : 1);
        addRot(v.bones['neck'], pitch * 0.5, yaw * 0.5, emph.roll * 0.4);
        addRot(v.bones['head'], pitch * 0.6, yaw * 0.6, emph.roll * 0.6 + (S.emote === 'dizzy' ? Math.sin(t * 2.2) * 0.05 * amp : 0));
        // stage root: breath bob (scaled by emphasis), hop, squash, shake
        const bob = Math.sin(t * (Math.PI * 2 / 4.9) + 1.3) * 0.010 * sizeY * emph.bob * amp;
        const danceBounce = dancing ? Math.abs(Math.sin(t * 7.5)) * 0.022 * sizeY : 0;
        v.group.position.y = bob + S.hop.x * sizeY * 0.12 + danceBounce + S.hoverAmt * 0.004 * sizeY;
        const sq = Math.max(0.7, Math.min(1.15, S.squash.x)) * (1 + S.hoverAmt * 0.03);
        v.group.scale.set(2 - sq, sq, 2 - sq);
        v.group.rotation.z = now < S.shakeUntil && !rm ? Math.sin(now * 0.11) * 0.03 * Math.max(0, (S.shakeUntil - now) / 900) : 0;
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
      setEmote(e, holdMs = 0) {
        if (!EMOTES.includes(e)) return;
        S.baseEmote = e; S.emote = e;
        S.emoteHoldUntil = holdMs ? performance.now() + holdMs : 0;
      },
      // Contract parity with the 2D rig (validation + record). The base
      // model has one outfit; the choice applies when costume models land.
      setCostume(name) {
        if (name !== null && !COSTUMES.includes(name)) return false;
        S.costume = name;
        return true;
      },
      getCostume() { return S.costume; },
      setGesture(g, holdMs = 2600) {
        if (g !== null && g !== 'wave' && g !== 'point') return false;
        S.gesture = g;
        S.gestureUntil = g ? performance.now() + holdMs : 0;
        return true;
      },
      getGesture() { return S.gesture; },
      setSpeaking(on) { S.speaking = !!on; if (!on) S.speechLevel = 0; },
      setSpeechLevel(v) { S.speechLevel = clamp01(v); S.speechAt = performance.now(); },
      celebrate() {
        api.setGesture('wave', 1500);
        if (reducedMotion()) { api.setEmote('senang', 1200); return; }
        S.hop.v = 2.4;
        api.setEmote('senang', 1400);
      },
      dance(ms = 1600) { if (!reducedMotion()) { S.danceUntil = performance.now() + ms; api.setGesture('wave', ms); api.setEmote('senang', ms); } },
      greet() {
        api.setEmote('senang', 1600);
        api.setGesture('wave', 1300);
        if (!reducedMotion()) S.hop.v = 2.0;
      },
      poke() {
        const now = performance.now();
        S.pokes = S.pokes.filter(x => now - x < 4000); S.pokes.push(now);
        const verdict = pokeVerdict(S.pokes, now);
        if (reducedMotion()) return verdict;
        S.squash.v = -6.5;
        if (verdict === 'annoyed') api.setEmote('annoyed', 1100);
        else if (verdict === 'dizzy') { api.setEmote('dizzy', 1500); S.shakeUntil = now + 900; S.pokes = []; }
        return verdict;
      },
      setGaze(nx, ny) { const g = clampGaze(nx, ny); S.gaze.tx = g.x; S.gaze.ty = g.y; },
      setHover(on) { S.hover = !!on; },
      relayout() { for (const v of views) { v.w = 0; frameCamera(v, true); } },
      _state: S,
    };
    return api;
  }

  root.DamarNotch3D = {
    create, EMOTES, COSTUMES, CLIP, SPEECH_BAKED_WEIGHT,
    _pure: { clampGaze, clamp01, stepSpring, pokeVerdict, speechMorphs, emoteEmphasis, gestureTargets },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DamarNotch3D;
})(typeof window !== 'undefined' ? window : globalThis);
