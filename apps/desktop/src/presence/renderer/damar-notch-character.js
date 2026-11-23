(function (root) {
  'use strict';
  // Damar Notch character - LAYERED construction (Fase 2). The previous
  // character was one flat PNG (damar_notch_hero_rig.png) moved as a unit,
  // which is why it felt stiff: no per-part motion was possible. This module
  // rebuilds the same golden-flame mascot as layered SVG parts in the
  // renderer - body, inner flame, SEPARATE eyeball/pupil/glint per eye,
  // lids, mouth variants, brows, celebration rays, particles - each with its
  // own pivot (transform-box: fill-box), driven by springs, a randomized
  // blink scheduler, and gaze that follows the cursor. Emotes bind to the
  // island's real Core events (attention/activity), never to random timers.
  // The repo holds no layered/vector source for the mascot (flat PNGs only);
  // these paths follow the emblem's silhouette and palette
  // (#F5B942 / #D97706 / #854210). Pure logic is exported for node tests.

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

  const SVG = `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Damar Notch">
  <defs>
    <linearGradient id="dncGold" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#854210"/><stop offset=".55" stop-color="#D97706"/><stop offset="1" stop-color="#F5B942"/>
    </linearGradient>
    <radialGradient id="dncGlow" cx=".5" cy=".62" r=".55">
      <stop offset="0" stop-color="#FDE9B8" stop-opacity=".95"/><stop offset="1" stop-color="#F5B942" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g class="dnc-rays" opacity="0">
    <g stroke="#F5B942" stroke-width="3" stroke-linecap="round">
      <path d="M60 2v10"/><path d="M22 16l6 8"/><path d="M98 16l-6 8"/><path d="M8 44h10"/><path d="M102 44h10"/>
    </g>
  </g>
  <g class="dnc-body">
    <path class="dnc-flame-outer" fill="url(#dncGold)" d="M60 4c3 14 20 22 20 44a20 22 0 1 1-40 0c0-9 4-15 8-21 1 5 3 8 6 10-1-11 2-24 6-33z"/>
    <path class="dnc-flame-inner" fill="#FBBF24" opacity=".85" d="M60 40c2 8 10 12 10 23a10 11 0 1 1-20 0c0-6 3-10 5-13 1 3 2 5 4 6-1-6 0-12 1-16z"/>
    <ellipse cx="60" cy="74" rx="17" ry="15" fill="url(#dncGlow)"/>
    <g class="dnc-face">
      <g class="dnc-brows" opacity="0" stroke="#5b2d08" stroke-width="3.4" stroke-linecap="round">
        <path d="M36 47l14 4"/><path d="M84 47l-14 4"/>
      </g>
      <g class="dnc-eye dnc-eye-l">
        <ellipse class="dnc-ball" cx="46" cy="60" rx="9.5" ry="10.5" fill="#fff7e6"/>
        <g class="dnc-pupil"><circle cx="46" cy="61" r="4.6" fill="#2a1602"/><circle cx="47.8" cy="58.8" r="1.6" fill="#fff"/></g>
        <path class="dnc-happy" d="M37.5 61a8.5 8.5 0 0 1 17 0" fill="none" stroke="#2a1602" stroke-width="3" stroke-linecap="round" opacity="0"/>
        <path class="dnc-closed" d="M37.5 61h17" stroke="#2a1602" stroke-width="3" stroke-linecap="round" opacity="0"/>
        <path class="dnc-dizzy" d="M39 54l14 14M53 54L39 68" stroke="#2a1602" stroke-width="2.8" stroke-linecap="round" opacity="0"/>
        <rect class="dnc-lid" x="36.5" y="49" width="19" height="13" rx="9" fill="#D97706"/>
      </g>
      <g class="dnc-eye dnc-eye-r">
        <ellipse class="dnc-ball" cx="74" cy="60" rx="9.5" ry="10.5" fill="#fff7e6"/>
        <g class="dnc-pupil"><circle cx="74" cy="61" r="4.6" fill="#2a1602"/><circle cx="75.8" cy="58.8" r="1.6" fill="#fff"/></g>
        <path class="dnc-happy" d="M65.5 61a8.5 8.5 0 0 1 17 0" fill="none" stroke="#2a1602" stroke-width="3" stroke-linecap="round" opacity="0"/>
        <path class="dnc-closed" d="M65.5 61h17" stroke="#2a1602" stroke-width="3" stroke-linecap="round" opacity="0"/>
        <path class="dnc-dizzy" d="M67 54l14 14M81 54L67 68" stroke="#2a1602" stroke-width="2.8" stroke-linecap="round" opacity="0"/>
        <rect class="dnc-lid" x="64.5" y="49" width="19" height="13" rx="9" fill="#D97706"/>
      </g>
      <g class="dnc-mouths" fill="none" stroke="#5b2d08" stroke-width="3.2" stroke-linecap="round">
        <path class="dnc-m-smile" d="M50 76a10 8 0 0 0 20 0"/>
        <path class="dnc-m-think" d="M54 79h11" opacity="0"/>
        <path class="dnc-m-flat" d="M51 78h18" opacity="0"/>
        <path class="dnc-m-wavy" d="M50 78q5-5 10 0t10 0" opacity="0"/>
      </g>
    </g>
  </g>
  <g class="dnc-particles"></g>
</svg>`;

  const CSS = `
.dnc-slot svg { overflow: visible; }
.dnc-body { transform-box: fill-box; transform-origin: 50% 92%; }
.dnc-face { transform-box: fill-box; transform-origin: 50% 55%; }
.dnc-eye { transform-box: fill-box; transform-origin: 50% 50%; }
.dnc-lid { transform-box: fill-box; transform-origin: 50% 0%; transform: scaleY(0); }
.dnc-pupil { will-change: transform; }
.dnc-rays, .dnc-brows, .dnc-mouths path, .dnc-eye .dnc-happy, .dnc-eye .dnc-closed, .dnc-eye .dnc-dizzy { transition: opacity .18s ease; }
.dnc-particle { pointer-events: none; }`;

  function buildView(el) {
    el.innerHTML = SVG;
    const q = (sel) => el.querySelectorAll(sel);
    return {
      el,
      body: el.querySelector('.dnc-body'), face: el.querySelector('.dnc-face'),
      pupils: q('.dnc-pupil'), lids: q('.dnc-lid'), balls: q('.dnc-ball'),
      happy: q('.dnc-happy'), closed: q('.dnc-closed'), dizzy: q('.dnc-dizzy'),
      brows: el.querySelector('.dnc-brows'), rays: el.querySelector('.dnc-rays'),
      mouths: { smile: el.querySelector('.dnc-m-smile'), think: el.querySelector('.dnc-m-think'), flat: el.querySelector('.dnc-m-flat'), wavy: el.querySelector('.dnc-m-wavy') },
      particles: el.querySelector('.dnc-particles'),
    };
  }

  function create(opts = {}) {
    const isVisible = opts.isVisible || (() => true);
    const reducedMotion = opts.reducedMotion || (() => false);
    const rand = opts.random || Math.random;
    const views = [];
    const S = {
      emote: 'senang', gaze: { x: 0, y: 0, tx: 0, ty: 0 }, hover: false,
      squash: { x: 1, v: 0 }, jump: { x: 0, v: 0 },
      blinkAt: performance.now() + nextBlinkDelay(rand), blinkPhase: 0, doubleBlink: false,
      danceUntil: 0, raysUntil: 0, emoteHoldUntil: 0, baseEmote: 'senang',
      pokes: [], particles: [], started: false, raf: 0, last: 0,
    };
    function applyFace() {
      const f = EMOTE_FACE[S.emote] || EMOTE_FACE.senang;
      for (const v of views) {
        const showBall = f.eyes === 'open' || f.eyes === 'look' || f.eyes === 'half';
        v.balls.forEach(b => { b.style.opacity = showBall ? '1' : '0'; });
        v.pupils.forEach(p => { p.style.opacity = showBall ? '1' : '0'; });
        v.happy.forEach(p => { p.style.opacity = f.eyes === 'happy' ? '1' : '0'; });
        v.closed.forEach(p => { p.style.opacity = f.eyes === 'closed' ? '1' : '0'; });
        v.dizzy.forEach(p => { p.style.opacity = f.eyes === 'dizzy' ? '1' : '0'; });
        v.brows.style.opacity = f.brows ? '1' : '0';
        for (const [k, m] of Object.entries(v.mouths)) m.style.opacity = k === f.mouth ? '1' : '0';
      }
    }
    function setEmote(e, holdMs = 0) {
      if (!EMOTE_FACE[e]) return;
      S.baseEmote = e;
      S.emote = e;
      S.emoteHoldUntil = holdMs ? performance.now() + holdMs : 0;
      applyFace();
    }
    function spawnParticles() {
      for (const v of views) {
        for (let i = 0; i < 7; i++) {
          const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('r', String(1.6 + rand() * 2.2));
          c.setAttribute('fill', i % 2 ? '#F5B942' : '#FDE9B8');
          c.classList.add('dnc-particle');
          v.particles.appendChild(c);
          S.particles.push({ el: c, x: 60 + (rand() - 0.5) * 26, y: 30, vx: (rand() - 0.5) * 46, vy: -(26 + rand() * 36), life: 1 });
        }
      }
    }
    function celebrate() {
      if (reducedMotion()) { setEmote('senang', 1200); return; }
      S.jump.v = -340; S.raysUntil = performance.now() + 900;
      setEmote('senang', 1400); spawnParticles();
    }
    function frame(now) {
      S.raf = requestAnimationFrame(frame);
      if (!isVisible() || document.hidden) { S.last = now; return; }
      const dt = Math.min(0.05, (now - S.last) / 1000 || 0.016); S.last = now;
      const rm = reducedMotion();
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
      if (faceNow.eyes === 'closed') lidScale = 0;   // closed-line paths carry the expression; lids are only for blinks/half
      if (faceNow.eyes === 'half') lidScale = Math.max(lidScale, 0.55);
      // gaze: pupils lead, face parallaxes a little, head tilts a touch
      S.gaze.x += (S.gaze.tx - S.gaze.x) * Math.min(1, dt * 10);
      S.gaze.y += (S.gaze.ty - S.gaze.y) * Math.min(1, dt * 10);
      // springs: squash & stretch + jump
      stepSpring(S.squash, 1, dt, 170, 13);
      stepSpring(S.jump, 0, dt, 120, 11);
      const dancing = now < S.danceUntil && !rm;
      const breath = rm ? 0 : Math.sin(now / 1000 * 2.1);
      const bounce = dancing ? Math.abs(Math.sin(now / 1000 * 7.5)) * -7 : 0;
      const hoverScale = S.hover && !rm ? 1.07 : 1;
      for (const v of views) {
        const sy = S.squash.x * (1 + breath * 0.018) * hoverScale;
        const sx = (2 - S.squash.x) * (1 - breath * 0.006) * hoverScale;
        v.body.style.transform = `translateY(${(S.jump.x * 0.06 + bounce + breath * 0.7).toFixed(2)}px) scale(${sx.toFixed(3)}, ${sy.toFixed(3)}) rotate(${(S.gaze.x * 2.2).toFixed(2)}deg)`;
        v.face.style.transform = `translate(${(S.gaze.x * 2.4).toFixed(2)}px, ${(S.gaze.y * 1.7).toFixed(2)}px)`;
        v.pupils.forEach(p => { p.style.transform = `translate(${(S.gaze.x * 4.6).toFixed(2)}px, ${(S.gaze.y * 3.4).toFixed(2)}px)`; });
        v.lids.forEach(l => { l.style.transform = `scaleY(${lidScale.toFixed(3)})`; });
        v.rays.style.opacity = now < S.raysUntil ? '1' : '0';
      }
      // particles
      for (let i = S.particles.length - 1; i >= 0; i--) {
        const p = S.particles[i];
        p.vy += 130 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 1.1;
        if (p.life <= 0) { p.el.remove(); S.particles.splice(i, 1); continue; }
        p.el.setAttribute('cx', p.x.toFixed(1)); p.el.setAttribute('cy', p.y.toFixed(1)); p.el.setAttribute('opacity', Math.max(0, p.life).toFixed(2));
      }
      if (S.emoteHoldUntil && now > S.emoteHoldUntil && S.emote !== S.baseEmote) { S.emote = S.baseEmote; applyFace(); }
    }
    const api = {
      attach(el) { if (!el) return null; const v = buildView(el); views.push(v); applyFace(); return v; },
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
      celebrate,
      dance(ms = 1600) { if (!reducedMotion()) { S.danceUntil = performance.now() + ms; setEmote('senang', ms); } },
      greet() { S.raysUntil = performance.now() + 1500; if (!reducedMotion()) S.jump.v = -300; setEmote('senang', 1600); },
      poke() {
        const now = performance.now();
        S.pokes = S.pokes.filter(t => now - t < 4000); S.pokes.push(now);
        const verdict = pokeVerdict(S.pokes, now);
        if (reducedMotion()) return verdict;
        S.squash.v = -7.5;
        if (verdict === 'annoyed') setEmote('annoyed', 1100);
        else if (verdict === 'dizzy') { setEmote('dizzy', 1500); S.pokes = []; }
        return verdict;
      },
      setGaze(nx, ny) { const g = clampGaze(nx, ny); S.gaze.tx = g.x; S.gaze.ty = g.y; },
      setHover(on) { S.hover = !!on; },
      _state: S,
    };
    return api;
  }

  root.DamarNotchCharacter = { create, EMOTE_FACE, _pure: { clampGaze, nextBlinkDelay, blinkDuration, stepSpring, pokeVerdict } };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DamarNotchCharacter;
})(typeof window !== 'undefined' ? window : globalThis);
