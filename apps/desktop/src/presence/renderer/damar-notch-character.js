(function (root) {
  'use strict';
  // Damar Notch character - V3 SPRITE STAGE (Fase 2, owner-ACC art direction
  // 2026-11-24). The v1 layered-SVG face and the v2 flat preview were both
  // rejected by the Owner ("serem", "mentah"); v3 renders the approved glossy
  // chibi art (cropped from the Owner's own concept-sheet renders, plus two
  // costumes generated in the same style) as full-character sprites on a
  // two-layer crossfading stage. What stays from the layered engine: springs
  // (squash & stretch, jump), the randomized blink scheduler, poke verdicts,
  // emote holds - all driven by the island's real Core events, never random
  // timers. What changes honestly with full-body renders: gaze is a
  // sprite-level parallax (stage translate + slight tilt) instead of
  // per-pupil movement, and blink is a soft lid overlay swept over the eye
  // line of the current sprite. The v2 spinning animation is REMOVED (Owner
  // rejected it); "dizzy" is a decaying shake. Costume changes are a short
  // golden-swirl SHOW (~0.75 s): the swirl covers the character, the sprite
  // swaps at the covered midpoint with a hop, then the swirl lifts - never
  // an uncovered instant swap, in either direction. Motion loops are pure
  // sine cycles (breath 3.4 s, float 4.9 s) so they repeat seamlessly.

  const EMOTE_FACE = {
    senang: { eyes: 'open', mouth: 'smile', brows: false },
    berpikir: { eyes: 'look', mouth: 'think', brows: false },
    siaga: { eyes: 'open', mouth: 'flat', brows: true },
    pulih: { eyes: 'closed', mouth: 'wavy', brows: false },
    orbStandby: { eyes: 'closed', mouth: 'smile', brows: false },
    annoyed: { eyes: 'half', mouth: 'flat', brows: true },
    dizzy: { eyes: 'dizzy', mouth: 'wavy', brows: false },
  };
  const clampGaze = (x, y) => { const m = Math.hypot(x || 0, y || 0); const s = m > 1 ? 1 / m : 1; return { x: (x || 0) * s, y: (y || 0) * s }; };
  const nextBlinkDelay = (rand) => 2400 + rand() * 2800;         // 2.4-5.2 s, never metronomic
  const blinkDuration = 130;                                      // ms per blink
  function stepSpring(st, target, dt, k, d) {                     // semi-implicit Euler spring
    const a = (target - st.x) * k - st.v * d;
    st.v += a * dt; st.x += st.v * dt;
    return st;
  }
  function pokeVerdict(times, now) {                              // bounded poke reactions
    const w = times.filter(t => now - t < 4000);
    if (w.length >= 6) return 'dizzy';
    if (w.length >= 3) return 'annoyed';
    return 'squash';
  }

  // Sprite set: expressions cropped from the Owner-ACC expression sheet,
  // costumes from the Owner-ACC costume sheet + engineer/artist generated
  // in the same style. eyeY = eye line as a fraction of the source sprite,
  // the cover-framed face of each sprite.
  const SPRITES = {
    happy:     { src: '/notch-v3/expr-happy.webp',        eyeY: 0.40 },
    alert:     { src: '/notch-v3/expr-alert.webp',        eyeY: 0.40 },
    thinking:  { src: '/notch-v3/expr-thinking.webp',     eyeY: 0.41 },
    recovering:{ src: '/notch-v3/expr-recovering.webp',   eyeY: 0.40 },
    surprised: { src: '/notch-v3/expr-surprised.webp',    eyeY: 0.385 },
    chef:      { src: '/notch-v3/costume-chef.webp',      eyeY: 0.38 },
    hacker:    { src: '/notch-v3/costume-hacker.webp',    eyeY: 0.40 },
    engineer:  { src: '/notch-v3/costume-engineer.webp',  eyeY: 0.40 },
    detective: { src: '/notch-v3/costume-detective.webp', eyeY: 0.42 },
    artist:    { src: '/notch-v3/costume-artist.webp',    eyeY: 0.44 },
    matadewa:  { src: '/notch-v3/costume-matadewa.webp',  eyeY: 0.40 },
  };
  // Eye centres as fractions of the SOURCE sprite (x pair, y per sprite).
  const EYE_X = [0.36, 0.63];
  // Lid layout from the real cover-crop geometry: object-fit cover scales
  // the sprite by max(w/iw, h/ih) and object-position 50% 20% anchors it,
  // so the eye line's position in the slot is computable exactly once the
  // image's natural size is known. Until load, a static estimate is used.
  function layoutLids(v, key) {
    const cfg = SPRITES[key]; if (!cfg) return;
    const img = v.front;
    const w = v.wrap.clientWidth || 0, h = v.wrap.clientHeight || 0;
    const iw = img.naturalWidth || 0, ih = img.naturalHeight || 0;
    if (!w || !h || !iw || !ih) { for (const lid of v.lids) lid.style.top = '36%'; return; }
    const scale = Math.max(w / iw, h / ih);
    const offX = (w - iw * scale) * 0.5, offY = (h - ih * scale) * 0.2;
    const eyeTopPct = ((offY + cfg.eyeY * ih * scale) / h) * 100;
    v.lids[0].style.left = (((offX + EYE_X[0] * iw * scale) / w) * 100 - 9.5) + '%';
    v.lids[1].style.left = (((offX + EYE_X[1] * iw * scale) / w) * 100 - 9.5) + '%';
    for (const lid of v.lids) lid.style.top = (eyeTopPct - 4.5) + '%';
  }
  const EMOTE_SPRITE = { senang: 'happy', berpikir: 'thinking', siaga: 'alert', pulih: 'recovering', orbStandby: 'recovering', annoyed: 'alert', dizzy: 'surprised' };
  const COSTUMES = ['chef', 'hacker', 'engineer', 'detective', 'artist', 'matadewa'];
  // Urgent/resting emotes visually break the costume (alert must read at a
  // glance; resting in costume makes no sense). The costume returns when
  // the emote settles.
  const OVERRIDE_EMOTES = new Set(['siaga', 'pulih', 'orbStandby']);

  const CSS = `
.dnc-slot { position: relative; }
.dnc3-stage { width: 100%; height: 100%; overflow: hidden; border-radius: 14px; }
.dnc3-float { width: 100%; height: 100%; transform-origin: 50% 92%; will-change: transform; }
.dnc3-wrap { position: relative; width: 100%; height: 100%; will-change: transform; }
.dnc3-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 20%; transition: opacity .24s ease; pointer-events: none; }
.dnc3-lid { position: absolute; width: 19%; height: 9%; border-radius: 50%; background: radial-gradient(ellipse at center, #14142a 58%, rgba(20,20,42,0) 76%); transform: scaleY(0); pointer-events: none; }
.dnc3-swirl { position: absolute; inset: -14%; border-radius: 50%; pointer-events: none; opacity: 0; transition: opacity .18s ease;
  background: conic-gradient(from 0deg, transparent 0 12%, rgba(245,185,66,.9) 22%, rgba(253,233,184,.95) 28%, transparent 40% 55%, rgba(245,185,66,.8) 66%, transparent 78%);
  -webkit-mask: radial-gradient(circle, transparent 30%, #000 62%, transparent 79%); mask: radial-gradient(circle, transparent 30%, #000 62%, transparent 79%); }
.dnc3-swirl.on { opacity: 1; animation: dnc3spin .62s linear infinite; }
@keyframes dnc3spin { to { transform: rotate(360deg); } }
.dnc3-spark { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: #F5B942; pointer-events: none; }`;

  function buildView(el) {
    el.innerHTML = '';
    const stage = document.createElement('div'); stage.className = 'dnc3-stage';
    const float = document.createElement('div'); float.className = 'dnc3-float';
    const wrap = document.createElement('div'); wrap.className = 'dnc3-wrap';
    const back = document.createElement('img'); back.className = 'dnc3-img'; back.alt = ''; back.style.opacity = '0';
    const front = document.createElement('img'); front.className = 'dnc3-img'; front.alt = ''; front.style.opacity = '1';
    const lidL = document.createElement('div'); lidL.className = 'dnc3-lid'; lidL.style.left = '27%';
    const lidR = document.createElement('div'); lidR.className = 'dnc3-lid'; lidR.style.left = '54%';
    const swirl = document.createElement('div'); swirl.className = 'dnc3-swirl';
    const sparks = document.createElement('div'); sparks.className = 'dnc3-sparks';
    wrap.append(back, front, lidL, lidR, swirl, sparks);
    float.append(wrap); stage.append(float); el.append(stage);
    return { el, body: float, face: wrap, stage, wrap, front, back, lids: [lidL, lidR], swirl, sparks, frontKey: null };
  }

  function create(opts = {}) {
    const isVisible = opts.isVisible || (() => true);
    const reducedMotion = opts.reducedMotion || (() => false);
    const rand = opts.random || Math.random;
    const views = [];
    const S = {
      emote: 'senang', baseEmote: 'senang', costume: null, sprite: 'happy',
      gaze: { x: 0, y: 0, tx: 0, ty: 0 }, hover: false,
      squash: { x: 1, v: 0 }, jump: { x: 0, v: 0 },
      blinkAt: performance.now() + nextBlinkDelay(rand), blinkPhase: 0, doubleBlink: false,
      danceUntil: 0, emoteHoldUntil: 0, shakeUntil: 0,
      show: null,            // { swapAt, endAt, target } costume-change show in flight
      pokes: [], particles: [], started: false, raf: 0, last: 0,
    };
    function resolveSprite() {
      if (OVERRIDE_EMOTES.has(S.emote)) return EMOTE_SPRITE[S.emote];
      if (S.costume) return S.costume;
      return EMOTE_SPRITE[S.emote] || 'happy';
    }
    function showSprite(key) {
      if (!SPRITES[key]) return;
      S.sprite = key;
      for (const v of views) {
        v.back.src = SPRITES[key].src;
        v.back.style.opacity = '1';
        v.front.style.opacity = '0';
        const old = v.front; v.front = v.back; v.back = old; v.frontKey = key;
        layoutLids(v, key);
      }
    }
    function syncSprite() {
      const target = resolveSprite();
      if (target !== S.sprite && !S.show) showSprite(target);
    }
    function setEmote(e, holdMs = 0) {
      if (!EMOTE_FACE[e]) return;
      S.baseEmote = e;
      S.emote = e;
      S.emoteHoldUntil = holdMs ? performance.now() + holdMs : 0;
      syncSprite();
    }
    function setCostume(name) {
      if (name !== null && !COSTUMES.includes(name)) return false;
      if (name === S.costume) return true;
      S.costume = name;
      const target = resolveSprite();
      if (target === S.sprite) return true;
      if (reducedMotion()) { showSprite(target); return true; }
      const now = performance.now();
      S.show = { swapAt: now + 320, endAt: now + 760, target };
      for (const v of views) v.swirl.classList.add('on');
      return true;
    }
    function spawnParticles() {
      for (const v of views) {
        for (let i = 0; i < 7; i++) {
          const c = document.createElement('div');
          c.className = 'dnc3-spark';
          c.style.background = i % 2 ? '#F5B942' : '#FDE9B8';
          v.sparks.appendChild(c);
          S.particles.push({ el: c, x: 50 + (rand() - 0.5) * 22, y: 26, vx: (rand() - 0.5) * 30, vy: -(18 + rand() * 24), life: 1 });
        }
      }
    }
    function celebrate() {
      if (reducedMotion()) { setEmote('senang', 1200); return; }
      S.jump.v = -340;
      setEmote('senang', 1400); spawnParticles();
    }
    function frame(now) {
      S.raf = requestAnimationFrame(frame);
      if (!isVisible() || document.hidden) { S.last = now; return; }
      const dt = Math.min(0.05, (now - S.last) / 1000 || 0.016); S.last = now;
      const rm = reducedMotion();
      // costume-change show: swap under the swirl at the covered midpoint
      if (S.show) {
        if (now >= S.show.swapAt && S.sprite !== S.show.target) { showSprite(S.show.target); S.jump.v = -300; }
        if (now >= S.show.endAt) { S.show = null; for (const v of views) v.swirl.classList.remove('on'); syncSprite(); }
      }
      // blink: randomized schedule, 130 ms lid sweep, occasional double blink
      let lidScale = 0;
      if (now >= S.blinkAt && S.blinkPhase === 0) S.blinkPhase = now;
      if (S.blinkPhase) {
        const p = (now - S.blinkPhase) / blinkDuration;
        if (p >= 1) {
          S.blinkPhase = 0;
          if (S.doubleBlink) { S.doubleBlink = false; S.blinkAt = now + 180; }
          else { S.blinkAt = now + nextBlinkDelay(rand); if (rand() < 0.12) S.doubleBlink = true; }
        } else lidScale = Math.sin(Math.min(1, p) * Math.PI);
      }
      const faceNow = EMOTE_FACE[S.emote] || EMOTE_FACE.senang;
      if (faceNow.eyes === 'closed') lidScale = 0;   // the art itself carries closed eyes there
      if (faceNow.eyes === 'half') lidScale = Math.max(lidScale, 0.55);
      // gaze: sprite-level parallax (stage translate + slight tilt)
      S.gaze.x += (S.gaze.tx - S.gaze.x) * Math.min(1, dt * 10);
      S.gaze.y += (S.gaze.ty - S.gaze.y) * Math.min(1, dt * 10);
      // springs: squash & stretch + jump
      stepSpring(S.squash, 1, dt, 170, 13);
      stepSpring(S.jump, 0, dt, 120, 11);
      const dancing = now < S.danceUntil && !rm;
      // seamless loops: pure sine cycles, values match at cycle boundaries
      const breath = rm ? 0 : Math.sin(now / 1000 * (Math.PI * 2 / 3.4));
      const floatY = rm ? 0 : Math.sin(now / 1000 * (Math.PI * 2 / 4.9) + 1.3);
      const bounce = dancing ? Math.abs(Math.sin(now / 1000 * 7.5)) * -7 : 0;
      const hoverScale = S.hover && !rm ? 1.07 : 1;
      const shake = now < S.shakeUntil && !rm ? Math.sin(now * 0.11) * 3.2 * Math.max(0, (S.shakeUntil - now) / 900) : 0;
      for (const v of views) {
        const sy = S.squash.x * (1 + breath * 0.018) * hoverScale;
        const sx = (2 - S.squash.x) * (1 - breath * 0.006) * hoverScale;
        v.body.style.transform = `translateY(${(S.jump.x * 0.06 + bounce).toFixed(2)}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
        v.face.style.transform = `translate(${(S.gaze.x * 3 + shake).toFixed(2)}px, ${(S.gaze.y * 2 + floatY * 1.6).toFixed(2)}px) rotate(${(S.gaze.x * 2).toFixed(2)}deg)`;
        v.lids.forEach(l => { l.style.transform = `scaleY(${lidScale.toFixed(3)})`; });
      }
      // particles
      for (let i = S.particles.length - 1; i >= 0; i--) {
        const p = S.particles[i];
        p.vy += 90 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 1.1;
        if (p.life <= 0) { p.el.remove(); S.particles.splice(i, 1); continue; }
        p.el.style.left = p.x.toFixed(1) + '%'; p.el.style.top = p.y.toFixed(1) + '%'; p.el.style.opacity = Math.max(0, p.life).toFixed(2);
      }
      if (S.emoteHoldUntil && now > S.emoteHoldUntil && S.emote !== S.baseEmote) { S.emote = S.baseEmote; syncSprite(); }
    }
    const api = {
      attach(el) {
        if (!el) return null;
        const v = buildView(el);
        v.front.src = SPRITES[S.sprite].src; v.frontKey = S.sprite;
        v.front.addEventListener?.('load', () => layoutLids(v, v.frontKey));
        v.back.addEventListener?.('load', () => layoutLids(v, v.frontKey));
        layoutLids(v, S.sprite);
        if (S.show) v.swirl.classList.add('on');
        views.push(v);
        return v;
      },
      start() {
        if (S.started) return; S.started = true;
        if (!document.getElementById('dnc-style')) {
          const st = document.createElement('style'); st.id = 'dnc-style'; st.textContent = CSS; document.head.appendChild(st);
        }
        S.last = performance.now();
        S.raf = requestAnimationFrame(frame);
      },
      stop() { S.started = false; cancelAnimationFrame(S.raf); },
      setEmote,
      setCostume,
      getCostume() { return S.costume; },
      celebrate,
      dance(ms = 1600) { if (!reducedMotion()) { S.danceUntil = performance.now() + ms; setEmote('senang', ms); } },
      greet() {
        setEmote('senang', 1600);
        if (!reducedMotion()) {
          S.jump.v = -300;
          for (const v of views) { v.swirl.classList.add('on'); setTimeout(() => v.swirl.classList.remove('on'), 620); }
        }
      },
      poke() {
        const now = performance.now();
        S.pokes = S.pokes.filter(t => now - t < 4000); S.pokes.push(now);
        const verdict = pokeVerdict(S.pokes, now);
        if (reducedMotion()) return verdict;
        S.squash.v = -7.5;
        if (verdict === 'annoyed') setEmote('annoyed', 1100);
        else if (verdict === 'dizzy') { setEmote('dizzy', 1500); S.shakeUntil = now + 900; S.pokes = []; }
        return verdict;
      },
      setGaze(nx, ny) { const g = clampGaze(nx, ny); S.gaze.tx = g.x; S.gaze.ty = g.y; },
      setHover(on) { S.hover = !!on; },
      _state: S,
    };
    return api;
  }

  root.DamarNotchCharacter = { create, EMOTE_FACE, EMOTE_SPRITE, SPRITES, COSTUMES, _pure: { clampGaze, nextBlinkDelay, blinkDuration, stepSpring, pokeVerdict } };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DamarNotchCharacter;
})(typeof window !== 'undefined' ? window : globalThis);
