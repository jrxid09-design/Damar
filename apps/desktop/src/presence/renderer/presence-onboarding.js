'use strict';
// DAMAR Presence first-run onboarding (injected after presence-adapter.js). Runs exactly once: only while
// Core's centralized config reports presence.onboardingCompleted === false (the flag lives in Core, set by
// POST /api/r9/presence/onboarding - this script can never set it directly).
//
//   Step 0  Connect a provider (endpoint + API key) via the existing Core connect machinery, or skip.
//   Branch A (connected): a live interview - Damar, now model-powered, introduces itself and asks the
//     setup questions through Core's onboarding chat route; its DAMAR_SETUP_JSON line prefills the form.
//   Branch B (skipped / failed): the template - a fixed script (spoken via the page's speak path and shown
//     as text) stepping through a structured form. Zero model calls.
// Both branches end at the same confirmation form; only confirmed values are saved to Core config.
(() => {
  const COPY = {
    id: {
      title: 'Perkenalan Damar',
      step0Intro: 'Halo, aku Damar — asisten AI pribadi di komputer ini. Sebelum mulai, kamu bisa menghubungkan layanan model AI (endpoint + API key) supaya aku bisa bercakap-cakap langsung denganmu. Kalau dilewati, kita tetap lanjut dengan perkenalan singkat tanpa model.',
      endpointLabel: 'Endpoint (base URL)', endpointPlaceholder: 'https://api.openai.com/v1', apiKeyLabel: 'API key',
      connectBtn: 'Hubungkan & tes', connecting: 'Menghubungkan dan mengetes…',
      connectOk: 'Terhubung. Kita lanjut ke perkenalan langsung, ya.',
      connectFail: 'Koneksi gagal ({error}). Kamu bisa coba lagi, atau lanjut tanpa model.',
      skipConnect: 'Lewati — lanjut tanpa model', toTemplate: 'Lanjut tanpa model',
      intro: 'Halo, aku Damar — asisten AI pribadi yang tinggal di komputer ini. Aku bisa membantumu lewat percakapan dan perintah, dan semua pengaturanku tersimpan di satu tempat: Control Dashboard. Supaya kita saling kenal, aku tanya beberapa hal singkat dulu, ya. Semua boleh dilewati.',
      startBtn: 'Mulai',
      qName: 'Pertama — siapa namamu?',
      qSalutation: 'Kamu ingin kupanggil apa? (sapaan)',
      qLanguage: 'Bahasa utama kita: Bahasa Indonesia atau English? Bahasa Indonesia adalah pilihan awalnya.',
      qVoice: 'Terakhir — aktifkan percakapan suara (mikrofon) supaya kamu bisa bicara langsung denganku?',
      fName: 'Nama', fSalutation: 'Sapaan', fLanguage: 'Bahasa', fVoice: 'Percakapan suara (mikrofon)',
      nextBtn: 'Lanjut', saveBtn: 'Simpan & selesai', skipAllBtn: 'Lewati semua',
      saving: 'Menyimpan…', saveFail: 'Gagal menyimpan ({error}). Coba lagi — jawabanmu tidak hilang.',
      closing: 'Senang berkenalan, {address}. Pengaturan awal selesai — aku siap membantu. Kamu bisa mengubahnya kapan pun di Control Dashboard.',
      closingNoName: 'Senang berkenalan. Pengaturan awal selesai — aku siap membantu. Kamu bisa mengubahnya kapan pun di Control Dashboard.',
      chatPlaceholder: 'Tulis jawabanmu…', chatSend: 'Kirim', chatThinking: 'Damar sedang mengetik…',
      chatFail: 'Percakapan terputus ({error}). Kamu bisa lanjut dengan formulir — jawaban yang sudah terkumpul tetap dipakai.',
      toFormBtn: 'Lanjut ke formulir',
      formIntroLive: 'Ini ringkasan dari percakapan kita. Periksa sebentar — ubah kalau ada yang kurang pas — lalu simpan.',
      formIntroTemplate: 'Isi sebentar, ya — semua kolom boleh dikosongkan.',
      kickoff: 'Halo Damar, kamu baru terpasang di komputerku. Perkenalkan dirimu dan mulai perkenalan kita.',
    },
    en: {
      title: 'Meet Damar',
      step0Intro: 'Hi, I am Damar — a personal AI assistant on this computer. Before we start, you can connect an AI model service (endpoint + API key) so I can talk with you directly. If you skip it, we will simply continue with a short introduction without a model.',
      endpointLabel: 'Endpoint (base URL)', endpointPlaceholder: 'https://api.openai.com/v1', apiKeyLabel: 'API key',
      connectBtn: 'Connect & test', connecting: 'Connecting and testing…',
      connectOk: 'Connected. Let us continue with a live introduction.',
      connectFail: 'Connection failed ({error}). You can try again, or continue without a model.',
      skipConnect: 'Skip — continue without a model', toTemplate: 'Continue without a model',
      intro: 'Hi, I am Damar — a personal AI assistant living on this computer. I can help you through conversation and commands, and all of my settings live in one place: the Control Dashboard. So we can get to know each other, let me ask a few short questions first. Everything can be skipped.',
      startBtn: 'Start',
      qName: 'First — what is your name?',
      qSalutation: 'What would you like me to call you?',
      qLanguage: 'Our main language: Bahasa Indonesia or English? Bahasa Indonesia is the starting choice.',
      qVoice: 'Last one — enable voice conversation (microphone) so you can talk to me directly?',
      fName: 'Name', fSalutation: 'Called as', fLanguage: 'Language', fVoice: 'Voice conversation (microphone)',
      nextBtn: 'Next', saveBtn: 'Save & finish', skipAllBtn: 'Skip everything',
      saving: 'Saving…', saveFail: 'Saving failed ({error}). Please try again — your answers are still here.',
      closing: 'Nice to meet you, {address}. Initial setup is done — I am ready to help. You can change this any time in the Control Dashboard.',
      closingNoName: 'Nice to meet you. Initial setup is done — I am ready to help. You can change this any time in the Control Dashboard.',
      chatPlaceholder: 'Type your answer…', chatSend: 'Send', chatThinking: 'Damar is typing…',
      chatFail: 'The conversation dropped ({error}). You can continue with the form — the answers collected so far are kept.',
      toFormBtn: 'Continue to the form',
      formIntroLive: 'Here is the summary of our conversation. Take a quick look — edit anything that is off — then save.',
      formIntroTemplate: 'A few quick fields — every one of them can be left empty.',
      kickoff: 'Hi Damar, you were just installed on my computer. Please introduce yourself and start our introduction.',
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

  const api = { COPY, sanitize, parseSetup, state: () => ({ phase: 'hidden', branch: null, spoken: [], saved: null }) };
  if (typeof window !== 'undefined') window.DamarOnboarding = api;

  const desktop = typeof window !== 'undefined' ? window.damarDesktop : null;
  if (!desktop?.getPresence || typeof document === 'undefined') return;

  let started = false, phase = 'hidden', branch = null, lang = 'id';
  const spoken = []; let savedValues = null, history = [], extracted = null, stepIndex = -1, formMode = 'template';
  const C = () => COPY[lang];
  const say = text => { spoken.push(text); const el = document.getElementById('dobSay'); if (el) el.textContent = text; };
  const speak = text => { try { if (typeof window.speakWithOrbReactivity === 'function') window.speakWithOrbReactivity(text); } catch {} };
  const announce = text => { say(text); speak(text); };
  // Chat replies live in the chat log (bubble + spoken); the say-line keeps the phase's own line.
  const speakOnly = text => { spoken.push(text); speak(text); };
  api.state = () => ({ phase, branch, spoken: [...spoken], saved: savedValues });

  const STYLE = `
    #damarOnboarding { position: fixed; left: 50%; bottom: 118px; transform: translateX(-50%); width: min(580px, 94vw); z-index: 9000; }
    #damarOnboarding[hidden] { display: none; }
    .dob-card { background: rgba(15,16,20,.94); border: 1px solid rgba(255,255,255,.16); border-radius: 18px; padding: 18px 20px; color: #f2f3f5;
      font: 400 14px/1.5 system-ui, 'Segoe UI', sans-serif; box-shadow: 0 18px 50px rgba(0,0,0,.5); backdrop-filter: blur(10px); }
    .dob-title { font: 600 15px 'Cinzel', serif; letter-spacing: .04em; margin-bottom: 6px; }
    .dob-say { margin: 0 0 12px; color: #e8e9ec; }
    .dob-view[hidden] { display: none; }
    .dob-field { display: block; margin: 0 0 10px; padding: 8px 10px; border: 1px solid transparent; border-radius: 12px; }
    .dob-field.dob-current { border-color: rgba(255,196,86,.75); background: rgba(255,196,86,.07); }
    .dob-field span { display: block; font-size: 12px; color: #b9bcc4; margin-bottom: 4px; }
    .dob-field input[type="text"], .dob-field select, .dob-connect input { width: 100%; box-sizing: border-box; background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.18); border-radius: 10px; color: #f2f3f5; padding: 8px 10px; font: inherit; }
    .dob-connect label { display: block; margin-bottom: 10px; font-size: 12px; color: #b9bcc4; }
    .dob-connect input { margin-top: 4px; }
    .dob-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
    .dob-primary { background: #f5f6f8; color: #141518; border: 0; border-radius: 999px; padding: 8px 16px; font: 600 13px system-ui, sans-serif; cursor: pointer; }
    .dob-ghost { background: rgba(255,255,255,.09); color: #f2f3f5; border: 0; border-radius: 999px; padding: 8px 14px; font: 500 13px system-ui, sans-serif; cursor: pointer; }
    .dob-primary[disabled], .dob-ghost[disabled] { opacity: .5; cursor: default; }
    .dob-status { min-height: 18px; margin: 8px 0 0; font-size: 12.5px; color: #ffc456; }
    .dob-status.dob-err { color: #ff9a8a; }
    .dob-log { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
    .dob-msg { max-width: 88%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; }
    .dob-msg.dob-damar { background: rgba(255,255,255,.08); align-self: flex-start; }
    .dob-msg.dob-user { background: rgba(255,196,86,.18); align-self: flex-end; }
    .dob-check { display: flex; gap: 8px; align-items: center; }
    .dob-check input { width: 18px; height: 18px; }`;

  const FIELDS = [
    { key: 'displayName', q: 'qName', label: 'fName', kind: 'text' },
    { key: 'salutation', q: 'qSalutation', label: 'fSalutation', kind: 'text' },
    { key: 'language', q: 'qLanguage', label: 'fLanguage', kind: 'language' },
    { key: 'voiceEnabled', q: 'qVoice', label: 'fVoice', kind: 'check' },
  ];
  let els = null;

  function build() {
    const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
    const root = document.createElement('section'); root.id = 'damarOnboarding'; root.hidden = true;
    root.innerHTML = `
      <div class="dob-card">
        <div class="dob-title"></div>
        <p class="dob-say" id="dobSay"></p>
        <div class="dob-view" data-view="connect">
          <div class="dob-connect">
            <label><span class="dob-endpoint-label"></span><input type="text" id="dobBaseUrl" autocomplete="off" spellcheck="false"></label>
            <label><span class="dob-key-label"></span><input type="password" id="dobApiKey" autocomplete="off"></label>
          </div>
          <div class="dob-row">
            <button type="button" class="dob-primary" id="dobConnectBtn"></button>
            <button type="button" class="dob-ghost" id="dobSkipConnect"></button>
            <button type="button" class="dob-ghost" id="dobToTemplate" hidden></button>
          </div>
          <p class="dob-status" id="dobConnectStatus"></p>
        </div>
        <div class="dob-view" data-view="intro" hidden>
          <div class="dob-row"><button type="button" class="dob-primary" id="dobStartBtn"></button></div>
        </div>
        <div class="dob-view" data-view="chat" hidden>
          <div class="dob-log" id="dobLog"></div>
          <div class="dob-row">
            <input type="text" id="dobChatInput" style="flex:1">
            <button type="button" class="dob-primary" id="dobChatSend"></button>
            <button type="button" class="dob-ghost" id="dobToForm"></button>
          </div>
          <p class="dob-status" id="dobChatStatus"></p>
        </div>
        <div class="dob-view" data-view="form" hidden>
          <div id="dobFields"></div>
          <div class="dob-row">
            <button type="button" class="dob-primary" id="dobNextBtn"></button>
            <button type="button" class="dob-primary" id="dobSaveBtn" hidden></button>
            <button type="button" class="dob-ghost" id="dobSkipAll"></button>
          </div>
          <p class="dob-status" id="dobFormStatus"></p>
        </div>
        <div class="dob-view" data-view="done" hidden><p class="dob-say" id="dobDoneText" style="margin:0"></p></div>
      </div>`;
    document.body.appendChild(root);
    const fields = document.getElementById('dobFields');
    for (const f of FIELDS) {
      const wrap = document.createElement('label'); wrap.className = 'dob-field'; wrap.dataset.key = f.key;
      if (f.kind === 'text') wrap.innerHTML = `<span></span><input type="text" maxlength="40" autocomplete="off">`;
      else if (f.kind === 'language') wrap.innerHTML = `<span></span><select><option value="id">Bahasa Indonesia</option><option value="en">English</option></select>`;
      else wrap.innerHTML = `<span class="dob-check"><input type="checkbox"><em style="font-style:normal"></em></span>`;
      wrap.addEventListener('focusin', () => { if (formMode === 'template' && phase === 'form') setStep(FIELDS.indexOf(f), false); });
      fields.appendChild(wrap);
    }
    els = {
      root, views: Object.fromEntries([...root.querySelectorAll('.dob-view')].map(v => [v.dataset.view, v])),
      baseUrl: document.getElementById('dobBaseUrl'), apiKey: document.getElementById('dobApiKey'),
      connectStatus: document.getElementById('dobConnectStatus'), chatStatus: document.getElementById('dobChatStatus'), formStatus: document.getElementById('dobFormStatus'),
      log: document.getElementById('dobLog'), chatInput: document.getElementById('dobChatInput'),
      fieldWraps: [...fields.children],
    };
    root.querySelector('.dob-title').textContent = C().title;
    root.querySelector('.dob-endpoint-label').textContent = C().endpointLabel;
    els.baseUrl.placeholder = C().endpointPlaceholder;
    root.querySelector('.dob-key-label').textContent = C().apiKeyLabel;
    document.getElementById('dobConnectBtn').textContent = C().connectBtn;
    document.getElementById('dobSkipConnect').textContent = C().skipConnect;
    document.getElementById('dobToTemplate').textContent = C().toTemplate;
    document.getElementById('dobStartBtn').textContent = C().startBtn;
    document.getElementById('dobChatSend').textContent = C().chatSend;
    els.chatInput.placeholder = C().chatPlaceholder;
    document.getElementById('dobToForm').textContent = C().toFormBtn;
    document.getElementById('dobSaveBtn').textContent = C().saveBtn;
    document.getElementById('dobSkipAll').textContent = C().skipAllBtn;
    els.fieldWraps.forEach((w, i) => { const f = FIELDS[i]; const span = w.querySelector('span'); if (f.kind === 'check') w.querySelector('em').textContent = C()[f.label]; else span.textContent = C()[f.label]; });
    document.getElementById('dobConnectBtn').addEventListener('click', onConnect);
    document.getElementById('dobSkipConnect').addEventListener('click', () => startTemplate());
    document.getElementById('dobToTemplate').addEventListener('click', () => startTemplate());
    document.getElementById('dobStartBtn').addEventListener('click', () => showForm('template'));
    document.getElementById('dobChatSend').addEventListener('click', onChatSend);
    els.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') onChatSend(); });
    document.getElementById('dobToForm').addEventListener('click', () => showForm('live'));
    document.getElementById('dobNextBtn').addEventListener('click', onNext);
    document.getElementById('dobSaveBtn').addEventListener('click', () => save(readForm()));
    document.getElementById('dobSkipAll').addEventListener('click', () => save(sanitize({ language: 'id' })));
  }

  function show(view) {
    phase = view;
    for (const [k, v] of Object.entries(els.views)) v.hidden = k !== view;
    els.root.hidden = false;
  }
  function setBusy(busy) {
    for (const id of ['dobConnectBtn', 'dobSkipConnect', 'dobChatSend', 'dobNextBtn', 'dobSaveBtn', 'dobSkipAll']) { const b = document.getElementById(id); if (b) b.disabled = busy; }
  }

  // ---- Step 0 + branch A (live interview) ----
  async function onConnect() {
    const baseUrl = els.baseUrl.value.trim(), apiKey = els.apiKey.value;
    els.connectStatus.classList.remove('dob-err');
    els.connectStatus.textContent = C().connecting; setBusy(true);
    let r;
    try { r = await desktop.connectProvider({ baseUrl, apiKey }); } catch (e) { r = { ok: false, error: e?.message || 'CONNECT_FAILED' }; }
    setBusy(false); els.apiKey.value = '';
    if (!r?.ok) {
      els.connectStatus.classList.add('dob-err');
      els.connectStatus.textContent = C().connectFail.replace('{error}', String(r?.error || 'CONNECT_FAILED'));
      document.getElementById('dobToTemplate').hidden = false;
      return;
    }
    els.connectStatus.textContent = C().connectOk;
    branch = 'live';
    startInterview();
  }
  function addMsg(role, text) {
    const d = document.createElement('div');
    d.className = 'dob-msg ' + (role === 'assistant' ? 'dob-damar' : 'dob-user');
    d.textContent = text; els.log.appendChild(d); els.log.scrollTop = els.log.scrollHeight;
  }
  async function chatTurn() {
    els.chatStatus.textContent = C().chatThinking; setBusy(true);
    let r;
    try { r = await desktop.onboardingChat(history); } catch (e) { r = { ok: false, error: e?.message || 'CHAT_FAILED' }; }
    setBusy(false); els.chatStatus.textContent = '';
    if (!r?.ok || !r.data?.text) {
      els.chatStatus.classList.add('dob-err');
      els.chatStatus.textContent = C().chatFail.replace('{error}', String(r?.error || 'CHAT_FAILED'));
      return;
    }
    const raw = String(r.data.text);
    history.push({ role: 'assistant', content: raw });
    const found = parseSetup(raw);
    const visible = stripSetup(raw);
    if (visible) { addMsg('assistant', visible); speakOnly(visible); }
    if (found) { extracted = found; showForm('live'); }
    else els.chatInput.focus();
  }
  function startInterview() {
    show('chat');
    say(C().connectOk);
    history = [{ role: 'user', content: C().kickoff }];
    chatTurn();
  }
  function onChatSend() {
    const text = els.chatInput.value.trim(); if (!text) return;
    els.chatInput.value = '';
    addMsg('user', text);
    history.push({ role: 'user', content: text.slice(0, 2000) });
    chatTurn();
  }

  // ---- Branch B (template) + the shared confirmation form ----
  function startTemplate() {
    branch = 'template';
    show('intro');
    announce(C().intro);
  }
  function fieldInput(wrap) { return wrap.querySelector('input, select'); }
  function setStep(i, speakIt = true) {
    stepIndex = i;
    els.fieldWraps.forEach((w, j) => w.classList.toggle('dob-current', j === i));
    const btn = document.getElementById('dobNextBtn');
    btn.textContent = i >= FIELDS.length - 1 ? C().saveBtn : C().nextBtn;
    if (i >= 0 && FIELDS[i]) { if (speakIt) announce(C()[FIELDS[i].q]); const input = fieldInput(els.fieldWraps[i]); if (input && FIELDS[i].kind === 'text') input.focus(); }
  }
  function showForm(mode) {
    formMode = mode;
    // The language question's proposed default is Bahasa Indonesia (the panel's own copy follows the UI
    // language, but the answer's default does not - the user confirms or changes it here).
    const pre = extracted || sanitize({ language: 'id' });
    els.fieldWraps.forEach((w, i) => {
      const f = FIELDS[i], input = fieldInput(w);
      if (f.kind === 'text') input.value = pre[f.key] || '';
      else if (f.kind === 'language') input.value = pre.language;
      else input.checked = pre.voiceEnabled === true;
    });
    document.getElementById('dobNextBtn').hidden = mode !== 'template';
    document.getElementById('dobSaveBtn').hidden = mode === 'template';
    show('form');
    if (mode === 'template') { say(C().formIntroTemplate); setStep(0); }
    else { stepIndex = -1; els.fieldWraps.forEach(w => w.classList.remove('dob-current')); announce(C().formIntroLive); }
  }
  function onNext() {
    if (stepIndex >= FIELDS.length - 1) { save(readForm()); return; }
    setStep(stepIndex + 1);
  }
  function readForm() {
    const out = {};
    els.fieldWraps.forEach((w, i) => {
      const f = FIELDS[i], input = fieldInput(w);
      out[f.key] = f.kind === 'check' ? input.checked : input.value;
    });
    return sanitize(out);
  }
  async function save(values) {
    phase = 'saving'; setBusy(true);
    els.formStatus.textContent = C().saving; els.formStatus.classList.remove('dob-err');
    let r;
    try { r = await desktop.saveOnboarding(values); } catch (e) { r = { ok: false, error: e?.message || 'SAVE_FAILED' }; }
    setBusy(false);
    if (!r?.ok) {
      phase = 'form';
      els.formStatus.classList.add('dob-err');
      els.formStatus.textContent = C().saveFail.replace('{error}', String(r?.error || 'SAVE_FAILED'));
      return;
    }
    savedValues = values;
    const address = values.salutation || values.displayName;
    const closing = address ? C().closing.replace('{address}', address) : C().closingNoName;
    show('done');
    document.getElementById('dobDoneText').textContent = closing;
    // The done view's body IS the closing line - clear the say-line so it is not shown twice,
    // and speak it without routing it through the say-line.
    document.getElementById('dobSay').textContent = '';
    speak(closing); spoken.push(closing);
    setTimeout(() => { els.root.hidden = true; phase = 'done'; }, 9000);
    phase = 'done';
  }

  // ---- Gate: fire once, only against a Core that can persist (source 'core'), only while uncompleted. ----
  function consider(config) {
    if (!config) return;
    // Completed elsewhere (e.g. another surface finished it): close at once. Completed by THIS panel's
    // save: the closing line stays readable - save() already scheduled the hide.
    if (config.source === 'core' && config.onboardingCompleted === true && started) { if (phase !== 'done') { els.root.hidden = true; phase = 'done'; } return; }
    if (started || config.source !== 'core' || config.onboardingCompleted !== false) return;
    started = true;
    lang = window.DAMAR_I18N?.lang?.() === 'en' ? 'en' : 'id';
    build();
    show('connect');
    announce(C().step0Intro);
  }
  desktop.onPresence(msg => consider(msg?.config));
  desktop.getPresence().then(msg => consider(msg?.config)).catch(() => {});
})();
