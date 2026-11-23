'use strict';
// DAMAR Presence strings: English first, Indonesian optional (Core `cli.language`, GET /api/r9/cli/settings).
// The Owner page keeps its markup; its visible static texts are mapped to English at load, and text that the Owner
// file stores double-encoded (UTF-8 read as Windows-1252, e.g. "â€œ") is repaired in both languages.
(() => {
  const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
  function repair(text) {
    if (typeof text !== 'string' || !/[ÃÂâ][\u0080-ÿŒ-™]/.test(text)) return text;
    const bytes = [];
    for (const ch of text) {
      const c = ch.codePointAt(0), i = CP1252.indexOf(ch);
      if (i >= 0) bytes.push(0x80 + i); else if (c <= 0xff) bytes.push(c); else return text;
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch { return text; }
  }
  // Owner page (Indonesian source) -> English. Keys are the repaired source text.
  const PAGE_EN = {
    '15 Detik': '15 s', '30 Detik': '30 s', '60 Detik': '60 s',
    '7 Lapisan Memori & Rekonsiliasi': '7 Memory Layers & Reconciliation',
    'Aktifkan Mode Computer Use (Micro Siri-Orb mengikuti jendela)': 'Computer Use mode (the micro orb follows the window)',
    'Auto-Standby Timer (Idle X Detik)': 'Auto-standby timer (idle seconds)',
    'Batas CPU/RAM/GPU & Anggaran': 'CPU/RAM/GPU Limits & Budget',
    'Efek Suara Sinematik': 'Cinematic sound effects',
    'Geser atau klik untuk berinteraksi dengan Orb Damar': 'Drag or click to interact with the DAMAR orb',
    'Kembali ke Ruang Presence (Orb)': 'Back to Presence (orb)',
    'Kirim Instruksi (Enter)': 'Send instruction (Enter)',
    'Klik untuk Interaksi Suara Presence Langsung': 'Click for live voice presence',
    'Klik untuk membuka dashboard. Klik kanan untuk uji suara atau pindah jendela.': 'Click to open the dashboard. Right-click to test voice or switch window.',
    'Masuk ke Mode Standby Siri-Orb di Tengah Bawah Layar': 'Enter standby orb mode (bottom centre of the screen)',
    'Maximize / Perluas Ukuran Workspace': 'Maximize workspace',
    'Minimize ke Taskbar (Klik Taskbar atau Alt+D untuk buka kembali)': 'Minimize to the taskbar (click the taskbar or press Alt+D to reopen)',
    'Mode Presentasi & Visual': 'Presentation & visual mode',
    'Pengaturan Ukuran Standby Orb, Timer Idle & Simulator Status': 'Open DAMAR Control',
    'Perangkat Offline ≠ Berhasil': 'Device offline ≠ success',
    'Peta Fondasi vs Target (Bagian 16)': 'Foundation vs Target Map (Section 16)',
    'Putar Ulang Animasi Intro': 'Replay intro animation',
    'Ruang Kerja Utama': 'Main Workspace',
    'Runtime Health, Audit Ledger & Versi': 'Runtime Health, Audit Ledger & Version',
    'Serabut Sutra Optik': 'Fibre-optic conduits',
    'Tutup dengan Animasi Orb Outro': 'Close with the orb outro animation',
    'Ukuran Computer Use Orb:': 'Computer Use orb size:',
    'Ukuran Standby Orb:': 'Standby orb size:',
    'Ukuran WebGL Siri Standby Orb': 'Standby orb size',
    'Windows Utama, Linux, Server, Android': 'Windows (primary), Linux, Server, Android',
    '[TUTUP SESI ✕]': '[END SESSION ✕]',
    '“Silakan bicara — Damar siap mengeksekusi melalui Computer Use...”': '“Go ahead — DAMAR is ready to act through Computer Use…”',
    '🎙 “Damar, pagi. Ada yang perlu diperhatikan?”': '🎙 “Morning, DAMAR. Anything I should look at today?”',
    '🎙 “Uji Aksi Destruktif / Error”': '🎙 “Test a destructive action / error”',
    '🖥 “Operasikan Komputer & Kerjakan Proyek”': '🖥 “Operate the computer & work on the project”',
    'Ya. Damar hadir dan mendengarkan instruksimu.': 'Yes. DAMAR is here and listening.',
  };
  // Product (notch/adapter) strings.
  const UI = {
    en: {
      returnPresence: 'Return to Presence', dashboard: 'Control', answerInCli: 'Answer in CLI',
      allowOnce: 'Allow once', allowSession: 'Allow for session', deny: 'Deny',
      notConnected: 'DAMAR Core not connected', idle: 'idle', permissionWaiting: n => `${n} permission waiting`,
      turnsRunning: n => `${n} turn${n === 1 ? '' : 's'} running`, pandawaRuns: n => `${n} Pandawa run${n === 1 ? '' : 's'}`,
      permWrite: (f, a, r) => `Allow write ${f}${a != null ? ` (+${a} −${r ?? 0})` : ''}?`, permEdit: (f, a, r) => `Allow edit ${f}${a != null ? ` (+${a} −${r ?? 0})` : ''}?`,
      permOther: tool => `${tool} needs your approval — review the full request in DAMAR CLI`,
      read: f => `Reading ${f || 'workspace'}`, edit: (f, a, r) => `Edited ${f} +${a ?? 0} −${r ?? 0}`, run: 'Running a command', shell: 'Running a shell command',
      done: 'Turn finished', failed: 'Turn ended: ', micOn: 'Microphone on', controlOpen: 'Open DAMAR Control',
      greeting: (h, name) => `Good ${GREETING_WORDS.en[greetingBand(h)]}${name ? ', ' + name : ''}.`,
      cliOnly: 'Conversation runs in DAMAR CLI.', cuNotice: 'Computer Use runs through DAMAR CLI;',
      alert: l => `Alert: ${l}`, alertCount: n => `${n} alert${n === 1 ? '' : 's'}`,
      discussing: (r, o) => `Pandawa discussing${r ? ` (round ${r}/${o || r})` : ''}`, discussionDone: 'Pandawa synthesis done', discussionEnded: s => `Pandawa discussion ${String(s || '').toLowerCase()}`,
      tool: t => ({ workspace_run: 'A command', workspace_shell: 'A shell command', project_memory_add: 'A memory note', pandawa_delegate: 'A Pandawa delegation', trusted_plugin_execute: 'A plugin run' })[t] || (/^computer_use/.test(t || '') ? 'A Computer Use action' : 'An action'),
    },
    id: {
      returnPresence: 'Kembali ke Presence', dashboard: 'Control', answerInCli: 'Jawab di CLI',
      allowOnce: 'Izinkan sekali', allowSession: 'Izinkan sesi ini', deny: 'Tolak',
      notConnected: 'DAMAR Core tidak terhubung', idle: 'siaga', permissionWaiting: n => `${n} izin menunggu`,
      turnsRunning: n => `${n} giliran berjalan`, pandawaRuns: n => `${n} tugas Pandawa`,
      permWrite: (f, a, r) => `Izinkan tulis ${f}${a != null ? ` (+${a} −${r ?? 0})` : ''}?`, permEdit: (f, a, r) => `Izinkan ubah ${f}${a != null ? ` (+${a} −${r ?? 0})` : ''}?`,
      permOther: tool => `${tool} perlu izinmu — tinjau lengkap di DAMAR CLI`,
      read: f => `Membaca ${f || 'workspace'}`, edit: (f, a, r) => `Mengubah ${f} +${a ?? 0} −${r ?? 0}`, run: 'Menjalankan perintah', shell: 'Menjalankan perintah shell',
      done: 'Giliran selesai', failed: 'Giliran berakhir: ', micOn: 'Mikrofon aktif', controlOpen: 'Buka DAMAR Control',
      greeting: (h, name) => `Selamat ${GREETING_WORDS.id[greetingBand(h)]}${name ? ', ' + name : ''}.`,
      cliOnly: 'Percakapan berjalan di DAMAR CLI.', cuNotice: 'Computer Use berjalan melalui DAMAR CLI;',
      alert: l => `Peringatan: ${l}`, alertCount: n => `${n} peringatan`,
      discussing: (r, o) => `Pandawa berdiskusi${r ? ` (ronde ${r}/${o || r})` : ''}`, discussionDone: 'Sintesis Pandawa selesai', discussionEnded: s => `Diskusi Pandawa ${({ FAILED: 'gagal', CANCELLED: 'dibatalkan' })[s] || String(s || '').toLowerCase()}`,
      tool: t => ({ workspace_run: 'Sebuah perintah', workspace_shell: 'Perintah shell', project_memory_add: 'Catatan memori', pandawa_delegate: 'Delegasi Pandawa', trusted_plugin_execute: 'Plugin' })[t] || (/^computer_use/.test(t || '') ? 'Aksi Computer Use' : 'Sebuah aksi'),
    },
  };
  let lang = 'en';
  const originals = new WeakMap(); // node -> original (repaired) Owner text, so switching back restores it

  function translateNode(node) {
    const raw = originals.has(node) ? originals.get(node) : repair(node.nodeValue);
    if (!originals.has(node)) originals.set(node, raw);
    const key = raw.trim(), en = PAGE_EN[key];
    const next = lang === 'en' && en ? raw.replace(key, en) : raw;
    if (node.nodeValue !== next) node.nodeValue = next;
  }
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function translateAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute?.(a)) continue;
      const k = 'data-i18n-src-' + a;
      if (!el.hasAttribute(k)) el.setAttribute(k, repair(el.getAttribute(a)));
      const raw = el.getAttribute(k), en = PAGE_EN[raw.trim()];
      el.setAttribute(a, lang === 'en' && en ? en : raw);
    }
  }
  function apply(root = document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.parentElement && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) translateNode(n);
    if (root.querySelectorAll) { translateAttrs(root); root.querySelectorAll('[title],[placeholder],[aria-label]').forEach(translateAttrs); }
  }
  function setLang(next) { const l = next === 'id' ? 'id' : 'en'; if (l === lang) return; lang = l; document.documentElement.lang = l; apply(); window.dispatchEvent(new CustomEvent('damar-presence-lang', { detail: l })); }
  // Greeting time bands (Owner spec, local machine time): morning 05:00-10:59, afternoon 11:00-14:59,
  // evening 15:00-18:59, night 19:00-04:59. One pure helper so both languages share the same bands.
  function greetingBand(h) { return h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 15 ? 'afternoon' : h >= 15 && h < 19 ? 'evening' : 'night'; }
  const GREETING_WORDS = { en: { morning: 'morning', afternoon: 'afternoon', evening: 'evening', night: 'night' }, id: { morning: 'pagi', afternoon: 'siang', evening: 'sore', night: 'malam' } };
  const t = (key, ...args) => { const v = UI[lang][key] ?? UI.en[key]; return typeof v === 'function' ? v(...args) : v; };
  window.DAMAR_I18N = Object.freeze({ t, setLang, apply, repair, lang: () => lang, PAGE_EN, UI, greetingBand });
  document.documentElement.lang = 'en';
  const start = () => {
    apply();
    // Dynamic Owner text (toasts, greeting, transcript) passes through the same mapping.
    new MutationObserver(list => { for (const m of list) {
      if (m.type === 'characterData') translateNodeLive(m.target);
      for (const n of m.addedNodes || []) n.nodeType === 3 ? translateNodeLive(n) : apply(n);
    } }).observe(document.body, { subtree: true, childList: true, characterData: true });
  };
  function translateNodeLive(n) { originals.delete(n); if (n.parentElement && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) translateNode(n); }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
