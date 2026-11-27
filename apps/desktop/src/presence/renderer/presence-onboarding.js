'use strict';
// onboarding flow rev: a57ccff53a8cfa77
// DAMAR Presence first-run onboarding V2 (injected after presence-adapter.js). Runs exactly once: only
// while Core's centralized config reports presence.onboardingCompleted === false (the flag lives in Core,
// set by POST /api/r9/presence/onboarding - this script can never set it directly).
//
// V2 skin + choreography (spec ONBOARDING-V2-SPEC, owner 2026-11-26): the Presence "Arah A" look over the
// page's OWN orb - the real WebGL silk-field orb + goldSparks of Idle Presence, driven through the page's
// own parameters (targetOrbScale / damarIsSpeaking / pulseWave / targetEnergy / palette targets) and a
// runtime transform on #orbWrapper for the hero move. No orb/CSS imitation, no panel, no form grid,
// NO BUTTONS anywhere: Damar recognizes a finished answer from a 1000 ms typing pause (a paste counts
// instantly), exactly like the approved A5/A4 mocks. Remaining exits are quiet text links.
//
//   Step 0  Connect endpoint + API key (auto-attempt once both fields settle). Behind the connect, Core
//     probes the catalog and picks the model pair (capability-first); the choice is disclosed in one line.
//     -> fields fade, the orb grows into the hero while "Menyiapkan model..." shows, then the name step:
//     Damar greets BY VOICE (the page speak path) and asks the user's name.
//   Branch A (connected): the name is recognized ("Oke, <nama>.") and the live interview continues in a
//     chat view (answers auto-send on the typing pause); its DAMAR_SETUP_JSON line fills the summary.
//   Branch B (skipped / failed): the same name step, then the deterministic template questions one at a
//     time (zero model calls).
// Both branches end at a read-only summary that saves itself; the panel then fades and Presence lands
// with the saved name. Answers land in the same Core config the Control Dashboard reads.
(() => {
  const COPY = {
    id: {
      title: 'Perkenalan Damar',
      step0Intro: 'Halo, aku Damar — asisten AI pribadi di komputer ini. Sebelum mulai, kamu bisa menghubungkan layanan model AI (endpoint + API key) supaya aku bisa bercakap-cakap langsung denganmu. Kalau dilewati, kita tetap lanjut dengan perkenalan singkat tanpa model.',
      connectQ: 'Hubungkan <b>aku</b>',
      connectSub: 'Tempel endpoint provider dan API key-mu di bawah ini — begitu keduanya terisi, aku langsung mencoba terhubung. Tanpa tombol, tanpa ribet.',
      endpointPlaceholder: 'https://… /v1', apiKeyPlaceholder: 'API key',
      connecting: 'Menghubungi endpoint…',
      connectedDisclosure: 'Terhubung. Aku memakai {model} — paling seimbang di endpoint ini.',
      connectedPlain: 'Terhubung.',
      connectFail: 'Belum terhubung — {error}. Periksa lagi endpoint atau kuncinya, atau lanjut tanpa model.',
      skipConnect: 'Lewati dulu', toTemplate: 'Lanjut tanpa model',
      preparingModel: 'Menyiapkan model…', preparingTemplate: 'Menyiapkan mode template…',
      intro: 'Halo, aku Damar — asisten AI pribadi yang tinggal di komputer ini. Aku bisa membantumu lewat percakapan dan perintah, dan semua pengaturanku tersimpan di satu tempat: Control Dashboard. Supaya kita saling kenal, aku tanya beberapa hal singkat dulu, ya. Semua boleh dilewati.',
      voiceGreeting: 'Halo, aku Damar. Boleh aku tahu namamu?',
      nameQ: 'Siapa <b>namamu?</b>',
      nameSub: 'Biar aku bisa menyapamu dengan benar — mulai dari sini.',
      namePlaceholder: 'Tulis namamu di sini…',
      oke: 'Oke, {name}.',
      qName: 'Pertama — siapa namamu?',
      qSalutation: 'Kamu ingin kupanggil apa?',
      subSalutation: 'Boleh nama yang sama, boleh panggilan khusus — tulis saja.',
      qLanguage: 'Bahasa utama kita apa?',
      subLanguage: 'Tulis "Bahasa Indonesia" atau "English".',
      qVoice: 'Aktifkan percakapan suara?',
      subVoice: 'Tulis "ya" supaya kamu bisa bicara langsung denganku, atau "tidak".',
      fName: 'Nama', fSalutation: 'Sapaan', fLanguage: 'Bahasa', fVoice: 'Percakapan suara',
      stepSkip: 'Lewati', skipAllBtn: 'Lewati semua',
      saving: 'Menyimpan…', saveFail: 'Gagal menyimpan ({error}). Ketuk ringkasannya untuk mencoba lagi — jawabanmu tidak hilang.',
      closing: 'Senang berkenalan, {address}. Pengaturan awal selesai — aku siap membantu. Kamu bisa mengubahnya kapan pun di Control Dashboard.',
      closingNoName: 'Senang berkenalan. Pengaturan awal selesai — aku siap membantu. Kamu bisa mengubahnya kapan pun di Control Dashboard.',
      chatPlaceholder: 'Tulis jawabanmu…', chatThinking: 'Damar sedang mengetik…',
      chatFail: 'Percakapan terputus ({error}). Kita lanjut dengan pertanyaan singkat saja — jawaban yang sudah terkumpul tetap dipakai.',
      formIntroLive: 'Ini ringkasan dari percakapan kita — aku simpan sekarang, ya.',
      formIntroTemplate: 'Ini ringkasannya — aku simpan sekarang, ya.',
      summaryTitle: 'Ringkasan perkenalan kita',
      kickoff: 'Halo Damar, kamu baru terpasang di komputerku. Perkenalkan dirimu dan mulai perkenalan kita.',
      templateMode: 'Template',
    },
    en: {
      title: 'Meet Damar',
      step0Intro: 'Hi, I am Damar — a personal AI assistant on this computer. Before we start, you can connect an AI model service (endpoint + API key) so I can talk with you directly. If you skip it, we will simply continue with a short introduction without a model.',
      connectQ: 'Connect <b>me</b>',
      connectSub: 'Paste your provider endpoint and API key below — as soon as both are filled, I will try to connect on my own. No buttons, no fuss.',
      endpointPlaceholder: 'https://… /v1', apiKeyPlaceholder: 'API key',
      connecting: 'Contacting the endpoint…',
      connectedDisclosure: 'Connected. I am using {model} — the most balanced on this endpoint.',
      connectedPlain: 'Connected.',
      connectFail: 'Not connected yet — {error}. Check the endpoint or the key, or continue without a model.',
      skipConnect: 'Skip for now', toTemplate: 'Continue without a model',
      preparingModel: 'Preparing the model…', preparingTemplate: 'Preparing template mode…',
      intro: 'Hi, I am Damar — a personal AI assistant living on this computer. I can help you through conversation and commands, and all of my settings live in one place: the Control Dashboard. So we can get to know each other, let me ask a few short questions first. Everything can be skipped.',
      voiceGreeting: 'Hi, I am Damar. May I know your name?',
      nameQ: 'What is <b>your name?</b>',
      nameSub: 'So I can greet you properly — starting here.',
      namePlaceholder: 'Type your name here…',
      oke: 'Okay, {name}.',
      qName: 'First — what is your name?',
      qSalutation: 'What would you like me to call you?',
      subSalutation: 'Your name works, or a special nickname — just type it.',
      qLanguage: 'What is our main language?',
      subLanguage: 'Type "Bahasa Indonesia" or "English".',
      qVoice: 'Enable voice conversation?',
      subVoice: 'Type "yes" so you can talk to me directly, or "no".',
      fName: 'Name', fSalutation: 'Called as', fLanguage: 'Language', fVoice: 'Voice conversation',
      stepSkip: 'Skip', skipAllBtn: 'Skip everything',
      saving: 'Saving…', saveFail: 'Saving failed ({error}). Tap the summary to try again — your answers are still here.',
      closing: 'Nice to meet you, {address}. Initial setup is done — I am ready to help. You can change this any time in the Control Dashboard.',
      closingNoName: 'Nice to meet you. Initial setup is done — I am ready to help. You can change this any time in the Control Dashboard.',
      chatPlaceholder: 'Type your answer…', chatThinking: 'Damar is typing…',
      chatFail: 'The conversation dropped ({error}). We will continue with the short questions instead — the answers collected so far are kept.',
      formIntroLive: 'Here is the summary of our conversation — saving it now.',
      formIntroTemplate: 'Here is the summary — saving it now.',
      summaryTitle: 'Our introduction summary',
      kickoff: 'Hi Damar, you were just installed on my computer. Please introduce yourself and start our introduction.',
      templateMode: 'Template',
    },
  };
  // Pure helpers (also exercised by tests without a DOM).
  const cleanText = v => String(v ?? '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 40);
  function sanitize(values = {}) {
    return {
      displayName: cleanText(values.displayName),
      salutation: cleanText(values.salutation),
      language: ['id', 'en'].includes(values.language) ? values.language : 'id',
      voiceEnabled: values.voiceEnabled === true,
    };
  }
  function parseSetup(text) {
    const m = /DAMAR_SETUP_JSON:\s*(\{[^\n]*\})/.exec(String(text || ''));
    if (!m) return null;
    try { return sanitize(JSON.parse(m[1])); } catch { return null; }
  }
  const stripSetup = text => String(text || '').replace(/\n?DAMAR_SETUP_JSON:\s*\{[^\n]*\}/, '').trim();
  // Template-branch answer parsers (typed answers, no widgets): language + voice are free text.
  const parseLanguage = v => (/english|inggris|\ben\b/i.test(String(v || '')) ? 'en' : 'id');
  const parseVoice = v => /^(ya|iya|boleh|aktifkan|yes|true|ok|oke)\b/i.test(String(v || '').trim());

  const api = { COPY, sanitize, parseSetup, parseLanguage, parseVoice, state: () => ({ phase: 'hidden', branch: null, spoken: [], saved: null, model: null }) };
  if (typeof window !== 'undefined') window.DamarOnboarding = api;

  const desktop = typeof window !== 'undefined' ? window.damarDesktop : null;
  if (!desktop?.getPresence || typeof document === 'undefined') return;

  const DEBOUNCE_MS = 1000;      // typing pause that means "finished" (A5/A4 rule)
  const GOLD = [[0.45, 0.28, 0.05], [0.86, 0.68, 0.22], [1.00, 0.95, 0.78]];
  const RED = [[0.40, 0.05, 0.04], [0.84, 0.20, 0.16], [1.00, 0.70, 0.60]];

  let started = false, phase = 'hidden', branch = null, lang = 'id';
  const spoken = []; let savedValues = null, history = [], extracted = null;
  let connModel = null, connState = 'idle', userName = '';
  const C = () => COPY[lang];
  const speak = text => { try { if (typeof window.speakWithOrbReactivity === 'function') window.speakWithOrbReactivity(text); } catch {} };
  const announce = text => { spoken.push(text); speak(text); };
  api.state = () => ({ phase, branch, spoken: [...spoken], saved: savedValues, model: connModel, connState });

  // ---- The page's own orb, driven through its own parameters (globals of idle_present.html). Every
  // access is guarded: if a name is absent the CSS hero move still carries the choreography. ----
  const orb = {
    set(name, value) { try { ({ targetOrbScale: v => { targetOrbScale = v; }, targetEnergy: v => { targetEnergy = v; }, damarIsSpeaking: v => { damarIsSpeaking = v; }, pulseWave: v => { pulseWave = v; }, damarState: v => { damarState = v; } })[name]?.(value); } catch {} },
    palette(p) { try { targetPalDeep = p[0].slice(); targetPalMid = p[1].slice(); targetPalHigh = p[2].slice(); } catch {} },
    hero(on) {
      const w = document.getElementById('orbWrapper');
      if (w) { w.style.transition = 'transform 1.6s cubic-bezier(.22,.8,.24,1)'; w.style.transform = on ? 'translateY(-4vh) scale(1.5)' : ''; }
      this.set('targetOrbScale', on ? 1.45 : 1.0);
      this.set('targetEnergy', on ? 1.5 : 1.0);
    },
    raise(on) { const s = document.getElementById('orbSection'); if (s) { s.style.position = 'relative'; s.style.zIndex = on ? '9500' : ''; } },
    restore() { this.hero(false); this.set('damarIsSpeaking', false); this.set('damarState', 'IDLE'); this.palette(GOLD); this.raise(false); },
  };

  // ---- Gate-keeping against the page's own idle / click-through machinery (idle_present.html).
  // Two page mechanisms collide with this gate, both proven live on the Owner's machine:
  //  (1) Click-through: the page's mousemove engine calls setIgnoreMouse(true) unless the pointer is
  //      over a dashboard card (.solid-card/.main-window/.settings-popover/.toast-banner) or, outside
  //      DASHBOARD surface mode, the siri dock. #damarOnboarding matches none of those, so over these
  //      fields the window ignores the mouse entirely - clicks fall through to the desktop and the
  //      fields can never be focused, hence never typed into.
  //  (2) Idle standby: after 30 s without page-recognized input the page enters STANDBY_ORB
  //      (enterStandbyMiniOrb): animateOrb only draws in DASHBOARD surface mode, so the orb this
  //      design promises vanishes behind the gate while its shell collapses around it.
  // While the gate is open this module therefore: countermands the click-through over the overlay
  // (see build()), exits standby if it already happened - restoring the approved collapsed,
  // transparent shell afterwards, because wakeFromMiniOrb's dashboard reveal is not the onboarding
  // look - and re-arms the page idle timer so standby cannot re-enter mid-flow. No layout or visual
  // change: the orb keeps floating over the same transparent, darker-at-the-bottom surface. ----
  let gateTimer = null, gateWoke = false, gateHeldShell = false;
  function gateKeep() {
    const body = document.body;
    if (body.classList.contains('siri-dock-active') && typeof window.wakeFromMiniOrb === 'function') {
      gateWoke = true;
      try { window.wakeFromMiniOrb(); } catch {}
      // wakeFromMiniOrb flips the surface back to DASHBOARD (which is what makes the orb render
      // again) but also un-collapses the shell ~220 ms later; re-collapse to keep the transparent
      // onboarding look the Owner approved.
      setTimeout(() => { if (started && els && !els.root.hidden) body.classList.add('orb-shell-collapsed'); }, 500);
    } else if (!body.classList.contains('orb-shell-collapsed')) {
      // Hold the Owner-approved onboarding look for the whole gate: dashboard furniture away, the
      // orb floating over the transparent, darker-at-the-bottom shell (restored in gateKeepStop).
      body.classList.add('orb-shell-collapsed');
      gateHeldShell = true;
    }
    try { window.resetIdleTimer?.(); } catch {}
  }
  function gateKeepStart() {
    gateKeep();
    clearInterval(gateTimer);
    gateTimer = setInterval(() => { if (!els || els.root.hidden) { gateKeepStop(); return; } gateKeep(); }, 10000);
  }
  function gateKeepStop() {
    clearInterval(gateTimer); gateTimer = null;
    if (gateWoke || gateHeldShell) { gateWoke = false; gateHeldShell = false; document.body.classList.remove('orb-shell-collapsed'); }
  }

  const STYLE = `
    #damarOnboarding { position: fixed; inset: 0; z-index: 9000; overflow: hidden; color: #f2ead8;
      font-family: "Inter","Segoe UI", system-ui, -apple-system, sans-serif; transition: opacity .8s ease; }
    #damarOnboarding[hidden] { display: none; }
    #damarOnboarding::before { content: ''; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(ellipse 95% 64% at 50% 28%, rgba(4,4,5,0) 0%, rgba(4,4,5,.52) 56%, rgba(3,3,4,.93) 100%); }
    .dob2-view { position: absolute; left: 0; right: 0; top: 55%; transform: translateY(-4%); z-index: 1;
      display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 24px;
      transition: opacity .6s ease; }
    .dob2-view.off { opacity: 0; pointer-events: none; }
    .dob2-spoken { font-size: clamp(14px, 1.35vw, 19px); font-weight: 300; font-style: italic; letter-spacing: .02em;
      color: rgba(255,217,138,.82); max-width: 760px; margin-bottom: 26px; }
    .dob2-q { font-size: clamp(30px, 4vw, 52px); font-weight: 200; letter-spacing: .005em; color: #f7f1e3; }
    .dob2-q b { font-weight: 500; color: #ffd98a; }
    .dob2-sub { margin-top: 14px; font-size: clamp(14px, 1.3vw, 18px); font-weight: 300; color: rgba(240,232,214,.55); max-width: 640px; }
    .dob2-fields { margin-top: 30px; display: flex; flex-direction: column; gap: 22px; align-items: center; }
    .dob2-field { width: min(560px, 86vw); }
    .dob2-field input { width: 100%; background: transparent; border: none; outline: none; font-family: inherit;
      font-size: clamp(20px, 2vw, 27px); font-weight: 300; color: #fff3da; text-align: center;
      padding: 8px 8px 14px; caret-color: #ffbe55; }
    .dob2-field input::placeholder { color: rgba(240,232,214,.30); }
    .dob2-field .dob2-line { height: 1px; width: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,196,86,.75) 22%, rgba(255,214,130,.95) 50%, rgba(255,196,86,.75) 78%, transparent);
      box-shadow: 0 6px 24px rgba(255,176,66,.25); }
    .dob2-mode { font-size: 11px; letter-spacing: .5em; text-transform: uppercase; color: rgba(240,232,214,.34); margin-bottom: 18px; }
    .dob2-oke { margin-top: 24px; font-size: 18px; font-weight: 300; letter-spacing: .04em; min-height: 24px;
      color: rgba(255,217,138,.85); opacity: 0; transform: translateY(4px); transition: opacity .5s ease, transform .5s ease; }
    .dob2-oke.show { opacity: 1; transform: translateY(0); }
    .dob2-status { position: absolute; top: 86%; left: 0; right: 0; z-index: 2; text-align: center;
      font-size: clamp(14px, 1.3vw, 18px); font-weight: 300; letter-spacing: .04em; min-height: 24px;
      color: rgba(255,217,138,.85); opacity: 0; transform: translateY(4px); transition: opacity .5s ease, transform .5s ease; }
    .dob2-status.show { opacity: 1; transform: translateY(0); }
    .dob2-status.err { color: rgba(250,178,178,.9); }
    .dob2-link { position: absolute; bottom: 5.5%; left: 0; right: 0; z-index: 2; text-align: center;
      font-size: 14px; font-weight: 300; letter-spacing: .06em; color: rgba(240,232,214,.38); cursor: pointer;
      transition: opacity .5s ease, color .3s ease; }
    .dob2-link:hover { color: rgba(255,217,138,.75); }
    .dob2-link.off { opacity: 0; pointer-events: none; }
    .dob2-steplink { margin-top: 18px; font-size: 13.5px; font-weight: 300; letter-spacing: .05em;
      color: rgba(240,232,214,.38); cursor: pointer; }
    .dob2-steplink:hover { color: rgba(255,217,138,.75); }
    .dob2-log { width: min(640px, 90vw); max-height: 30vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
    .dob2-msg { max-width: 88%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; text-align: left;
      font-size: 15px; font-weight: 300; line-height: 1.5; }
    .dob2-msg.damar { background: rgba(255,255,255,.08); align-self: flex-start; }
    .dob2-msg.user { background: rgba(255,196,86,.18); align-self: flex-end; }
    .dob2-sum { margin-top: 8px; display: flex; flex-direction: column; gap: 10px; align-items: center; cursor: pointer; }
    .dob2-sumrow { font-size: clamp(17px, 1.7vw, 22px); font-weight: 300; color: #f7f1e3; }
    .dob2-sumrow span { color: rgba(240,232,214,.45); font-size: .72em; letter-spacing: .14em; text-transform: uppercase; margin-right: 12px; }`;

  let els = null;
  const field = (id, type, placeholder) => `<div class="dob2-field"><input type="${type}" id="${id}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"><div class="dob2-line"></div></div>`;

  function build() {
    const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
    const root = document.createElement('section'); root.id = 'damarOnboarding'; root.hidden = true;
    root.innerHTML = `
      <div class="dob2-view" data-view="connect">
        <div class="dob2-spoken" id="dobConnectSpoken"></div>
        <div class="dob2-q" id="dobConnectQ"></div>
        <div class="dob2-sub" id="dobConnectSub"></div>
        <div class="dob2-fields">
          ${field('dobBaseUrl', 'text', '')}
          ${field('dobApiKey', 'password', '')}
        </div>
      </div>
      <div class="dob2-view off" data-view="name">
        <div class="dob2-mode" id="dobNameMode" hidden></div>
        <div class="dob2-spoken" id="dobNameSpoken"></div>
        <div class="dob2-q" id="dobNameQ"></div>
        <div class="dob2-sub" id="dobNameSub"></div>
        <div class="dob2-fields">${field('dobNameInput', 'text', '')}</div>
        <div class="dob2-oke" id="dobOke"></div>
      </div>
      <div class="dob2-view off" data-view="chat">
        <div class="dob2-log" id="dobLog"></div>
        <div class="dob2-fields">${field('dobChatInput', 'text', '')}</div>
      </div>
      <div class="dob2-view off" data-view="step">
        <div class="dob2-q" id="dobStepQ"></div>
        <div class="dob2-sub" id="dobStepSub"></div>
        <div class="dob2-fields">${field('dobStepInput', 'text', '')}</div>
        <div class="dob2-steplink" id="dobStepSkip"></div>
      </div>
      <div class="dob2-view off" data-view="summary">
        <div class="dob2-q" id="dobSummaryTitle" style="font-size:clamp(24px,3vw,38px)"></div>
        <div class="dob2-sum" id="dobSummary"></div>
        <div class="dob2-sub" id="dobSummaryNote"></div>
      </div>
      <div class="dob2-view off" data-view="done">
        <div class="dob2-q" id="dobDoneText" style="font-size:clamp(22px,2.6vw,34px);max-width:820px"></div>
      </div>
      <div class="dob2-status" id="dobStatus"></div>
      <div class="dob2-link" id="dobBottomLink"></div>`;
    document.body.appendChild(root);
    els = {
      root, status: document.getElementById('dobStatus'), bottomLink: document.getElementById('dobBottomLink'),
      views: Object.fromEntries([...root.querySelectorAll('.dob2-view')].map(v => [v.dataset.view, v])),
      baseUrl: document.getElementById('dobBaseUrl'), apiKey: document.getElementById('dobApiKey'),
      nameInput: document.getElementById('dobNameInput'), oke: document.getElementById('dobOke'),
      log: document.getElementById('dobLog'), chatInput: document.getElementById('dobChatInput'),
      stepInput: document.getElementById('dobStepInput'), stepSkip: document.getElementById('dobStepSkip'),
      summary: document.getElementById('dobSummary'),
    };
    document.getElementById('dobConnectSpoken').textContent = C().step0Intro;
    document.getElementById('dobConnectQ').innerHTML = C().connectQ;
    document.getElementById('dobConnectSub').textContent = C().connectSub;
    els.baseUrl.placeholder = C().endpointPlaceholder; els.apiKey.placeholder = C().apiKeyPlaceholder;
    document.getElementById('dobNameQ').innerHTML = C().nameQ;
    document.getElementById('dobNameSub').textContent = C().nameSub;
    els.nameInput.placeholder = C().namePlaceholder;
    els.chatInput.placeholder = C().chatPlaceholder;
    els.stepSkip.textContent = C().stepSkip;
    document.getElementById('dobSummaryTitle').textContent = C().summaryTitle;
    els.bottomLink.textContent = C().skipConnect;
    wireConnect(); wireName(); wireChat(); wireSteps();
    // Click-through countermand (see the gate-keeping note above): while this gate is visible the
    // window must stay mouse-live over the overlay, or the fields can never be clicked into focus.
    // Registered after the page's own mousemove listener, so it has the last word on each event.
    window.addEventListener('mousemove', () => {
      if (els && !els.root.hidden) { try { desktop.setIgnoreMouse(false); } catch {} }
    });
    els.summary.addEventListener('click', () => { if (phase === 'summary') save(pendingSummary); });
    els.bottomLink.addEventListener('click', onBottomLink);
  }

  function show(view) {
    phase = view;
    for (const [k, v] of Object.entries(els.views)) v.classList.toggle('off', k !== view);
    els.root.hidden = false;
  }
  function setStatus(text, isErr = false) {
    els.status.textContent = text || '';
    els.status.classList.toggle('show', !!text);
    els.status.classList.toggle('err', !!isErr);
  }
  function setBottomLink(text, visible) {
    els.bottomLink.textContent = text || '';
    els.bottomLink.classList.toggle('off', !visible);
  }
  // A finished answer = non-empty content + a 1000 ms typing pause; a paste/drop finishes instantly.
  // Empty or whitespace never finishes. onDone receives the trimmed value.
  function recognizer(input, onDone) {
    let timer = null, done = false;
    const fire = () => { const v = input.value.trim(); if (done || !v) return; done = true; onDone(v); };
    input.addEventListener('input', ev => {
      if (done) return;
      clearTimeout(timer);
      if (!input.value.trim()) return;
      if (ev && (ev.inputType === 'insertFromPaste' || ev.inputType === 'insertFromDrop')) fire();
      else timer = setTimeout(fire, DEBOUNCE_MS);
    });
    return { reset() { done = false; clearTimeout(timer); }, cancel() { clearTimeout(timer); } };
  }

  // ---- Step 0: connect (auto-attempt when both fields settle) ----
  const settled = { endpoint: false, key: false };
  let recEndpoint = null, recKey = null;
  function wireConnect() {
    const mk = which => {
      let timer = null;
      return ev => {
        if (connState === 'connecting' || connState === 'connected' || connState === 'hero') return;
        if (connState === 'failed') clearFailure();
        connState = 'editing'; settled[which] = false;
        clearTimeout(timer);
        const input = which === 'endpoint' ? els.baseUrl : els.apiKey;
        if (!input.value.trim()) return;
        if (ev && (ev.inputType === 'insertFromPaste' || ev.inputType === 'insertFromDrop')) { settled[which] = true; maybeConnect(); }
        else timer = setTimeout(() => { settled[which] = true; maybeConnect(); }, DEBOUNCE_MS);
      };
    };
    els.baseUrl.addEventListener('input', mk('endpoint'));
    els.apiKey.addEventListener('input', mk('key'));
  }
  function maybeConnect() {
    if (connState === 'connecting' || connState === 'connected' || connState === 'hero') return;
    if (els.baseUrl.value.trim() && els.apiKey.value.trim() && settled.endpoint && settled.key) startConnect();
  }
  async function startConnect() {
    connState = 'connecting'; phase = 'connect';
    setStatus(C().connecting);
    orb.set('damarIsSpeaking', true); orb.set('pulseWave', 0.75);
    els.baseUrl.readOnly = true; els.apiKey.readOnly = true;
    els.baseUrl.blur(); els.apiKey.blur();
    setBottomLink('', false);
    const baseUrl = els.baseUrl.value.trim(), apiKey = els.apiKey.value;
    let r;
    try { r = await desktop.connectProvider({ baseUrl, apiKey }); } catch (e) { r = { ok: false, error: e?.message || 'CONNECT_FAILED' }; }
    els.apiKey.value = '';
    if (!r?.ok) {
      connState = 'failed';
      setStatus(C().connectFail.replace('{error}', String(r?.error || 'CONNECT_FAILED')), true);
      orb.set('damarIsSpeaking', false); orb.set('damarState', 'ERROR'); orb.palette(RED);
      els.baseUrl.readOnly = false; els.apiKey.readOnly = false;
      settled.endpoint = settled.key = false;
      setBottomLink(C().toTemplate, true);
      return;
    }
    connState = 'connected'; branch = 'live'; connModel = r.model || null;
    setBottomLink('', false);
    setStatus(r.probeUnavailable ? C().connectedPlain : C().connectedDisclosure.replace('{model}', String(r.model || '')));
    orb.set('damarIsSpeaking', false); orb.set('pulseWave', 0.75);
    setTimeout(() => beginTransition('live'), 1500);
  }
  function clearFailure() {
    connState = 'editing';
    orb.set('damarState', 'IDLE'); orb.palette(GOLD);
    setStatus('');
    setBottomLink(C().skipConnect, true);
  }
  function onBottomLink() {
    if (phase === 'connect' && (connState === 'idle' || connState === 'editing')) beginTransition('template');
    else if (phase === 'connect' && connState === 'failed') beginTransition('template');
    else if (phase === 'chat' || phase === 'step') save(sanitize({ language: 'id', displayName: userName }));
  }

  // ---- The bridge choreography: fields fade, the orb becomes the hero, then the next step fades in.
  // (In the product the model probing itself already ran inside the connect call; the hero hold is the
  // cinematic beat the owner choreographed, with the soft status line as its only narration.) ----
  function beginTransition(dest) {
    if (connState === 'hero') return;
    connState = 'hero'; phase = 'hero';
    if (dest === 'template') branch = 'template';
    els.views.connect.classList.add('off');
    setBottomLink('', false);
    orb.hero(true);
    orb.set('damarIsSpeaking', false);
    setStatus(dest === 'live' ? C().preparingModel : C().preparingTemplate);
    setTimeout(() => landTransition(dest), 2600);
  }
  function landTransition(dest) {
    orb.hero(false);
    orb.set('damarState', 'IDLE'); orb.palette(GOLD);
    setStatus('');
    show('name');
    const mode = document.getElementById('dobNameMode');
    mode.hidden = dest !== 'template';
    mode.textContent = dest === 'template' ? C().templateMode : '';
    document.getElementById('dobNameSpoken').textContent = dest === 'live' ? C().voiceGreeting : C().intro;
    if (dest === 'live') announce(C().voiceGreeting); else announce(C().intro);
    orb.set('pulseWave', 0.75);
    els.nameInput.focus();
  }

  // ---- The name step (both branches): recognized from the typing pause ----
  function wireName() {
    recognizer(els.nameInput, name => {
      userName = cleanText(name);
      els.oke.textContent = C().oke.replace('{name}', userName);
      els.oke.classList.add('show');
      orb.set('damarIsSpeaking', true); orb.set('pulseWave', 0.75);
      announce(C().oke.replace('{name}', userName));
      els.nameInput.readOnly = true; els.nameInput.blur();
      setTimeout(() => { orb.set('damarIsSpeaking', false); if (branch === 'live') startInterview(); else startSteps(); }, 1600);
    });
  }

  // ---- Branch A: the live interview (chat view, answers auto-send on the pause) ----
  function addMsg(role, text) {
    const d = document.createElement('div');
    d.className = 'dob2-msg ' + (role === 'assistant' ? 'damar' : 'user');
    d.textContent = text; els.log.appendChild(d); els.log.scrollTop = els.log.scrollHeight;
  }
  function startInterview() {
    show('chat');
    setBottomLink(C().skipAllBtn, true);
    addMsg('assistant', C().voiceGreeting);
    history = [
      { role: 'user', content: C().kickoff },
      { role: 'assistant', content: C().intro + ' ' + C().voiceGreeting },
      { role: 'user', content: userName },
    ];
    chatTurn();
  }
  async function chatTurn() {
    setStatus(C().chatThinking);
    els.chatInput.readOnly = true;
    let r;
    try { r = await desktop.onboardingChat(history); } catch (e) { r = { ok: false, error: e?.message || 'CHAT_FAILED' }; }
    els.chatInput.readOnly = false;
    setStatus('');
    if (!r?.ok || !r.data?.text) {
      // The live conversation dropped: keep what was collected and continue with the template questions.
      setStatus(C().chatFail.replace('{error}', String(r?.error || 'CHAT_FAILED')), true);
      branch = 'template';
      setTimeout(() => { setStatus(''); startSteps(); }, 2200);
      return;
    }
    const raw = String(r.data.text);
    history.push({ role: 'assistant', content: raw });
    const found = parseSetup(raw);
    const visible = stripSetup(raw);
    if (visible) { addMsg('assistant', visible); announce(visible); }
    if (found) { extracted = found; if (!extracted.displayName) extracted.displayName = userName; showSummary(); }
    else els.chatInput.focus();
  }
  function wireChat() {
    const rec = recognizer(els.chatInput, text => {
      addMsg('user', text);
      history.push({ role: 'user', content: text.slice(0, 2000) });
      els.chatInput.value = ''; rec.reset();
      chatTurn();
    });
    els.chatInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const text = els.chatInput.value.trim(); if (!text) return;
      rec.cancel(); addMsg('user', text); history.push({ role: 'user', content: text.slice(0, 2000) });
      els.chatInput.value = ''; rec.reset(); chatTurn();
    });
  }

  // ---- Branch B: the template questions, one at a time (zero model calls) ----
  const STEPS = [
    { key: 'salutation', q: 'qSalutation', sub: 'subSalutation', parse: v => cleanText(v) },
    { key: 'language', q: 'qLanguage', sub: 'subLanguage', parse: v => parseLanguage(v) },
    { key: 'voiceEnabled', q: 'qVoice', sub: 'subVoice', parse: v => parseVoice(v) },
  ];
  let stepIdx = -1; const answers = { displayName: '', salutation: '', language: 'id', voiceEnabled: false };
  let recStep = null;
  function startSteps() {
    answers.displayName = userName;
    show('step');
    setBottomLink(C().skipAllBtn, true);
    nextStep(0);
  }
  function nextStep(i) {
    stepIdx = i;
    if (i >= STEPS.length) { extracted = sanitize(answers); showSummary(); return; }
    const s = STEPS[i];
    document.getElementById('dobStepQ').textContent = C()[s.q];
    document.getElementById('dobStepSub').textContent = C()[s.sub];
    els.stepInput.value = '';
    if (recStep) recStep.reset();
    announce(C()[s.q]);
    els.stepInput.focus();
  }
  function wireSteps() {
    recStep = recognizer(els.stepInput, text => {
      const s = STEPS[stepIdx]; if (!s) return;
      answers[s.key] = s.parse(text);
      nextStep(stepIdx + 1);
    });
    els.stepSkip.addEventListener('click', () => { if (phase === 'step' && stepIdx >= 0) { recStep.reset(); nextStep(stepIdx + 1); } });
  }

  // ---- Summary (read-only) + save ----
  let pendingSummary = null, saveTimer = null;
  function showSummary() {
    const v = extracted || sanitize({ language: 'id', displayName: userName });
    pendingSummary = v;
    const langName = v.language === 'en' ? 'English' : 'Bahasa Indonesia';
    const rows = [
      [C().fName, v.displayName || '—'], [C().fSalutation, v.salutation || '—'],
      [C().fLanguage, langName], [C().fVoice, v.voiceEnabled ? '✓' : '—'],
    ];
    els.summary.innerHTML = rows.map(([k, val]) => `<div class="dob2-sumrow"><span>${k}</span>${val.replace(/</g, '')}</div>`).join('');
    document.getElementById('dobSummaryNote').textContent = branch === 'live' ? C().formIntroLive : C().formIntroTemplate;
    show('summary');
    setBottomLink('', false);
    announce(branch === 'live' ? C().formIntroLive : C().formIntroTemplate);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(v), 2800);
  }
  async function save(values) {
    if (!values) return;
    clearTimeout(saveTimer);
    phase = 'saving'; setStatus(C().saving);
    let r;
    try { r = await desktop.saveOnboarding(values); } catch (e) { r = { ok: false, error: e?.message || 'SAVE_FAILED' }; }
    if (!r?.ok) {
      phase = 'summary';
      setStatus(C().saveFail.replace('{error}', String(r?.error || 'SAVE_FAILED')), true);
      return;
    }
    savedValues = values;
    setStatus('');
    const address = values.salutation || values.displayName;
    const closing = address ? C().closing.replace('{address}', address) : C().closingNoName;
    show('done');
    document.getElementById('dobDoneText').textContent = closing;
    announce(closing);
    setTimeout(() => {
      els.root.style.opacity = '0';
      setTimeout(() => { els.root.hidden = true; els.root.style.opacity = ''; orb.restore(); gateKeepStop(); phase = 'done'; }, 850);
    }, 9000);
    phase = 'done';
  }

  // ---- Gate: fire once, only against a Core that can persist (source 'core'), only while uncompleted. ----
  function consider(config) {
    if (!config) return;
    // Completed elsewhere (e.g. another surface finished it): close at once. Completed by THIS panel's
    // save: the closing line stays readable - save() already scheduled the hide.
    if (config.source === 'core' && config.onboardingCompleted === true && started) { if (phase !== 'done') { els.root.hidden = true; orb.restore(); gateKeepStop(); phase = 'done'; } return; }
    if (started || config.source !== 'core' || config.onboardingCompleted !== false) return;
    started = true;
    // First-run onboarding speaks Bahasa Indonesia, matching Damar's voice and product language:
    // never inherit the page i18n default here (presence-i18n.js starts at 'en'), or the gate
    // greets in English while Damar speaks Indonesian.
    lang = 'id';
    // The page swallows ALL clicks/keydowns until its boot cinematic reaches DASHBOARD (the
    // capture-phase guard in idle_present.html), so a gate opened during the cinematic would show
    // fields that ignore the first seconds of typing. Wait for the cinematic to finish first -
    // the page mirrors its stage on body[data-startup-state]. Bounded: open anyway after ~20 s.
    if (document.body.dataset.startupState !== 'DASHBOARD') {
      let waits = 0;
      const wait = setInterval(() => {
        waits += 1;
        if (document.body.dataset.startupState === 'DASHBOARD' || waits > 80) { clearInterval(wait); openGate(); }
      }, 250);
      return;
    }
    openGate();
  }
  function openGate() {
    build();
    orb.raise(true);
    show('connect');
    setBottomLink(C().skipConnect, true);
    gateKeepStart();
    try { els.baseUrl.focus(); } catch {}
    announce(C().step0Intro);
  }
  desktop.onPresence(msg => consider(msg?.config));
  desktop.getPresence().then(msg => consider(msg?.config)).catch(() => {});
})();
