// DAMAR Control, product surface bound to the R9 Core API (no fixtures, no mock approvals).
// Shell, navigation, command palette, drawer and keyboard behaviour follow the accepted CC2-M2 prototype;
// every datum comes from Core over the same loopback origin with the Owner credential the launcher put in
// the URL fragment (kept in memory only). Panels Core does not serve say so instead of showing data.
(function (root) {
  'use strict';

  // ==========================================================================
  // 1. PURE HELPERS (also exercised by tests/control-*.test.cjs under Node)
  // ==========================================================================
  var SECRET_KEY = /(secret|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|bearer|authorization|credential|cookie|private[-_]?key)/i;
  var SECRET_EXACT = /^(token|key|env|headers|auth)$/i;
  var SECRET_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/g;
  var REDACTED = '[REDACTED]';

  // Deep copy with secret-named fields and secret-shaped strings replaced. Numbers/booleans stay
  // (token *counts* and hasKey flags are not secrets). `known` = exact credential strings to scrub.
  function redact(value, known, depth) {
    depth = depth || 0;
    if (depth > 12) return REDACTED;
    if (typeof value === 'string') {
      var s = value;
      (known || []).forEach(function (k) { if (k && k.length >= 8) s = s.split(k).join(REDACTED); });
      return s.replace(SECRET_TEXT, REDACTED);
    }
    if (Array.isArray(value)) return value.slice(0, 500).map(function (v) { return redact(v, known, depth + 1); });
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) {
        var v = value[k];
        if ((SECRET_KEY.test(k) || SECRET_EXACT.test(k)) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
          // A secret-named container (env map, headers, a credential descriptor): keep its shape and
          // recurse per key. Real secret values sit under secret-named leaves of their own (env var
          // names, header names, password fields) and are still scrubbed by this same rule one level
          // down; descriptor objects that carry no secrets (Mata Dewa's feed credential descriptor:
          // field names, a public signup URL, a hasKey flag) survive intact instead of being flattened
          // into a shape that crashes its consumer.
          out[k] = redact(v, known, depth + 1);
        } else if ((SECRET_KEY.test(k) || SECRET_EXACT.test(k)) && v !== null && typeof v !== 'boolean' && typeof v !== 'number') {
          out[k] = REDACTED;
        } else out[k] = redact(v, known, depth + 1);
      });
      return out;
    }
    return value;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Credentials arrive only in the fragment: #owner=<hex>&console=<hex>.
  function parseFragment(hash) {
    var out = { owner: '', console: '', view: '' };
    String(hash || '').replace(/^#/, '').split('&').forEach(function (pair) {
      var i = pair.indexOf('='); if (i < 0) return;
      var k = pair.slice(0, i), v = decodeURIComponent(pair.slice(i + 1));
      if ((k === 'owner' || k === 'console') && /^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(v)) out[k] = v;
      if (k === 'view' && /^[a-z]{2,20}$/.test(v)) out.view = v;
    });
    return out;
  }

  // Core client. Every call: same origin, bearer auth, JSON envelopes {success,data}|{success:false,error}.
  function createCore(opts) {
    var base = opts.base || '', doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(root) : null);
    var known = [opts.owner, opts.console];
    function call(method, route, body) {
      var cred = route.indexOf('/api/v1/console/') === 0 ? opts.console : opts.owner;
      if (!cred) return Promise.resolve({ ok: false, status: 401, error: 'OWNER_CREDENTIAL_MISSING', data: null });
      var headers = { accept: 'application/json', authorization: 'Bearer ' + cred };
      if (body !== undefined) headers['content-type'] = 'application/json';
      var started = Date.now();
      return doFetch(base + route, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', redirect: 'error' })
        .then(function (r) {
          return r.text().then(function (text) {
            var j = null; try { j = JSON.parse(text); } catch (e) { j = null; }
            var ms = Date.now() - started;
            if (r.ok && j && j.success !== false) return { ok: true, status: r.status, data: redact(j.data === undefined ? null : j.data, known), ms: ms };
            var error = j && typeof j.error === 'string' ? j.error.replace(/[^A-Za-z0-9_:. -]/g, '').slice(0, 120) : 'HTTP_' + r.status;
            return { ok: false, status: r.status, error: error, data: j && j.data ? redact(j.data, known) : null, ms: ms };
          });
        }, function () { return { ok: false, status: 0, error: 'CORE_UNREACHABLE', data: null, ms: Date.now() - started }; });
    }
    // Server-sent events with the Owner credential. Calls onEvent per event (secrets redacted); returns an abort function.
    function stream(route, onEvent, onEnd) {
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      doFetch(base + route, { headers: { accept: 'text/event-stream', authorization: 'Bearer ' + opts.owner }, cache: 'no-store', credentials: 'omit', signal: ctl && ctl.signal })
        .then(function (r) {
          if (!r.ok || !r.body || !r.body.getReader) throw Error('STREAM_UNAVAILABLE');
          var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
          return (function pump() {
            return reader.read().then(function (x) {
              if (x.done) return;
              buf += dec.decode(x.value, { stream: true });
              var i; while ((i = buf.indexOf('\n\n')) >= 0) {
                var block = buf.slice(0, i); buf = buf.slice(i + 2);
                var line = block.split('\n').filter(function (l) { return l.indexOf('data: ') === 0; })[0];
                if (line) { try { onEvent(redact(JSON.parse(line.slice(6)), known)); } catch (e) {} }
              }
              return pump();
            });
          })();
        }).then(function () { if (onEnd) onEnd(null); }, function (e) { if (onEnd) onEnd(e); });
      return function () { if (ctl) ctl.abort(); };
    }
    return { get: function (route) { return call('GET', route); }, post: function (route, body) { return call('POST', route, body || {}); }, stream: stream };
  }

  // Human text for a failed Core mutation (error code is Core's, never invented).
  // Interface language: Core setting cli.language (shared by the CLI and Control). English is the default.
  var LANG = 'en';
  var ID = {
    'Workspace': 'Ruang kerja', 'Overview': 'Ikhtisar', 'Sessions': 'Sesi', 'Usage': 'Pemakaian', 'Automations': 'Otomasi', 'AI Infrastructure': 'Infrastruktur AI',
    'Capabilities Hub': 'Pusat Kapabilitas', 'Models': 'Model', 'Providers': 'Provider', 'Skills': 'Skill', 'Plugins': 'Plugin', 'MCP Servers': 'Server MCP',
    'DAMAR Intelligence': 'Kecerdasan DAMAR', 'Memory & Continuity': 'Memori & Kontinuitas', 'Development': 'Pengembangan', 'Runtime': 'Runtime', 'Logs': 'Log',
    'Diagnostics': 'Diagnostik', 'Administration': 'Administrasi', 'Security & Governance': 'Keamanan & Tata Kelola', 'Settings': 'Pengaturan', 'Damar CLI': 'Damar CLI',
    'Manage intelligence, runtime operations, tools and system governance.': 'Kelola kecerdasan, operasi runtime, tool, dan tata kelola sistem.',
    'View Sessions': 'Lihat Sesi', 'Pandawa Runs': 'Run Pandawa', 'Runtime State': 'Status Runtime', 'Outstanding Work': 'Pekerjaan Berjalan', 'Active Provider': 'Provider Aktif',
    'Session Tokens': 'Token Sesi', 'Capabilities': 'Kapabilitas', 'Recent Pandawa Runs': 'Run Pandawa Terbaru', 'Provider Budget': 'Anggaran Provider', 'Budget': 'Anggaran',
    'From Core run ledger': 'Dari ledger run Core', 'Inspect Runtime →': 'Periksa Runtime →', 'Lifecycle:': 'Siklus hidup:', 'Active provider:': 'Provider aktif:',
    'Live inference:': 'Inferensi live:', 'Emergency stop:': 'Henti darurat:', 'Session Ledger': 'Ledger Sesi', 'Title': 'Judul', 'Session': 'Sesi', 'Model': 'Model', 'State': 'Status',
    'Tokens': 'Token', 'Updated': 'Diperbarui', 'Inspect': 'Periksa', 'Per-session usage': 'Pemakaian per sesi', 'Load receipts': 'Muat bukti', 'Status': 'Status', 'Cost': 'Biaya',
    'Tools': 'Tool', 'Agents': 'Agen', 'Catalog': 'Katalog', 'Activate': 'Aktifkan', 'Connect…': 'Hubungkan…', 'Revoke': 'Cabut', 'Grant…': 'Beri grant…', 'Revoke grant…': 'Cabut grant…',
    'Model Grant (live dispatch authority)': 'Model Grant (otoritas inferensi live)', 'View Model Catalog →': 'Lihat Katalog Model →', 'Provider id': 'ID provider', 'Kind': 'Jenis',
    'Endpoint': 'Endpoint', 'Configured': 'Dikonfigurasi', 'Key stored': 'Kunci tersimpan', 'Dispatch': 'Dispatch', 'Image input': 'Input gambar', 'Configuration version': 'Versi konfigurasi',
    'Effective': 'Berlaku', 'Revision': 'Revisi', 'Grant': 'Grant', 'Limits': 'Batas', 'Scope': 'Cakupan', '+ Delegate Run': '+ Delegasikan Run', 'Pandawa Agent Registry': 'Registri Agen Pandawa',
    'Run Ledger': 'Ledger Run', 'Agent': 'Agen', 'Role': 'Peran', 'Availability': 'Ketersediaan', 'Active runs': 'Run aktif', 'Completed': 'Selesai', 'Run': 'Run', 'Worker': 'Worker',
    'Provider / model': 'Provider / model', 'Attempts': 'Percobaan', 'Result': 'Hasil', 'Cancel': 'Batal', 'Confirm': 'Konfirmasi', 'Not available in this release': 'Belum tersedia di rilis ini',
    'Available in v1.1': 'Belum tersedia', 'Core Memory Store': 'Penyimpanan Memori Core', 'Project Memory': 'Memori Proyek', 'List': 'Daftar', 'Add note…': 'Tambah catatan…', 'Forget': 'Lupakan',
    'Checkpoints (undo / redo)': 'Checkpoint (undo / redo)', 'Launch': 'Jalankan', 'CLI Sessions': 'Sesi CLI', 'Lifecycle': 'Siklus hidup', 'Host': 'Host', 'Sandbox Boundary': 'Batas Sandbox',
    'Re-run checks': 'Jalankan ulang', 'Core route checks': 'Pemeriksaan rute Core', 'Safety': 'Keselamatan', 'Permissions': 'Izin', 'Core Settings': 'Pengaturan Core',
    'Load settings from Core': 'Muat pengaturan dari Core', 'Agent Permissions': 'Izin Agen', 'Autonomy profile': 'Profil otonomi', 'Skill routing': 'Routing skill', 'Save…': 'Simpan…',
    'Workspace Access': 'Akses Ruang Kerja', 'Extra folders': 'Folder tambahan', 'Idle Presence & Notch': 'Idle Presence & Notch', 'Reduced motion': 'Kurangi animasi',
    'Notification privacy': 'Privasi notifikasi', 'Display': 'Layar', 'Position': 'Posisi', 'Microphone / voice (opt-in)': 'Mikrofon / suara (opsional)', 'Save presence…': 'Simpan presence…',
    'Theme': 'Tema', 'Banner': 'Banner', 'Interface language (CLI & Control)': 'Bahasa antarmuka (CLI & Control)', 'HUD dock': 'Posisi HUD', 'Save CLI settings…': 'Simpan pengaturan CLI…',
    'Last provider / model': 'Provider / model terakhir', 'Source': 'Sumber', 'Mobile': 'Mobile', 'Providers & Models': 'Provider & Model', 'Providers →': 'Provider →', 'Models →': 'Model →',
    'Project Plugins': 'Plugin Proyek', 'Trusted': 'Dipercaya', 'Get started': 'Mulai', 'Hide': 'Sembunyikan', 'Connect a model provider': 'Hubungkan provider model',
    'Allow models (grant *)': 'Izinkan model (grant *)', 'Start the DAMAR CLI': 'Jalankan DAMAR CLI', 'Done': 'Selesai', 'Next': 'Berikutnya',
    'Owner action': 'Aksi Owner', 'Sent to DAMAR Core': 'Dikirim ke DAMAR Core', 'Skip to main content': 'Lewati ke konten utama', 'New Run': 'Run Baru',
    'Search capabilities, models, tools, or jump to view...': 'Cari kapabilitas, model, tool, atau buka tampilan...', 'Idle Presence Surface': 'Permukaan Idle Presence',
    'Core Host': 'Host Core', 'Owner credential required': 'Kredensial Owner diperlukan', 'Nothing reported by Core.': 'Tidak ada data dari Core.',
    'accepted by Core': 'diterima Core', 'Discussions': 'Diskusi', 'Discussion': 'Diskusi', '+ New discussion': '+ Diskusi baru', 'Open': 'Buka', 'Topic': 'Topik', 'Mode': 'Mode', 'Round': 'Ronde', 'round': 'ronde',
    'Team': 'Tim', 'Member': 'Anggota', 'Calls': 'Panggilan', 'In': 'Masuk', 'Out': 'Keluar', 'Send': 'Kirim', 'Stop': 'Hentikan', 'Per-member usage': 'Pemakaian per anggota', 'Transcript': 'Transkrip',
    'You (interjection)': 'Anda (sela)', 'did not reply': 'tidak menjawab', 'synthesis (Decision / Rationale / Dissent)': 'sintesis (Keputusan / Alasan / Perbedaan pendapat)',
    'Open a discussion to follow it live.': 'Buka diskusi untuk mengikutinya secara langsung.', 'Add your view to the discussion…': 'Tambahkan pendapat Anda…',
    'Started in a CLI window: interject or stop it there.': 'Dimulai di jendela CLI: sela atau hentikan dari sana.', 'No discussions yet. Start one here, or with /discuss in the CLI.': 'Belum ada diskusi. Mulai di sini, atau dengan /discuss di CLI.',
    'Cycle': 'Siklus', 'Turn': 'Giliran', 'Cycle / Turn': 'Siklus / Giliran', 'Extend discussion': 'Lanjutkan diskusi', 'Discussion continued by the Owner': 'Diskusi dilanjutkan oleh Owner',
    'Reopens the debate chain from the last decision.': 'Membuka lagi rantai debat dari keputusan terakhir.', 'Members (debate)': 'Anggota (debat)', "DAMAR's decision": 'Keputusan DAMAR',
    'The debate chain resumes from the full transcript, including DAMAR\'s decision. Members answer it turn by turn until they converge or DAMAR rules a deadlock.': 'Rantai debat berlanjut dari transkrip penuh, termasuk keputusan DAMAR. Anggota menjawabnya giliran demi giliran sampai konvergen atau DAMAR memutuskan buntu.',
    'Debate cycle safety limit (1-100)': 'Batas pengaman siklus debat (1-100)', 'Inherit the main model': 'Warisi model utama', 'Save Pandawa models…': 'Simpan model Pandawa…',
    'Your name (greeting, optional)': 'Nama Anda (sapaan, opsional)', 'How DAMAR addresses you (optional)': 'Sapaan DAMAR untuk Anda (opsional)', 'Memory & Context': 'Memori & Konteks', 'Long-term memory': 'Memori jangka panjang', 'Ask before remembering': 'Tanya sebelum mengingat',
    'Keep memories (days, 0 = forever)': 'Simpan memori (hari, 0 = selamanya)', 'Memory in context (chars, 500-20000)': 'Memori dalam konteks (karakter, 500-20000)', 'Conversation turns kept (0-50)': 'Giliran percakapan disimpan (0-50)',
    'Conversation chars kept (2000-400000)': 'Karakter percakapan disimpan (2000-400000)', 'Core mind block': 'Blok mind Core', 'Export memory…': 'Ekspor memori…', 'Clear workspace memory…': 'Hapus memori ruang kerja…',
    'Save memory settings…': 'Simpan pengaturan memori…', 'Pandawa Team': 'Tim Pandawa', 'Active provider': 'Provider aktif', "DAMAR's model": 'Model DAMAR', 'Discussion rounds (1-10)': 'Ronde diskusi (1-10)',
    'Token budget per discussion (1000-2000000)': 'Anggaran token per diskusi (1000-2000000)', 'Save team…': 'Simpan tim…', 'Time limit per member reply (seconds, 30-1800)': 'Batas waktu jawaban anggota (detik, 30-1800)', 'Usage by Pandawa member': 'Pemakaian per anggota Pandawa',
    'Operations': 'Operasi', 'Conversation': 'Percakapan', 'User': 'Pengguna', 'Unavailable': 'Tidak tersedia', 'None.': 'Tidak ada.',
    'No conversation recorded for this session.': 'Belum ada percakapan tercatat untuk sesi ini.',
    'Tokens used': 'Token terpakai', 'Blocked': 'Diblokir', 'Yes': 'Ya', 'No': 'Tidak', 'Usage reporting': 'Pelaporan pemakaian', 'Recorded by Core': 'Tercatat di Core',
    'Runaway guard, total tokens': 'Pengaman lonjakan, total token', 'Runaway guard, per request': 'Pengaman lonjakan, per permintaan', 'Runaway guard, requests': 'Pengaman lonjakan, jumlah permintaan',
    'Restart Core…': 'Mulai ulang Core…', 'Restart Core': 'Mulai ulang Core', 'Reason': 'Alasan', 'Restart attempts': 'Percobaan mulai ulang', 'Active turns': 'Giliran aktif',
    'Pending permissions': 'Izin menunggu', 'Active Pandawa runs': 'Run Pandawa aktif', 'Queued Pandawa runs': 'Run Pandawa antre', 'Active jobs': 'Tugas aktif',
    'Job state available': 'Status tugas tersedia', 'Restart limit': 'Batas mulai ulang', 'Core uptime': 'Uptime Core', 'AI platform': 'Platform AI', 'Memory': 'Memori',
    'Core restarts under its supervisor. The restart rotates this tab\'s session credential, so this tab stops working once Core is back: reopen DAMAR Control from Presence or the damar control command. Core refuses the restart while turns, permissions, runs or jobs are outstanding.': 'Core mulai ulang di bawah supervisornya. Mulai ulang mengganti kredensial sesi tab ini, jadi tab ini berhenti bekerja begitu Core kembali: buka lagi DAMAR Control dari Presence atau perintah damar control. Core menolak mulai ulang selama masih ada giliran, izin, run, atau tugas yang berjalan.',
    'Core lifecycle and enforced sandbox boundary. Restart is an Owner action: Core refuses while work is outstanding.': 'Siklus hidup Core dan batas sandbox yang ditegakkan. Mulai ulang adalah aksi Owner: Core menolak selama masih ada pekerjaan berjalan.',
    'Token usage from Core durable receipts per session. Cost is shown only when Core has rate provenance.': 'Pemakaian token dari bukti persisten Core per sesi. Biaya hanya tampil bila Core punya asal-usul tarif.',
    'CLI and Control sessions recorded by Core (append-only ledger). Open a session to inspect its conversation, operations and usage.': 'Sesi CLI dan Control yang dicatat Core (ledger append-only). Buka sesi untuk memeriksa percakapan, operasi, dan pemakaiannya.',
    'Project memory export / clear uses the workspace folder from Memory & Continuity.': 'Ekspor / hapus memori proyek memakai folder ruang kerja dari Memori & Kontinuitas.',
    'In / Out tokens': 'Token masuk / keluar', 'Receipts': 'Bukti', 'Command': 'Perintah', 'No sessions recorded.': 'Belum ada sesi tercatat.',
    "Load a session's receipts to see which Pandawa member used how many tokens.": 'Muat bukti sebuah sesi untuk melihat pemakaian token tiap anggota Pandawa.',
    'Settings are read and written through an Owner Control session on Core.': 'Pengaturan dibaca dan ditulis lewat sesi Owner Control di Core.',
    'Persistent Core settings (Owner). Changes take effect for every session on this Core profile.': 'Pengaturan Core persisten (Owner). Perubahan berlaku untuk semua sesi pada profil Core ini.',
    'Tools, plugins, agents and MCP servers registered in DAMAR Core (read-only console routes; secrets redacted).': 'Tool, plugin, agen, dan server MCP yang terdaftar di DAMAR Core (rute konsol hanya-baca; rahasia disamarkan).',
    'Models each provider offers (metadata only). Activating a model is an Owner action Core validates against the current configuration version.': 'Model yang ditawarkan tiap provider (metadata saja). Mengaktifkan model adalah aksi Owner yang divalidasi Core terhadap versi konfigurasi saat ini.',
    'Provider configuration as reported by Core. Keys are write-only: Control can send a key to Core but never reads one back.': 'Konfigurasi provider sebagaimana dilaporkan Core. Key bersifat tulis-saja: Control bisa mengirim key ke Core tetapi tidak pernah membacanya kembali.',
    'Team debates and delegations run by Core: each round, the model each member used, DAMAR\'s decision and per-member token usage.': 'Debat tim dan delegasi yang dijalankan Core: tiap ronde, model yang dipakai tiap anggota, keputusan DAMAR, dan pemakaian token per anggota.',
    'Owner-approved runs through Core agentHub. Cancel stops queued runs; a running provider call finishes and its result is discarded.': 'Run yang disetujui Owner lewat agentHub Core. Batal menghentikan run yang antre; panggilan provider yang sedang berjalan selesai dan hasilnya dibuang.',
    'Core memory statistics, Owner-approved project memory per workspace, and per-session undo/redo checkpoints.': 'Statistik memori Core, memori proyek per ruang kerja yang disetujui Owner, dan checkpoint undo/redo per sesi.',
    'The CLI is a terminal surface on the same Core. Control lists its sessions; it does not emulate a terminal.': 'CLI adalah permukaan terminal pada Core yang sama. Control mendaftar sesinya; Control tidak mengemulasi terminal.',
    'Measured from this browser: status and latency of every Core read Control uses.': 'Diukur dari browser ini: status dan latensi setiap pembacaan Core yang dipakai Control.',
    'Safety state, agent permission profile and authority boundaries as Core enforces them.': 'Keadaan keselamatan, profil izin agen, dan batas otoritas sebagaimana ditegakkan Core.',
    'Pandawa Multi-Agent System': 'Sistem Multi-Agen Pandawa', 'Delegate Pandawa run': 'Delegasikan run Pandawa', '+ Delegate Run': '+ Delegasikan Run',
    'Remove an added model (optional)': 'Hapus model tambahan (opsional)', 'Remove an alias (optional)': 'Hapus alias (opsional)',
    'Go to': 'Buka', 'Refresh from Core': 'Segarkan dari Core', 'No matching commands.': 'Tidak ada perintah yang cocok.', 'Action': 'Aksi', 'Help': 'Bantuan',
    'Activate provider': 'Aktifkan provider', 'Activate model': 'Aktifkan model', 'Revoke provider': 'Cabut provider', 'Connect provider': 'Hubungkan provider',
    'Grant live model': 'Beri grant model live', 'Revoke model grant': 'Cabut grant model', 'Add provider': 'Tambah provider', 'Import keys': 'Impor key',
    'Test model': 'Uji model', 'Key rotation': 'Rotasi key', 'Connection limits': 'Batas koneksi', 'New combo': 'Combo baru', 'Create gateway key': 'Buat key gateway',
    'Remove provider': 'Hapus provider', 'Cancel Pandawa run': 'Batalkan run Pandawa', 'Save Core settings': 'Simpan pengaturan Core', 'Save CLI settings': 'Simpan pengaturan CLI', 'Routing': 'Routing',
    'Make %s the active provider in Core?': 'Jadikan %s provider aktif di Core?', 'Activate %s on %s?': 'Aktifkan %s di %s?',
    'Remove the stored configuration and key for %s in Core?': 'Hapus konfigurasi dan key tersimpan untuk %s di Core?',
    'Remove the connection %s and its remembered key from Core?': 'Hapus koneksi %s dan key yang diingatnya dari Core?',
    'Request cancellation of %s? A running provider call finishes; its result is discarded.': 'Minta pembatalan %s? Panggilan provider yang sedang berjalan akan selesai; hasilnya dibuang.',
    'Set autonomy %s, skill routing %s?': 'Atur otonomi %s, routing skill %s?',
    'Emergency stop': 'Henti darurat', 'Engaged': 'Aktif', 'Policy enforcement': 'Penegakan kebijakan', 'Pending permission requests': 'Permintaan izin menunggu',
    'Agent autonomy profile': 'Profil otonomi agen', 'Live model grant': 'Grant model live', 'Approvals': 'Persetujuan',
    'Memories': 'Memori', 'Entities': 'Entitas', 'Documents': 'Dokumen', 'Embeddings': 'Embedding', 'Note': 'Catatan', 'Added': 'Ditambahkan',
    'Workspace folder (absolute path)': 'Folder ruang kerja (path absolut)', 'No project memory for this workspace.': 'Belum ada memori proyek untuk ruang kerja ini.',
    'No sessions.': 'Tidak ada sesi.', 'held by a CLI window': 'dipegang jendela CLI', 'Attach & list': 'Ambil & daftar', 'Refresh': 'Segarkan', 'Undo…': 'Urungkan…', 'Redo…': 'Ulangi…',
    'Resume a session': 'Lanjutkan sesi', 'Core endpoint': 'Endpoint Core', 'Attached': 'Terhubung', 'Messages': 'Pesan', 'Sub-agent runs': 'Run sub-agen',
    'Read': 'Baca', 'Route': 'Rute', 'Latency': 'Latensi',
    "Load a session's receipts to see which Pandawa member used how many tokens.": 'Muat bukti sesi untuk melihat token yang dipakai tiap anggota Pandawa.', 'Help & Support': 'Bantuan & Dukungan', 'Report a problem': 'Laporkan masalah', 'License': 'Lisensi',
    'Questions and ideas': 'Pertanyaan dan ide', 'DAMAR is free and open source.': 'DAMAR gratis dan open source.', 'Core enforces Owner authority; nothing changes until Core accepts.': 'Core menegakkan otoritas Owner; tidak ada yang berubah sebelum Core menerima.'
  };
  // Provider connections, router-grade keys/combos and the DAMAR gateway (provider work). Existing entries win.
  (function (add) { Object.keys(add).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(ID, k)) ID[k] = add[k]; }); })({
      "+ Add provider…": "+ Tambah provider…",
      "Add provider": "Tambah provider",
      "Connect a provider": "Hubungkan provider",
      "Connect a provider…": "Hubungkan provider…",
      "No provider is connected. Add any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Ollama, LM Studio, your own router, …": "Belum ada provider yang terhubung. Tambahkan endpoint OpenAI-compatible apa pun: OpenAI, OpenRouter, Groq, Ollama, LM Studio, router Anda sendiri, …",
      "Model grant": "Model grant",
      "Forget key": "Lupakan key",
      "Remove": "Hapus",
      "Remove provider": "Hapus provider",
      "Grants": "Grant",
      "Start from": "Mulai dari",
      "Connection id (lowercase letters, digits, -)": "Id koneksi (huruf kecil, angka, -)",
      "Name": "Nama",
      "Endpoint (https://…, or http://127.0.0.1:<port>/v1 on this computer)": "Endpoint (https://…, atau http://127.0.0.1:<port>/v1 di komputer ini)",
      "API key (sent to Core once; never shown again)": "API key (dikirim ke Core sekali; tidak pernah ditampilkan lagi)",
      "Remember key on this PC (Windows DPAPI)": "Ingat key di PC ini (Windows DPAPI)",
      "Allow all models for this connection (30 days)": "Izinkan semua model untuk koneksi ini (30 hari)",
      "Core checks the endpoint (/models) before saving. Allowing all models authorizes live inference on this connection.": "Core memeriksa endpoint (/models) sebelum menyimpan. Mengizinkan semua model mengotorisasi inferensi live pada koneksi ini.",
      "Key rotation": "Rotasi key",
      "Models added / aliases": "Model tambahan / alias",
      "Key": "Key",
      "Last OK": "Terakhir OK",
      "Last error": "Error terakhir",
      "No keys yet.": "Belum ada key.",
      "Import keys…": "Impor key…",
      "Import keys": "Impor key",
      "Test all keys": "Uji semua key",
      "Test model… (spends tokens)": "Uji model… (memakai token)",
      "Rotation…": "Rotasi…",
      "Catalog…": "Katalog…",
      "Test": "Uji",
      "Enable": "Aktifkan",
      "Disable": "Nonaktifkan",
      "Delete": "Hapus",
      "cooldown until": "jeda hingga",
      "ok": "ok",
      "cooldown": "jeda",
      "error": "error",
      "untested": "belum diuji",
      "disabled": "nonaktif",
      "round-robin": "bergiliran (round-robin)",
      "fill-first": "isi dulu (prioritas)",
      "lru": "paling lama tidak dipakai (LRU)",
      "fallback": "cadangan berurutan (fallback)",
      "Combos (virtual models with fallback)": "Combo (model virtual dengan cadangan)",
      "Combo": "Combo",
      "Targets": "Target",
      "Available": "Tersedia",
      "granted": "diizinkan",
      "no granted target": "tidak ada target yang diizinkan",
      "No combos yet.": "Belum ada combo.",
      "New combo…": "Combo baru…",
      "New combo": "Combo baru",
      "Delete combo": "Hapus combo",
      "Routing…": "Routing…",
      "Routing": "Routing",
      "Cooldown after a failed key": "Jeda setelah key gagal",
      "Combos, routing and gateway": "Combo, routing dan gateway",
      "DAMAR Gateway (OpenAI-compatible /v1)": "Gateway DAMAR (OpenAI-compatible /v1)",
      "listening on": "mendengarkan di",
      "off": "mati",
      "Bind": "Alamat",
      "LAN (all interfaces)": "LAN (semua antarmuka)",
      "this computer only": "hanya komputer ini",
      "Base URL": "Base URL",
      "Prefix": "Awalan",
      "Usage": "Pemakaian",
      "No gateway keys yet.": "Belum ada key gateway.",
      "Gateway settings…": "Pengaturan gateway…",
      "Gateway settings": "Pengaturan gateway",
      "Create key…": "Buat key…",
      "Create gateway key": "Buat key gateway",
      "Revoke gateway key": "Cabut key gateway",
      "Any OpenAI client": "Klien OpenAI apa pun",
      "Gateway on": "Gateway aktif",
      "Listen on": "Dengarkan di",
      "Port": "Port",
      "Enable key": "Aktifkan key",
      "Disable key": "Nonaktifkan key",
      "Delete key": "Hapus key",
      "Enable this key for rotation?": "Aktifkan key ini untuk rotasi?",
      "Take this key out of rotation?": "Keluarkan key ini dari rotasi?",
      "Delete this key from Core and from secure storage?": "Hapus key ini dari Core dan penyimpanan aman?",
      "Key test (/models, no tokens)": "Uji key (/models, tanpa token)",
      "All keys (/models, no tokens)": "Semua key (/models, tanpa token)",
      "Test model": "Uji model",
      "Model test": "Uji model",
      "Model catalog": "Katalog model",
      "Model": "Model",
      "Result": "Hasil",
      "Latency": "Latensi",
      "Tokens": "Token",
      "Error": "Error",
      "none (metadata only)": "tidak ada (hanya metadata)",
      "Copy this key now": "Salin key ini sekarang",
      "This is the only time DAMAR shows this key. Core keeps only a hash.": "Ini satu-satunya kali DAMAR menampilkan key ini. Core hanya menyimpan hash-nya.",
      "Clients using this key stop working immediately.": "Klien yang memakai key ini langsung berhenti bekerja.",
      "API keys, one per line (duplicates are skipped; keys are never shown again)": "API key, satu per baris (duplikat dilewati; key tidak pernah ditampilkan lagi)",
      "Core stores each key with Windows DPAPI for this user and shows only its last 4 characters.": "Core menyimpan setiap key dengan Windows DPAPI untuk pengguna ini dan hanya menampilkan 4 karakter terakhirnya.",
      "Spends tokens: one tiny completion (max 8 output tokens), metered and covered by the model grant.": "Memakai token: satu completion kecil (maks 8 token keluaran), tercatat di meter dan dicakup model grant.",
      "round-robin: spread requests; fill-first: use keys in order (priority); lru: least recently used first. Failing keys cool down automatically.": "round-robin: sebar permintaan; fill-first: pakai key berurutan (prioritas); lru: yang paling lama tidak dipakai dulu. Key yang gagal otomatis dijeda.",
      "Add a model id (optional)": "Tambah id model (opsional)",
      "Alias name (optional)": "Nama alias (opsional)",
      "Alias points to model": "Alias menunjuk ke model",
      "Combo name (used as the model id)": "Nama combo (dipakai sebagai id model)",
      "Targets in order, one per line: connection model": "Target berurutan, satu per baris: koneksi model",
      "A combo tries its targets in order and falls back on errors. Each target still needs its connection’s model grant.": "Combo mencoba target berurutan dan beralih saat error. Setiap target tetap memerlukan model grant koneksinya.",
      "First cooldown after a failure (seconds)": "Jeda pertama setelah gagal (detik)",
      "Maximum cooldown (seconds)": "Jeda maksimum (detik)",
      "Warning: LAN mode lets other devices on your network use this gateway with a DAMAR gateway key. Keep it on “this computer only” unless you need it.": "Peringatan: mode LAN membuat perangkat lain di jaringan Anda dapat memakai gateway ini dengan key gateway DAMAR. Biarkan “hanya komputer ini” kecuali Anda membutuhkannya.",
      "Label (e.g. opencode, hermes)": "Label (mis. opencode, hermes)",
      "Allowed models and combos (comma separated, * = all)": "Model dan combo yang diizinkan (pisahkan koma, * = semua)",
      "Optional limits: requests, total tokens (blank = none)": "Batas opsional: permintaan, total token (kosong = tanpa batas)",
      "The key is shown once. Clients use it as their OpenAI API key with the gateway base URL.": "Key ditampilkan sekali. Klien memakainya sebagai OpenAI API key bersama base URL gateway."
  });
  // Provider router phase 3 strings (provider work). Existing entries win.
  (function (add) { Object.keys(add).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(ID, k)) ID[k] = add[k]; }); })({
      "Injected-token allowance": "Jatah token tersisip",
      "Max parallel requests": "Maks permintaan paralel",
      "Limits…": "Batas…",
      "Connection limits": "Batas koneksi",
      "Max parallel requests (more wait in a queue)": "Maks permintaan paralel (sisanya mengantre)",
      "Usage meter": "Meter pemakaian",
      "In flight": "Sedang berjalan",
      "reserved": "dicadangkan",
      "Total tokens": "Total token",
      "Estimated (model reports no usage)": "Perkiraan (model tidak melaporkan pemakaian)",
      "Uncertain (usage lost; charged upper bound)": "Tidak pasti (pemakaian hilang; dibebankan batas atas)",
      "Over the input bound": "Melebihi batas input",
      "Models without usage reports": "Model tanpa laporan pemakaian",
      "When": "Kapan",
      "Provider / model": "Provider / model",
      "Charged": "Dibebankan",
      "No uncertain requests.": "Tidak ada permintaan tidak pasti.",
      "The provider added hidden prompt tokens beyond the current allowance.": "Provider menambahkan token prompt tersembunyi melebihi jatah saat ini.",
      "Prompt tokens": "Token prompt",
      "bound": "batas",
      "allowance": "jatah",
      "Apply suggested allowance…": "Terapkan jatah yang disarankan…",
      "Apply suggested allowance": "Terapkan jatah yang disarankan",
      "Set the injected-token allowance of": "Atur jatah token tersisip untuk",
      "Injected-token allowance (hidden prompt tokens a router adds; default 4096)": "Jatah token tersisip (token prompt tersembunyi yang ditambahkan router; bawaan 4096)",
      "Max parallel requests per connection (default)": "Maks permintaan paralel per koneksi (bawaan)",
      "Max parallel requests per provider key": "Maks permintaan paralel per key provider",
      "Optional limits: requests, total tokens, parallel requests (blank = none; parallel default 8)": "Batas opsional: permintaan, total token, permintaan paralel (kosong = tanpa batas; paralel bawaan 8)"
  });
  function L(s) { return LANG === 'id' && Object.prototype.hasOwnProperty.call(ID, s) ? ID[s] : s; }

  // Core error codes in plain language with the fix (English / Indonesian). Unknown codes fall back to the status class.
  var ERRORS = {
    AUTHENTICATION_REQUIRED: ['Control is not signed in to DAMAR Core.', 'Open Control again from the DAMAR launcher.', 'Control belum masuk ke DAMAR Core.', 'Buka Control lagi dari launcher DAMAR.'],
    OWNER_CREDENTIAL_MISSING: ['No Owner credential was passed to Control.', 'Open Control from the DAMAR launcher.', 'Kredensial Owner tidak diberikan ke Control.', 'Buka Control dari launcher DAMAR.'],
    OWNER_REQUIRED: ['Only the Owner can do this.', 'Use the Owner launcher (not a requester credential).', 'Hanya Owner yang dapat melakukan ini.', 'Gunakan launcher Owner.'],
    CORE_UNREACHABLE: ['DAMAR Core is not running or not reachable.', 'Start DAMAR Core, then reload this page.', 'DAMAR Core tidak berjalan atau tidak terjangkau.', 'Jalankan DAMAR Core, lalu muat ulang halaman.'],
    PROVIDER_CONFIGURATION_CHANGED: ['Provider settings changed since this page loaded.', 'Review the refreshed values and try again.', 'Pengaturan provider berubah sejak halaman dimuat.', 'Periksa nilai terbaru lalu coba lagi.'],
    LIVE_MODEL_NOT_AUTHORIZED: ['This model is not covered by a model grant.', 'Providers > Grant: allow this model or * (all models).', 'Model ini belum tercakup model grant.', 'Provider > Grant: izinkan model ini atau * (semua).'],
    LIVE_INFERENCE_NOT_AUTHORIZED: ['The active provider cannot run yet.', 'Connect it and grant models in Providers, or activate an offline fixture.', 'Provider aktif belum bisa berjalan.', 'Hubungkan dan beri grant di Provider.'],
    PROVIDER_NOT_CONNECTED: ['This provider is not connected.', 'Use Connect… with its endpoint and API key.', 'Provider ini belum terhubung.', 'Gunakan Hubungkan… dengan endpoint dan API key.'],
    MODEL_GRANT_REQUEST_INVALID: ['The grant request is incomplete.', 'Enter an approval reference and a model id or *.', 'Permintaan grant belum lengkap.', 'Isi referensi persetujuan dan model atau *.'],
    MODEL_GRANT_EXPIRY_INVALID: ['The grant expiry is out of range.', 'Choose 1 to 365 days.', 'Masa berlaku grant di luar batas.', 'Pilih 1 sampai 365 hari.'],
    MODEL_GRANT_LIMITS_INVALID: ['Grant limits must be positive whole numbers.', 'Leave limits blank for none, or enter numbers.', 'Batas grant harus bilangan bulat positif.', 'Kosongkan untuk tanpa batas.'],
    SESSION_ATTACHED_ELSEWHERE: ['A CLI window is using this session.', 'Close that CLI window or wait 15 seconds.', 'Jendela CLI sedang memakai sesi ini.', 'Tutup jendela CLI itu atau tunggu 15 detik.'],
    SESSION_NOT_ATTACHED: ['Control lost its session lease.', 'Try again; Control re-attaches automatically.', 'Control kehilangan lease sesi.', 'Coba lagi.'],
    WORKSPACE_INVALID: ['That folder cannot be used.', 'Enter an existing absolute folder outside protected locations.', 'Folder itu tidak dapat dipakai.', 'Masukkan folder absolut yang ada, di luar lokasi terlindungi.'],
    PRESENCE_SETTINGS_INVALID: ['A presence value is out of range.', 'Check the delays and choices, then save again.', 'Nilai presence di luar batas.', 'Periksa lalu simpan lagi.'],
    CLI_SETTINGS_INVALID: ['A CLI setting is not valid.', 'Choose one of the listed options.', 'Pengaturan CLI tidak valid.', 'Pilih salah satu opsi.'],
    QUEUE_FULL: ['Core is busy with queued work.', 'Wait for runs to finish, then try again.', 'Core sedang sibuk.', 'Tunggu run selesai lalu coba lagi.'],
    RUN_NOT_FOUND: ['That run no longer exists.', 'Refresh the run list.', 'Run itu tidak ada lagi.', 'Muat ulang daftar run.'],
    ALREADY_TERMINAL: ['That run has already finished.', 'Nothing to cancel.', 'Run itu sudah selesai.', 'Tidak ada yang dibatalkan.']
  };
  var STATUS_TEXT = { 0: ['DAMAR Core is not reachable.', 'Start DAMAR Core, then reload.'], 400: ['Core rejected the request as invalid.', 'Check the fields and try again.'],
    401: ['Control is not signed in to DAMAR Core.', 'Open Control again from the DAMAR launcher.'], 403: ['Only the Owner can do this.', 'Use the Owner launcher.'],
    404: ['Core could not find that item.', 'Refresh and try again.'], 409: ['Core state changed or conflicts with this action.', 'Review the refreshed values and try again.'],
    413: ['The request is too large.', 'Shorten the input.'], 429: ['Core rate or queue limit reached.', 'Wait a moment and try again.'], 503: ['Core cannot do this right now.', 'Try again shortly.'] };
  function describeFailure(res) {
    if (!res || res.ok) return '';
    var e = ERRORS[res.error], s = STATUS_TEXT[res.status] || STATUS_TEXT[Math.floor((res.status || 0) / 100) * 100] || ['Core could not complete this action.', 'Try again.'];
    var text = e ? (LANG === 'id' ? e[2] + ' ' + e[3] : e[0] + ' ' + e[1]) : s[0] + ' ' + s[1];
    return text + ' (' + (res.error || 'HTTP_' + res.status) + ')';
  }

  // Model-grant body from the form: '*' or one model, 1-365 days, limits optional (blank = none; any subset).
  function grantRequest(provider, baseUrl, approval, model, days, limitsText, now) {
    var body = { approval: approval, provider: provider, baseUrl: baseUrl, model: model || '*', expiresAt: now + Math.round(Number(days) * 86400000) };
    var names = ['completions', 'maxTokens', 'totalTokens'], limits = {};
    String(limitsText || '').split(',').forEach(function (x, i) { x = x.trim(); if (x && names[i]) limits[names[i]] = Number(x); });
    if (Object.keys(limits).length) body.limits = limits;
    return body;
  }
  var READS = {
    provider: '/api/r9/provider', budget: '/api/r9/provider/budget', grant: '/api/r9/provider/model-grant', padmin: '/api/r9/provider-admin/state', oauth: '/api/r9/oauth',
    lifecycle: '/api/r9/lifecycle', sandbox: '/api/r9/sandbox', runs: '/api/r9/pandawa/runs', sessions: '/api/r9/sessions',
    tools: '/api/v1/console/tools', plugins: '/api/v1/console/plugins', mcp: '/api/v1/console/mcp/servers',
    presence: '/api/r9/presence/settings', cliSettings: '/api/r9/cli/settings', discussions: '/api/r9/pandawa/discussions', agents: '/api/v1/console/agents', safety: '/api/v1/console/safety', memoryStats: '/api/v1/console/memory/stats', context: '/api/v1/console/context', activityFeed: '/api/r9/activity'
  };
  var UNAVAILABLE = {
    matadewa: { title: 'Mata Dewa', kicker: 'DAMAR INTELLIGENCE • SYSTEM OBSERVABILITY', why: 'Tampilan Mata Dewa belum termuat. Data Mata Dewa disajikan Core lewat tampilannya sendiri; muat ulang halaman ini.' },
    cyber: { title: 'Damar Cyber', kicker: 'DAMAR INTELLIGENCE • SECURITY POSTURE', why: 'Mesin deteksi siber Damar (DCD) ada di Core, tetapi data posturnya belum terhubung ke Control. Saat ini tidak ada data insiden yang mengalir ke halaman ini.' },
    automations: { title: 'Otomasi', kicker: 'WORKSPACE • SCHEDULED WORK', why: 'Core belum memiliki rute otomasi untuk Control. Penjadwalan yang berjalan saat ini hanya brief harian di layanan daemon, dan belum terhubung ke halaman ini.' },
    logs: { title: 'Log', kicker: 'DEVELOPMENT • CORE LOGS', why: 'Log Core belum termuat.' }
  };

  // ==========================================================================
  // 2. STATE
  // ==========================================================================
  var state = {
    activeView: 'overview', sidebarCollapsed: false, mobileDrawerOpen: false, capabilityFilter: 'Tools',
    core: {}, models: {}, loaded: false, endpoint: '', usage: {}, checkpoints: {}, memory: null, settings: null, diagnostics: null, kapabilitas: null,
    picker: { open: {}, tests: {}, groupMsg: {}, advanced: false },
    control: { id: null, client: null, held: {} }, workspace: ''
  };
  var core = null;
  var TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN'];
  var LIVE = { ok: function (k) { return !!(state.core[k] && state.core[k].ok); }, d: function (k) { return state.core[k] && state.core[k].ok ? state.core[k].data : null; } };

  // ==========================================================================
  // 3. MARKUP HELPERS (prototype classes only)
  // ==========================================================================
  function statusBadgeHtml(status, customLabel) {
    var s = String(status || '').toUpperCase(), cls = 'badge-neutral', dot = 'dot-neutral';
    if (['HEALTHY', 'READY', 'COMPLETED', 'CONFIRMED', 'EXECUTABLE', 'ACTIVE', 'ONLINE', 'TRUSTED', 'PASS', 'OK'].indexOf(s) >= 0) { cls = 'badge-healthy'; dot = 'dot-healthy'; }
    else if (['RUNNING', 'ACCEPTED', 'QUEUED', 'STARTING', 'RESUMING', 'RESTARTING', 'ATTACHED', 'PENDING', 'WARN'].indexOf(s) >= 0) { cls = 'badge-simulated'; dot = 'dot-simulated'; }
    else if (['FAILED', 'ERROR', 'BLOCKED', 'STOPPED', 'OFFLINE', 'UNAVAILABLE', 'DENIED', 'CANCELLED', 'OUTCOME_UNKNOWN', 'UNREACHABLE', 'NOT_AVAILABLE'].indexOf(s) >= 0) { cls = 'badge-blocked'; dot = 'dot-blocked'; }
    else if (['NOT_CONFIGURED', 'DISABLED', 'INFO', 'CLOSED', 'IDLE', 'UNMANAGED'].indexOf(s) >= 0) { cls = 'badge-review'; dot = 'dot-info'; }
    return '<span class="badge ' + cls + '"><span class="status-dot ' + dot + '" aria-hidden="true"></span>' + escapeHtml(L(customLabel || s)) + '</span>';
  }
  function pageHeader(kicker, title, subtitle, actions) {
    return '<div class="page-header"><div class="page-title-group"><h1 class="page-title">' + escapeHtml(L(title)) + '</h1>' +
      (subtitle ? '<p class="page-subtitle">' + escapeHtml(L(subtitle)) + '</p>' : '') + '</div>' + (actions ? '<div class="page-actions">' + actions + '</div>' : '') + '</div>';
  }
  function panel(title, body, opts) {
    opts = opts || {};
    return '<section class="' + (opts.span ? 'col-span-' + opts.span + ' ' : '') + 'panel"><div class="panel-header"><div class="panel-title-wrap"><h2 class="panel-title">' + escapeHtml(L(title)) + '</h2></div>' +
      (opts.badge || '') + (opts.subtitle ? '<span class="panel-subtitle">' + escapeHtml(L(opts.subtitle)) + '</span>' : '') + '</div>' +
      '<div class="' + (opts.flush ? 'panel-body-flush table-responsive' : 'panel-body') + '">' + body + '</div></section>';
  }
  function kv(label, value, mono) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted);">' + escapeHtml(L(label)) + '</span><span style="' +
      (mono ? 'font-family:var(--font-mono);color:var(--damar-gold-bright);' : 'color:var(--text-ivory);') + 'text-align:right;overflow-wrap:anywhere;">' + escapeHtml(value) + '</span></div>';
  }
  function kvList(rows) { return '<div style="display:flex;flex-direction:column;gap:10px;font-size:12px;">' + rows.join('') + '</div>'; }
  function table(headers, rows, empty) {
    if (!rows.length) return '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">' + escapeHtml(L(empty || 'Nothing reported by Core.')) + '</div>';
    return '<table class="data-table"><thead><tr>' + headers.map(function (h) { return '<th scope="col">' + escapeHtml(L(h)) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  }
  function mono(v) { return '<span style="font-family:var(--font-mono);font-size:11.5px;">' + escapeHtml(v) + '</span>'; }
  function tile(label, badge, value, tag, meta, jump) {
    return '<div class="signal-tile"' + (jump ? ' data-jump-view="' + jump + '"' : '') + '><div class="signal-top"><span class="signal-label">' + escapeHtml(L(label)) + '</span>' + badge + '</div>' +
      '<div class="signal-value-row"><div class="signal-value">' + escapeHtml(value) + '</div><span class="signal-index-tag">' + escapeHtml(tag) + '</span></div>' +
      '<div class="signal-meta"><span>' + escapeHtml(meta) + '</span></div></div>';
  }
  // Uniform rendering of a read that is loading, failed, or not served.
  function readState(key, label) {
    var r = state.core[key];
    if (!r) return '<div style="padding:14px;color:var(--text-muted);font-size:12px;">Loading ' + escapeHtml(label) + ' from Core…</div>';
    if (!r.ok) return '<div style="padding:14px;font-size:12px;">' + statusBadgeHtml('UNAVAILABLE', 'Core ' + (r.status || 'offline')) + ' <span style="color:var(--text-secondary);">' + escapeHtml(label) + ': ' + escapeHtml(r.error) + '</span></div>';
    return null;
  }
  function when(ms) { if (!ms) return '-'; var d = new Date(typeof ms === 'number' ? ms : Date.parse(ms)); return isNaN(d) ? '-' : d.toLocaleString(); }
  function num(v) { return v === null || v === undefined ? '-' : String(v); }
  function btn(label, attrs, kind) { return '<button type="button" class="btn ' + (kind || 'btn-secondary') + ' btn-sm" ' + attrs + '>' + escapeHtml(L(label)) + '</button>'; }

  function liveStrip() {
    var lc = LIVE.d('lifecycle'), pv = LIVE.d('provider'), sf = LIVE.d('safety');
    var st = lc ? lc.state.state : (state.core.lifecycle ? 'UNREACHABLE' : 'CONNECTING');
    return '<div class="governance-strip" role="region" aria-label="Live Core status"><div class="gov-strip-items">' +
      '<span class="badge badge-gold">Live DAMAR Core · ' + escapeHtml(state.endpoint || 'same origin') + '</span>' +
      '<span class="gov-kv"><span class="gov-k">Lifecycle:</span><span class="gov-v">' + escapeHtml(st) + '</span></span>' +
      '<span class="gov-kv"><span class="gov-k">Active provider:</span><span class="gov-v">' + escapeHtml(pv ? pv.active + ' / ' + (pv.model || 'no model') : '-') + '</span></span>' +
      '<span class="gov-kv"><span class="gov-k">Live inference:</span><span class="gov-v" style="color:' + (pv && pv.liveInference ? 'var(--status-success)' : 'var(--status-critical)') + ';">' + (pv ? (pv.liveInference ? 'AUTHORIZED' : 'NOT AUTHORIZED') : '-') + '</span></span>' +
      '<span class="gov-kv"><span class="gov-k">Emergency stop:</span><span class="gov-v">' + (sf ? (sf.stopped ? 'ENGAGED' : 'OFF') : '-') + '</span></span>' +
      '</div><button type="button" class="btn btn-ghost btn-sm" data-jump-view="runtime">Inspect Runtime →</button></div>';
  }

  // ==========================================================================
  // 4. NAVIGATION (prototype groups; labels map to real Core data)
  // ==========================================================================
  var NAV_GROUPS = [
    { group: 'Workspace', items: [
      { id: 'overview', label: 'Overview', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>' },
      { id: 'activity', label: 'Sessions', icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>', badgeFn: function () { var d = LIVE.d('sessions'); return d ? d.sessions.length : null; } },
      { id: 'tasks', label: 'Usage', icon: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>' },
      { id: 'automations', label: 'Automations', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.93 4.93l2.12 2.12m9.9 9.9l2.12 2.12M2 12h3m14 0h3M4.93 19.07l2.12-2.12m9.9-9.9l2.12-2.12"/>' }
    ] },
    { group: 'AI Infrastructure', items: [
      { id: 'capabilities', label: 'Capabilities Hub', icon: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>', badgeFn: function () { var d = LIVE.d('tools'); return d ? d.total : null; } },
      { id: 'models', label: 'Models', icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },
      { id: 'providers', label: 'Providers', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>', badgeFn: function () { var d = LIVE.d('provider'); return d ? d.providers.filter(function (p) { return p.executable; }).length + ' exec' : null; }, badgeClass: 'badge-warn' },
      { id: 'skills', label: 'Skills', icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
      { id: 'plugins', label: 'Plugins', icon: '<path d="M12 2v4m-4-2v4m8-4v4M6 6h12a2 2 0 0 1 2 2v5a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6V8a2 2 0 0 1 2-2zm4 13v3m4-3v3"/>' },
      { id: 'mcp', label: 'MCP Servers', icon: '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>' }
    ] },
    { group: 'DAMAR Intelligence', items: [
      { id: 'discussions', label: 'Discussions', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', badgeFn: function () { var d = LIVE.d('discussions'); return d ? d.discussions.filter(function (x) { return x.state === 'RUNNING'; }).length + ' live' : null; } },
      { id: 'pandawa', label: 'Pandawa', icon: '<circle cx="12" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><line x1="10.5" y1="8.5" x2="7.5" y2="15.5"/><line x1="13.5" y1="8.5" x2="16.5" y2="15.5"/><line x1="9" y1="18" x2="15" y2="18"/>', badgeFn: function () { var d = LIVE.d('runs'); return d ? d.runs.filter(function (r) { return TERMINAL.indexOf(r.state) < 0; }).length + ' active' : null; } },
      { id: 'matadewa', label: 'Mata Dewa', icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' },
      { id: 'cyber', label: 'Damar Cyber', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
      { id: 'memory', label: 'Memory & Continuity', icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' }
    ] },
    { group: 'Development', items: [
      { id: 'cli', label: 'Damar CLI', icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
      { id: 'runtime', label: 'Runtime', icon: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>' },
      { id: 'logs', label: 'Logs', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
      { id: 'diagnostics', label: 'Diagnostics', icon: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' }
    ] },
    { group: 'Administration', items: [
      { id: 'security', label: 'Security & Governance', icon: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', badgeFn: function () { var d = LIVE.d('safety'); return d ? (d.stopped ? 'STOP' : d.risk.destructive + ' destr.') : null; }, badgeClass: 'badge-crit' },
      { id: 'settings', label: 'Settings', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>' }
    ] }
  ];

  // ==========================================================================
  // 5. VIEW RENDERERS (pure: state -> HTML)
  // ==========================================================================
  function renderOverviewView() {
    var lc = LIVE.d('lifecycle'), pv = LIVE.d('provider'), runs = LIVE.d('runs'), ss = LIVE.d('sessions'), bd = LIVE.d('budget'), tl = LIVE.d('tools');
    var out = lc ? lc.outstanding : null;
    var active = runs ? runs.runs.filter(function (r) { return TERMINAL.indexOf(r.state) < 0; }).length : null;
    var tokens = ss ? ss.sessions.reduce(function (n, s) { return n + (s.tokens && s.tokens.total || 0); }, 0) : null;
    var html = '<div class="page-header"><div class="page-title-group">' +
      '<h1 class="page-title" style="display:flex;align-items:center;gap:12px;"><img src="damaricon-clean.png" alt="DAMAR" style="width:32px;height:36px;object-fit:contain;filter:drop-shadow(0 0 8px rgba(247,223,148,0.5));" /><span><span class="gold-gradient-text">DAMAR</span> Control Center</span></h1>' +
      '<p class="page-subtitle">' + escapeHtml(L('Manage intelligence, runtime operations, tools and system governance.')) + '</p></div>' +
      '<div class="page-actions"><button type="button" class="btn btn-secondary" data-jump-view="activity"><span>' + escapeHtml(L('View Sessions')) + '</span></button><button type="button" class="btn btn-primary" data-jump-view="pandawa"><span>' + escapeHtml(L('Pandawa Runs')) + '</span></button></div></div>';
    html += liveStrip();
    html += onboarding();
    html += '<div class="status-strip-grid">';
    html += tile('Runtime State', statusBadgeHtml(lc ? lc.state.state : 'UNREACHABLE'), lc ? lc.state.state : '-', 'SYS-01', lc ? 'Updated ' + when(lc.state.updatedAt) : readErr('lifecycle'), 'runtime');
    html += tile('Outstanding Work', statusBadgeHtml(out && (out.activeTurns || out.activePandawaRuns || out.activeJobs) ? 'RUNNING' : 'IDLE'), out ? String(out.activeTurns + out.activePandawaRuns + out.activeJobs) : '-', 'SYS-02', out ? out.activeTurns + ' turns • ' + out.activePandawaRuns + ' runs • ' + out.activeJobs + ' jobs' : readErr('lifecycle'), 'runtime');
    html += tile('Active Provider', statusBadgeHtml(pv ? (pv.executable ? 'EXECUTABLE' : 'BLOCKED') : 'UNAVAILABLE'), pv ? pv.active : '-', 'SYS-03', pv ? (pv.model || 'no model') : readErr('provider'), 'providers');
    html += tile('Pandawa Runs', statusBadgeHtml(active ? 'RUNNING' : 'IDLE', active === null ? '-' : active + ' active'), runs ? String(runs.runs.length) : '-', 'SYS-04', runs ? runs.queued + ' queued (last 32 shown)' : readErr('runs'), 'pandawa');
    html += tile('Session Tokens', statusBadgeHtml(ss ? 'CONFIRMED' : 'UNAVAILABLE', 'Core receipts'), tokens === null ? '-' : String(tokens), 'SYS-05', ss ? ss.sessions.length + ' sessions • cost unavailable' : readErr('sessions'), 'tasks');
    html += tile('Capabilities', statusBadgeHtml(tl ? 'READY' : 'UNAVAILABLE'), tl ? String(tl.total) : '-', 'SYS-06', tl ? 'tools registered in Core' : readErr('tools'), 'capabilities');
    html += '</div>';
    html += '<div class="workspace-grid-12">';
    html += panel('Recent Pandawa Runs', runsTable(runs ? runs.runs.slice(-6).reverse() : [], !runs), { span: 7, flush: true, subtitle: 'From Core run ledger' });
    html += panel('Provider Budget', readState('budget', 'budget') || kvList([kv('Mode', bd.mode), kv('Attempts', num(bd.attempts)), kv('Total tokens', num(bd.totalTokens)), kv('Blocked', bd.blocked ? 'YES' : 'no')]), { span: 5 });
    html += '</div>';
    return html;
  }
  // First run: connect a provider -> allow models (grant '*') -> start the CLI. Each step is derived from Core state.
  function onboarding() {
    var pv = LIVE.d('provider'), gr = LIVE.d('grant'), ss = LIVE.d('sessions');
    if (!pv || state.onboardingHidden) return '';
    var live = pv.providers.filter(function (p) { return p.kind === 'live'; });
    var connected = live.length > 0;
    var granted = live.some(function (p) { return p.grantStatus === 'granted'; }), started = !!(ss && ss.sessions.length);
    if (connected && granted && started) return '';
    var step = function (n, done, title, text, action) {
      return '<li style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--border-subtle);">' + statusBadgeHtml(done ? 'COMPLETED' : 'PENDING', done ? 'Done' : String(n)) +
        '<div style="flex:1;"><div style="font-weight:600;color:var(--text-ivory);">' + escapeHtml(L(title)) + '</div><div style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(text) + '</div></div>' + (done ? '' : action) + '</li>';
    };
    var id = LANG === 'id';
    return panel('Get started', '<ol style="list-style:none;margin:0;padding:0;">' +
      step(1, connected, 'Connect a model provider', id ? 'Endpoint OpenAI-compatible pilihan Anda (cloud atau lokal). API key dikirim ke Core sekali dan tidak pernah ditampilkan lagi.' : 'Any OpenAI-compatible endpoint you choose (cloud or local). The API key goes to Core once and is never shown again.', btn('Connect…', 'data-onboard="connect"', 'btn-primary')) +
      step(2, granted, 'Allow models (grant *)', id ? 'Model grant mengizinkan inferensi live. Default: semua model (*), 30 hari, tanpa batas tambahan.' : 'A model grant allows live inference. Default: every model (*), 30 days, no extra limits.', btn('Grant…', 'data-onboard="grant"', 'btn-primary')) +
      step(3, started, 'Start the DAMAR CLI', id ? 'Jalankan damar.cmd di terminal. Sesi CLI akan muncul di sini.' : 'Run damar.cmd in a terminal. Its sessions appear here.', mono('damar.cmd')) + '</ol>',
      { badge: btn('Hide', 'data-hide-onboarding="1"', 'btn-ghost') });
  }
  function readErr(k) { var r = state.core[k]; return r && !r.ok ? 'Core: ' + r.error : 'loading…'; }

  function runsTable(list, loading) {
    if (loading) return readState('runs', 'Pandawa runs') || '';
    return table(['Run', 'Worker', 'State', 'Provider / model', 'Attempts', 'Result', ''], list.map(function (r) {
      return [mono(r.runId), '<span style="font-weight:700;color:var(--damar-gold-bright);">' + escapeHtml(r.worker) + '</span>', statusBadgeHtml(r.state) + (r.cancelRequested ? ' <span class="badge badge-review">cancel requested</span>' : ''),
        escapeHtml((r.provider || '-') + ' / ' + (r.model || '-')), '<span class="td-num">' + num(r.attempts) + '</span>',
        '<span style="font-size:11.5px;color:var(--text-secondary);">' + escapeHtml(r.error || r.reason || r.outputPreview || '') + '</span>',
        TERMINAL.indexOf(r.state) < 0 && !r.cancelRequested ? btn('Cancel', 'data-cancel-run="' + escapeHtml(r.runId) + '"', 'btn-danger') : ''];
    }), 'No Pandawa runs recorded in this Core session.');
  }

  function renderSessionsView() {
    var ss = LIVE.d('sessions');
    var html = pageHeader('WORKSPACE • CORE SESSION LEDGER', 'Sessions', 'CLI and Control sessions recorded by Core (append-only ledger). Open a session to inspect its conversation, operations and usage.');
    if (!ss) return html + panel('Sessions', readState('sessions', 'sessions'), { flush: true });
    if (ss.ledger && (ss.ledger.corruptLines.length || ss.ledger.tornTail)) html += '<div class="governance-strip"><div class="gov-strip-items">' + statusBadgeHtml('WARN', 'Ledger disclosure') + '<span class="gov-kv"><span class="gov-k">Corrupt lines:</span><span class="gov-v">' + escapeHtml(ss.ledger.corruptLines.join(', ') || 'none') + '</span></span><span class="gov-kv"><span class="gov-k">Torn tail:</span><span class="gov-v">' + (ss.ledger.tornTail ? 'yes' : 'no') + '</span></span></div></div>';
    html += panel('Session Ledger', table(['Title', 'Session', 'Workspace', 'Model', 'State', 'Tokens', 'Updated', ''], ss.sessions.map(function (s) {
      return ['<span style="color:var(--text-ivory);font-weight:600;">' + escapeHtml(s.title) + '</span>', mono(s.sessionId.slice(0, 12) + '…'), '<span style="font-size:11.5px;">' + escapeHtml(s.cwd) + '</span>',
        escapeHtml((s.provider || '-') + ' / ' + (s.model || '-')), statusBadgeHtml(s.closed ? 'CLOSED' : s.attached ? 'ATTACHED' : 'IDLE') + (s.unresolvedOperations.length ? ' ' + statusBadgeHtml('OUTCOME_UNKNOWN', s.unresolvedOperations.length + ' unknown') : ''),
        '<span class="td-num">' + num(s.tokens.total) + (s.tokens.complete ? '' : ' <span style="color:var(--text-muted);">(incomplete)</span>') + '</span>', escapeHtml(when(s.updatedAt)),
        btn('Inspect', 'data-inspect-session="' + escapeHtml(s.sessionId) + '"')];
    }), 'No sessions yet. Sessions are created by the DAMAR CLI.'), { flush: true, subtitle: ss.sessions.length + ' sessions' });
    return html;
  }

  function renderUsageView() {
    var ss = LIVE.d('sessions'), bd = LIVE.d('budget');
    var html = pageHeader('WORKSPACE • TOKEN RECEIPTS', 'Usage', 'Token usage from Core durable receipts per session. Cost is shown only when Core has rate provenance.');
    html += '<div class="workspace-grid-12">';
    var bdLimits = (bd && bd.limits) || {};
    var bdLimit = function (v) { return v == null ? L('Tanpa batas') : num(v); };
    html += panel('Provider Budget', readState('budget', 'budget') || kvList([kv('Attempts', num(bd.attempts)), kv('Tokens used', num(bd.totalTokens)), kv('Blocked', bd.blocked ? L('Yes') : L('No')),
      kv('Runaway guard, total tokens', bdLimit(bdLimits.totalTokens)), kv('Runaway guard, per request', bdLimit(bdLimits.maxTokens)), kv('Runaway guard, requests', bdLimit(bdLimits.completions)),
      kv('Usage reporting', bd.usageReporting && Object.keys(bd.usageReporting).length ? L('Recorded by Core') : '-')]), { span: 4 });
    var rows = ss ? ss.sessions.map(function (s) {
      var u = state.usage[s.sessionId];
      return ['<span style="color:var(--text-ivory);">' + escapeHtml(s.title) + '</span>', mono(s.sessionId.slice(0, 12) + '…'),
        u ? (u.ok ? '<span class="td-num">' + num(u.data.inputTokens) + ' / ' + num(u.data.outputTokens) + '</span>' : statusBadgeHtml('ERROR', u.error)) : '<span class="td-num">' + num(s.tokens.input) + ' / ' + num(s.tokens.output) + '</span>',
        u && u.ok ? escapeHtml(u.data.confirmedReceipts + ' confirmed, ' + u.data.unknownUsageReceipts + ' unknown') : '-',
        u && u.ok ? escapeHtml(typeof u.data.cost === 'number' ? num(u.data.cost) : L('Unavailable')) : 'UNAVAILABLE', u && u.ok ? statusBadgeHtml(u.data.complete ? 'CONFIRMED' : 'PENDING', u.data.complete ? 'complete' : 'incomplete') : btn('Load receipts', 'data-load-usage="' + escapeHtml(s.sessionId) + '"')];
    }) : [];
    html += panel('Per-session usage', ss ? table(['Session', 'Id', 'In / Out tokens', 'Receipts', 'Cost', 'Status'], rows, 'No sessions recorded.') : readState('sessions', 'sessions'), { span: 8, flush: true });
    // Confirmed tokens per Pandawa member (Core usage receipts, byMember) for the sessions whose receipts are loaded.
    var members = {};
    Object.keys(state.usage).forEach(function (sid) { var u = state.usage[sid]; if (u && u.ok && u.data.byMember) Object.keys(u.data.byMember).forEach(function (m) { var b = u.data.byMember[m], t = members[m] || (members[m] = { inputTokens: 0, outputTokens: 0, receipts: 0 }); t.inputTokens += b.inputTokens; t.outputTokens += b.outputTokens; t.receipts += b.receipts; }); });
    html += panel('Usage by Pandawa member', table(['Member', 'In / Out tokens', 'Receipts'], Object.keys(members).sort().map(function (m) { return [escapeHtml(m), '<span class="td-num">' + members[m].inputTokens + ' / ' + members[m].outputTokens + '</span>', '<span class="td-num">' + members[m].receipts + '</span>']; }),
      'Load a session\'s receipts to see which Pandawa member used how many tokens.'), { span: 12, flush: true });
    html += '</div>';
    return html;
  }

  function renderCapabilitiesView(forced) {
    var tab = forced || state.capabilityFilter || 'Tools';
    var html = pageHeader('AI INFRASTRUCTURE • CAPABILITIES', 'Capabilities Hub', 'Kelola tool, plugin, agen, skill, dan server MCP yang terdaftar di DAMAR Core. Penambahan dan penghapusan berjalan lewat registry dan loader kanonis Core; rahasia tidak pernah ditampilkan.',
      '<div class="segmented-tabs">' + ['Tools', 'Plugins', 'Agents', 'Skills', 'MCP'].map(function (t) { return '<button type="button" class="seg-tab' + (t === tab ? ' active' : '') + '" data-cap-tab="' + t + '">' + escapeHtml(L(t)) + '</button>'; }).join('') + '</div>');
    var body;
    if (tab === 'Tools') { var t = LIVE.d('tools'); body = t ? table(['Tool', 'Plugin', 'Description'], t.tools.map(function (x) { return [mono(x.id), escapeHtml(x.pluginId), '<span style="font-size:11.5px;color:var(--text-secondary);">' + escapeHtml(x.description) + '</span>']; })) : readState('tools', 'tools'); }
    else if (tab === 'Plugins') {
      var kapP = state.kapabilitas; if (!kapP) ensureKapabilitas();
      var addBarP = '<div style="display:flex;justify-content:flex-end;margin:0 0 10px;">' + btn('+ Pasang plugin…', 'data-kap-plugin-add="1"', 'btn-primary') + '</div>';
      if (kapP && kapP.ok) {
        body = addBarP + table(['Plugin', 'Versi', 'Sumber', 'Status', 'Tool', ''], kapP.data.plugins.items.map(function (x) {
          var status = x.loaded ? statusBadgeHtml('ACTIVE', 'Dimuat') : (x.valid === false ? statusBadgeHtml('ERROR', 'Manifest tidak valid') : statusBadgeHtml('DISABLED', 'Tidak dimuat'));
          var acts = x.source === 'user' && x.id ? btn(x.loaded ? 'Nonaktifkan' : 'Aktifkan', 'data-kap-plugin-toggle="' + escapeHtml(x.id) + '" data-enabled="' + (x.loaded ? 'true' : 'false') + '"') + ' ' + btn('Hapus', 'data-kap-plugin-remove="' + escapeHtml(x.id) + '"', 'btn-danger') : '<span style="font-size:11.5px;color:var(--text-muted);">' + escapeHtml(L('Bawaan Core')) + '</span>';
          return ['<span style="color:var(--text-ivory);font-weight:600;">' + escapeHtml(x.name) + '</span>', mono(x.version || '-'), escapeHtml(x.source === 'user' ? L('Pengguna') : L('Bawaan')), status, '<span class="td-num">' + num(x.toolCount) + '</span>', acts];
        }), 'Belum ada plugin yang terdaftar di Core.') + (kapP.data.plugins.items.some(function (x) { return x.valid === false; }) ? '<p style="padding:10px 14px;font-size:12px;color:var(--text-secondary);">' + escapeHtml(L('Plugin bertanda manifest tidak valid terpasang di folder pengguna tetapi ditolak loader. Hapus dari daftar di atas atau perbaiki manifestnya.')) + '</p>' : '');
      } else { var p = LIVE.d('plugins'); body = addBarP + (kapP && !kapP.ok ? '<div style="padding:10px 14px;font-size:12px;">' + statusBadgeHtml('ERROR', kapP.error) + '</div>' : '') + (p ? table(['Plugin', 'Version', 'Category', 'Tools', 'Permissions', 'Description'], p.plugins.map(function (x) { return ['<span style="color:var(--text-ivory);font-weight:600;">' + escapeHtml(x.name) + '</span>', mono(x.version), escapeHtml(x.category), '<span class="td-num">' + num(x.toolCount) + '</span>', escapeHtml((x.permissions || []).join(', ') || '-'), '<span style="font-size:11.5px;color:var(--text-secondary);">' + escapeHtml(x.description) + '</span>']; })) : readState('plugins', 'plugins')); }
    }
    else if (tab === 'Agents') { var a = LIVE.d('agents'); body = a ? table(['Agent', 'Kind', 'Online', 'Description'], a.agents.map(function (x) { return ['<span style="color:var(--damar-gold-bright);font-weight:700;">' + escapeHtml(x.label || x.id) + '</span>', escapeHtml(x.kind), statusBadgeHtml(x.online ? 'ONLINE' : 'OFFLINE'), '<span style="font-size:11.5px;color:var(--text-secondary);">' + escapeHtml(shortRole(x)) + '</span>']; })) : readState('agents', 'agents'); }
    else if (tab === 'MCP') {
      var m = LIVE.d('mcp');
      var kapM = state.kapabilitas; if (!kapM) ensureKapabilitas();
      var addBarM = '<div style="display:flex;justify-content:flex-end;margin:10px 0 0;">' + btn('+ Tambah server MCP…', 'data-kap-mcp-add="1"', 'btn-primary') + '</div>';
      var noteM = '<p style="padding:10px 14px;font-size:12px;color:var(--text-secondary);">' + escapeHtml(L('Registry MCP Damar memakai transport stdio: server adalah proses lokal yang dijalankan Core lewat perintahnya. Server yang tersimpan langsung dijalankan; registry tidak memiliki status nonaktif, jadi menonaktifkan server berarti menghapusnya dari registry.')) + '</p>';
      var srvTable;
      if (kapM && kapM.ok) srvTable = table(['Server', 'Perintah', 'Status', 'Tool', ''], kapM.data.mcp.servers.map(function (x) {
        return ['<span style="color:var(--text-ivory);font-weight:600;">' + escapeHtml(x.id) + '</span>', mono(x.command + (x.args && x.args.length ? ' ' + x.args.join(' ') : '')), statusBadgeHtml(x.running ? 'RUNNING' : 'IDLE', x.running ? 'Berjalan' : 'Terkonfigurasi'), escapeHtml((x.tools || []).join(', ') || (x.lastError ? String(x.lastError) : '-')), btn('Hapus', 'data-kap-mcp-remove="' + escapeHtml(x.id) + '"', 'btn-danger')];
      }), 'Belum ada server MCP klien yang terkonfigurasi di Core.');
      else srvTable = m ? table(['Server', 'Transport / command', 'State', 'Environment'], (m.servers || []).map(function (x) {
        return [escapeHtml(x.name || x.id), mono(x.command || x.url || x.transport || '-'), statusBadgeHtml(x.online ? 'RUNNING' : 'IDLE'), escapeHtml(x.env ? Object.keys(x.env).map(function (k) { return k + '=' + REDACTED; }).join(', ') : '-')];
      }), 'No MCP client servers configured in Core.') : readState('mcp', 'MCP servers');
      body = (m ? kvList([kv('DAMAR MCP server', m.server ? m.server.name : '-'), kv('Exposed tools', m.server ? m.server.exposed + ' of ' + m.server.total + (m.server.destructiveHidden ? ' (destructive hidden)' : '') : '-'), kv('Client servers running', m.clients ? m.clients.running + ' running, ' + m.clients.bridged + ' bridged' : '-')]) : '') + addBarM + '<div style="margin-top:12px;">' + srvTable + '</div>' + noteM;
    } else {
      var st = state.settings;
      if (!st) ensureSettings();
      var addBarS = '<div style="display:flex;justify-content:flex-end;margin:0 0 10px;">' + btn('+ Impor skill…', 'data-kap-skill-add="1"', 'btn-primary') + '</div>';
      body = addBarS + (st && st.ok ? table(['Skill', 'Source', 'Enabled', 'Triggers', ''], (st.data.availableSkills || []).map(function (x) {
        var acts = btn(x.enabled ? 'Nonaktifkan' : 'Aktifkan', 'data-kap-skill-toggle="' + escapeHtml(x.name) + '" data-enabled="' + (x.enabled ? 'true' : 'false') + '"') + (x.source === 'profile' ? ' ' + btn('Hapus', 'data-kap-skill-remove="' + escapeHtml(x.name) + '"', 'btn-danger') : '');
        return [escapeHtml(x.name), escapeHtml(x.source), statusBadgeHtml(x.enabled ? 'ACTIVE' : 'DISABLED'), escapeHtml((x.triggers || []).join(', ')), acts];
      }), 'No skills installed.')
        : '<div style="padding:14px;font-size:12px;color:var(--text-secondary);">' + escapeHtml(L(st ? 'Gagal membaca skill dari Core.' : 'Memuat skill dari Core…')) + ' ' + (st ? statusBadgeHtml('ERROR', st.error) : '') + '</div>');
    }
    return html + panel(tab, body, { flush: true });
  }

  function renderModelsView() {
    var pv = LIVE.d('provider');
    var html = pageHeader('AI INFRASTRUCTURE • MODEL CATALOG', 'Models', 'Models each provider offers (metadata only). Activating a model is an Owner action Core validates against the current configuration version.');
    if (!pv) return html + panel('Models', readState('provider', 'providers'));
    var rows = [];
    pv.providers.forEach(function (p) {
      var m = state.models[p.id];
      if (!m) rows.push([escapeHtml(p.label), '<span style="color:var(--text-muted);">loading…</span>', '', '', '']);
      else if (!m.ok) rows.push([escapeHtml(p.label), statusBadgeHtml('UNAVAILABLE', m.error), '', '', '']);
      else if (!m.data.models.length) rows.push([escapeHtml(p.label), '<span style="color:var(--text-muted);">no models listed</span>', '', '', '']);
      else m.data.models.forEach(function (name) {
        var isActive = pv.active === p.id && pv.model === name;
        rows.push([escapeHtml(p.label), mono(name), statusBadgeHtml(p.executable ? 'EXECUTABLE' : 'BLOCKED', p.executable ? 'executable' : (p.reason || 'not executable')),
          isActive ? statusBadgeHtml('ACTIVE') : '', isActive ? '' : btn('Activate', 'data-select-model="' + escapeHtml(p.id) + '" data-model="' + escapeHtml(name) + '"')]);
      });
    });
    return html + panel('Catalog', table(['Provider', 'Model', 'Dispatch', 'State', ''], rows), { flush: true });
  }

  // ---- Visual provider picker -------------------------------------------------------------
  // Grouped like a router UI (connected / account login / API key / local), one row per provider
  // with a status badge, per-group Test All, inline connect forms and discovered-model activation.
  // Bindings only: the existing registry routes (/api/r9/connect, /api/r9/provider,
  // /api/r9/models), provider-admin test, the model-grant route and the OAuth routes. Nothing is
  // built in and nothing is a default: rows come from Core's own preset list and live connections.
  var PP_OAUTH_STATIC = [
    { id: 'openai', label: 'OpenAI', preset: 'openai', note: 'OpenAI tidak menerbitkan login langganan untuk aplikasi pihak ketiga. Jalur resmi di Damar adalah kunci API OpenAI.' },
    { id: 'anthropic', label: 'Anthropic', preset: 'anthropic', note: 'Anthropic melarang login Claude.ai lewat aplikasi pihak ketiga. Jalur resmi di Damar adalah kunci API Anthropic.' },
    { id: 'antigravity', label: 'Antigravity', preset: null, note: 'Tidak ada login pihak ketiga dan tidak ada endpoint kunci API resmi untuk Antigravity, jadi Damar belum bisa menghubungkannya.' }
  ];
  var PP_RISK = 'Menghubungkan akun lewat login berlangganan bisa membahayakan langgananmu: penyedia dapat membatasi atau menghentikan akun yang dipakai di luar aplikasi resminya. Pastikan kamu memahami risikonya sebelum menghubungkan akun; risiko itu sepenuhnya tanggung jawabmu.';
  function ppTile(id, label) {
    var h = 0; for (var i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) % 360;
    var words = String(label || id).split(/\s+/).filter(Boolean);
    var ini = ((words[0] || '?').charAt(0) + (words.length > 1 ? words[1].charAt(0) : (words[0] || '?').charAt(1) || '')).toUpperCase();
    return '<span aria-hidden="true" style="width:34px;height:34px;border-radius:9px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:700;color:#fff;background:hsl(' + h + ',42%,34%);">' + escapeHtml(ini) + '</span>';
  }
  function ppHumanError(e) {
    var s = String(e || '');
    if (/401|AUTH_REQUIRED|AUTH_FAILED|INVALID_KEY|KEY_INVALID|UNAUTHORIZED/i.test(s)) return 'Kunci ditolak penyedia (401). Periksa kunci, atau buat kunci baru di penyedia.';
    if (/429|RATE_LIMIT|QUOTA/i.test(s)) return 'Batas pemakaian penyedia tercapai (429). Tunggu sebentar, atau naikkan batas di penyedia.';
    if (/UNREACHABLE|ECONN|NETWORK|FETCH_FAILED|ENOTFOUND/i.test(s)) return 'Endpoint tidak terjangkau. Periksa alamat endpoint dan koneksi internet.';
    if (/TIMEOUT|TIMED_OUT|ABORT/i.test(s)) return 'Waktu habis saat menghubungi penyedia. Coba lagi.';
    if (/MODEL_NOT_FOUND|NO_MODELS/i.test(s)) return 'Model tidak ditemukan di penyedia ini.';
    if (/404/.test(s)) return 'Alamat tidak ditemukan di penyedia (404). Periksa endpoint.';
    return s || 'Gagal';
  }
  function ppConnBadge(p, pv) {
    if (pv.active === p.id) return statusBadgeHtml('ACTIVE', 'Aktif · ' + (pv.model || p.model || ''));
    if (!p.configured) return statusBadgeHtml('BLOCKED', 'Belum lengkap');
    if (p.grantStatus === 'needs-new-grant') return statusBadgeHtml('PENDING', 'Perlu izin model');
    if (!p.executable) return statusBadgeHtml('BLOCKED', p.reason || 'Tidak bisa dipakai');
    return statusBadgeHtml('READY', 'Terhubung');
  }
  function ppTestChip(id) {
    var t = state.picker.tests[id]; if (!t) return '';
    return ' <span style="font-size:11px;' + (t.ok ? 'color:var(--text-secondary);' : 'color:#e88;') + '">' + (t.ok ? 'Lolos uji ' + new Date(t.at).toLocaleTimeString() : 'Uji gagal: ' + escapeHtml(t.error)) + '</span>';
  }
  function ppRowConn(p, pv) {
    var m = state.models[p.id], models = m && m.ok ? m.data.models : (p.model ? [p.model] : []);
    var cur = pv.active === p.id ? (pv.model || p.model || '') : (p.model || '');
    var sel = '<select class="select-field" id="ppModel_' + escapeHtml(p.id) + '" style="min-width:170px;max-width:260px;">' +
      (models.length ? models.map(function (x) { return '<option value="' + escapeHtml(x) + '"' + (x === cur ? ' selected' : '') + '>' + escapeHtml(x) + '</option>'; }).join('') : '<option value="">' + (m ? 'Tidak ada model' : 'Memuat model…') + '</option>') + '</select>';
    return '<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border-subtle);flex-wrap:wrap;">' + ppTile(p.id, p.label) +
      '<div style="flex:1;min-width:180px;"><div style="font-weight:600;color:var(--text-ivory);">' + escapeHtml(p.label) + ppTestChip(p.id) + '</div>' +
      '<div style="font-size:11.5px;color:var(--text-muted);font-family:var(--font-mono);overflow-wrap:anywhere;">' + escapeHtml(p.baseUrl || '-') + '</div></div>' +
      ppConnBadge(p, pv) + sel +
      '<span style="display:flex;gap:6px;flex-wrap:wrap;">' + btn('Uji', 'data-pp-test="' + escapeHtml(p.id) + '"') +
      btn(pv.active === p.id ? 'Terapkan model' : p.grantStatus === 'granted' ? 'Jadikan aktif' : 'Izinkan & aktifkan', 'data-pp-activate="' + escapeHtml(p.id) + '"', 'btn-primary') +
      btn('Putuskan', 'data-remove-provider="' + escapeHtml(p.id) + '"', 'btn-danger') + '</span></div>';
  }
  function ppRowPreset(x, groupKey) {
    var open = !!state.picker.open[x.id];
    var html = '<div id="ppRow_' + escapeHtml(x.id) + '" style="display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border-subtle);flex-wrap:wrap;">' + ppTile(x.id, x.label) +
      '<div style="flex:1;min-width:180px;"><div style="font-weight:600;color:var(--text-ivory);">' + escapeHtml(x.label) + '</div>' +
      '<div style="font-size:11.5px;color:var(--text-muted);font-family:var(--font-mono);overflow-wrap:anywhere;">' + escapeHtml(x.baseUrl || '') + '</div></div>' +
      statusBadgeHtml('NOT_CONFIGURED', 'Belum terhubung') +
      (open ? btn('Batal', 'data-pp-toggle="' + escapeHtml(x.id) + '"') : btn('Hubungkan', 'data-pp-toggle="' + escapeHtml(x.id) + '"', 'btn-primary')) + '</div>';
    if (open) {
      html += '<div style="padding:4px 0 12px 46px;display:flex;flex-direction:column;gap:8px;">' +
        (x.keyRequired !== false
          ? field('ppKey_' + x.id, 'API key (dikirim ke Core sekali; tidak pernah ditampilkan lagi)', '<input type="password" class="input-field" id="ppKey_' + escapeHtml(x.id) + '" style="width:100%;" autocomplete="off" />') +
            '<label style="font-size:12px;display:flex;gap:8px;align-items:center;"><input type="checkbox" id="ppRemember_' + escapeHtml(x.id) + '" checked /> ' + escapeHtml(L('Ingat kunci di PC ini (Windows DPAPI)')) + '</label>' +
            '<div style="font-size:11.5px;color:var(--text-muted);">' + escapeHtml(L('Kuncimu terenkripsi dan tersimpan aman di Core. Setelah terhubung, daftar model penyedia terisi otomatis dan semua model diizinkan selama 30 hari (bisa diubah di panel Model Grant).')) + '</div>'
          : '<div style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(L('Provider lokal ini berjalan di komputermu sendiri dan tidak membutuhkan kunci API.')) + '</div>') +
        '<div style="display:flex;justify-content:flex-end;">' + btn('Sambungkan', 'data-pp-connect="' + escapeHtml(x.id) + '"', 'btn-primary') + '</div></div>';
    }
    return html;
  }
  function ppGroupBar(groupKey, hint) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(L(hint)) + '</span>' +
      btn('Uji semua', 'data-pp-test-all="' + groupKey + '"') + '</div>' +
      (state.picker.groupMsg[groupKey] ? '<div style="font-size:12px;color:var(--text-secondary);margin-top:6px;">' + escapeHtml(state.picker.groupMsg[groupKey]) + '</div>' : '');
  }
  function renderProviderPicker(pv) {
    var presets = pv.presets || [];
    var live = pv.providers.filter(function (p) { return p.kind === 'live' && !p.virtual; });
    var liveIds = {}; live.forEach(function (p) { liveIds[p.id] = true; });
    var keyPresets = presets.filter(function (x) { return x.keyRequired !== false && x.id !== 'custom' && !liveIds[x.id]; });
    var localPresets = presets.filter(function (x) { return x.keyRequired === false && !liveIds[x.id]; });
    var errCount = live.filter(function (p) { return !p.executable; }).length;
    var html = '<div class="panel" style="border-left:3px solid var(--damar-accent);"><div class="panel-body" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--text-secondary);">' +
      '<span><strong style="color:var(--text-ivory);">' + live.length + '</strong> ' + escapeHtml(L('terhubung')) + '</span>' +
      '<span><strong style="color:var(--text-ivory);">' + errCount + '</strong> ' + escapeHtml(L('bermasalah')) + '</span>' +
      '<span>' + escapeHtml(L('Model aktif')) + ': <strong style="color:var(--text-ivory);">' + escapeHtml(pv.active || '-') + ' / ' + escapeHtml(pv.model || '-') + '</strong></span>' +
      '<span style="color:var(--text-muted);">' + escapeHtml(L('Tidak ada provider bawaan dan tidak ada default. Semua koneksi adalah milikmu.')) + '</span></div></div>';
    if (pv.restoreNotice) {
      var rn = pv.restoreNotice, rnWhy = {
        PROVIDER_NOT_IN_REGISTRY: 'provider tersimpan sudah tidak ada lagi di daftar koneksi',
        MODEL_NOT_OFFERED_BY_PROVIDER: 'model tersimpan tidak lagi ditawarkan oleh providernya',
        NO_GRANTED_CONNECTION: 'tidak ada koneksi terhubung yang modelnya sudah diizinkan',
        AMBIGUOUS_GRANTED_CONNECTIONS: 'ada beberapa koneksi yang sudah diizinkan dan tidak satu pun cocok dengan provider tersimpan',
        MODEL_LIST_UNAVAILABLE: 'daftar model koneksi pengganti tidak bisa dibaca',
        NO_MODEL_DETERMINED: 'tidak ada model pengganti yang bisa ditentukan dengan pasti',
        FALLBACK_SELECT_FAILED: 'pemilihan koneksi pengganti tetap gagal setelah dicoba berulang'
      }[rn.reason] || rn.reason;
      html += '<div class="panel"><div class="panel-body" style="font-size:12.5px;color:var(--text-secondary);">' +
        (rn.restored
          ? 'Saat Core menyala, pilihan provider tersimpan <strong style="color:var(--text-ivory);">' + escapeHtml((rn.stored || {}).provider || '-') + ' / ' + escapeHtml((rn.stored || {}).model || '-') + '</strong> tidak bisa dipakai karena ' + escapeHtml(rnWhy) + '. Core memulihkannya ke <strong style="color:var(--text-ivory);">' + escapeHtml(rn.restored.provider) + ' / ' + escapeHtml(rn.restored.model) + '</strong> dari koneksi yang sudah kamu izinkan, dan pilihan tersimpan sudah diperbarui.'
          : 'Saat Core menyala, pilihan provider tersimpan <strong style="color:var(--text-ivory);">' + escapeHtml((rn.stored || {}).provider || '-') + ' / ' + escapeHtml((rn.stored || {}).model || '-') + '</strong> tidak bisa dipakai dan tidak bisa dipulihkan otomatis karena ' + escapeHtml(rnWhy) + '. Live inference belum aktif; pilih provider dan model secara manual di halaman ini.') +
        '</div></div>';
    }
    html += panel('Tersambung (' + live.length + ')', ppGroupBar('connected', 'Koneksi yang sudah tersimpan di Core. Pilih model dari daftar hasil penemuan, lalu jadikan aktif.') +
      (live.length ? live.map(function (p) { return ppRowConn(p, pv); }).join('') : '<div style="padding:12px 0;font-size:12.5px;color:var(--text-muted);">' + escapeHtml(L('Belum ada koneksi. Pilih provider di grup di bawah untuk menghubungkan.')) + '</div>'));
    var oa = LIVE.d('oauth'), oc = oa && oa.connections ? oa.connections[0] : null;
    var orow = '<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border-subtle);flex-wrap:wrap;">' + ppTile('openrouter', 'OpenRouter') +
      '<div style="flex:1;min-width:180px;"><div style="font-weight:600;color:var(--text-ivory);">OpenRouter</div>' +
      '<div style="font-size:11.5px;color:var(--text-muted);">' + escapeHtml(L('Login OAuth (PKCE) resmi untuk aplikasi pihak ketiga. Kunci hasil login tersimpan di vault Core (DPAPI) dan tersambung ke koneksi OpenRouter.')) +
      (oc && oc.identity && oc.identity.label ? ' ' + escapeHtml(L('Akun')) + ': ' + escapeHtml(oc.identity.label) + '.' : '') +
      (oc && oc.status === 'connected' && oc.sync !== 'synced' ? ' ' + escapeHtml(L('Koneksi OpenRouter belum ada: sambungkan dari grup Kunci API atau Lanjutan agar bisa dipilih.')) : '') + '</div></div>' +
      (oc && oc.status === 'connected' ? statusBadgeHtml('READY', 'Terhubung') : oc && oc.status === 'invalid' ? statusBadgeHtml('BLOCKED', 'Kunci tidak berlaku, login ulang') : statusBadgeHtml('NOT_CONFIGURED', 'Belum terhubung')) +
      '<span style="display:flex;gap:6px;flex-wrap:wrap;">' + (oc && oc.status === 'connected' ? btn('Uji', 'data-pp-oauth-check="1"') + btn('Putuskan koneksi', 'data-oauth-disconnect="openrouter"') : btn('Login dengan OpenRouter', 'data-oauth-login="openrouter"', 'btn-primary')) + '</span></div>';
    PP_OAUTH_STATIC.forEach(function (x) {
      orow += '<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border-subtle);flex-wrap:wrap;">' + ppTile(x.id, x.label) +
        '<div style="flex:1;min-width:180px;"><div style="font-weight:600;color:var(--text-ivory);">' + escapeHtml(x.label) + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-muted);">' + escapeHtml(L(x.note)) + '</div></div>' +
        statusBadgeHtml('NOT_CONFIGURED', 'Login tidak tersedia') +
        (x.preset ? btn('Gunakan kunci API', 'data-pp-apikey="' + escapeHtml(x.preset) + '"') : '') + '</div>';
    });
    html += panel('Login akun (OAuth)', ppGroupBar('oauth', 'Hubungkan akun tanpa menempel API key, hanya lewat jalur yang benar-benar diterbitkan penyedia.') +
      '<div style="margin-top:8px;padding:9px 11px;border:1px solid var(--border-subtle);border-radius:6px;font-size:12px;color:var(--text-secondary);">' + escapeHtml(L(PP_RISK)) + '</div>' + orow);
    html += panel('Kunci API (' + keyPresets.length + ')', ppGroupBar('apikey', 'Ketuk provider untuk menghubungkannya dengan kunci API.') +
      (keyPresets.length ? keyPresets.map(function (x) { return ppRowPreset(x, 'apikey'); }).join('') : '<div style="padding:12px 0;font-size:12.5px;color:var(--text-muted);">' + escapeHtml(L('Semua provider kunci API sudah terhubung.')) + '</div>'));
    html += panel('Lokal, tanpa kunci (' + localPresets.length + ')', ppGroupBar('local', 'Berjalan di komputermu sendiri, tanpa kunci API.') +
      (localPresets.length ? localPresets.map(function (x) { return ppRowPreset(x, 'local'); }).join('') : '<div style="padding:12px 0;font-size:12.5px;color:var(--text-muted);">' + escapeHtml(L('Semua provider lokal sudah terhubung.')) + '</div>'));
    html += panel('Lanjutan', state.picker.advanced
      ? '<p style="font-size:12.5px;color:var(--text-secondary);">' + escapeHtml(L('Formulir lengkap endpoint + kunci manual: id koneksi khusus, endpoint apa pun yang kompatibel dengan OpenAI, dan tunjangan token sisipan. Untuk koneksi yang sudah ada, tombol Connect di panel detail di bawah membuka formulir yang sama.')) + '</p>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">' + btn('Sembunyikan', 'data-pp-advanced="1"') + btn('+ Add provider…', 'data-add-provider="1"', 'btn-primary') + '</div>'
      : '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;"><span style="font-size:12.5px;color:var(--text-secondary);">' + escapeHtml(L('Endpoint + kunci manual, id koneksi khusus, dan opsi lanjutan lain.')) + '</span>' + btn('Buka lanjutan', 'data-pp-advanced="1"') + '</div>');
    return html;
  }
  // Picker Test All: run the router key test (metadata only, no tokens) per connection, record the
  // per-row outcome for the inline chip, and summarize the group in plain language.
  function ppTestIds(ids, groupKey) {
    if (!ids.length) { if (groupKey) { state.picker.groupMsg[groupKey] = 'Belum ada koneksi di grup ini.'; renderAll(); } return; }
    var chain = Promise.resolve(), okCount = 0, fails = [];
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return core.post('/api/r9/provider-admin/test', { provider: id, kind: 'keys' }).then(function (r) {
          var results = Array.isArray(r.data) ? r.data : [];
          var ok = r.ok && results.some(function (x) { return x && x.ok; });
          var bad = results.find(function (x) { return x && !x.ok; });
          state.picker.tests[id] = { ok: ok, error: ok ? '' : ppHumanError((bad && bad.error) || r.error), at: Date.now() };
          if (ok) okCount++; else fails.push(id + ': ' + state.picker.tests[id].error);
        });
      });
    });
    chain.then(function () {
      if (groupKey) state.picker.groupMsg[groupKey] = okCount + ' lolos · ' + (ids.length - okCount) + ' gagal' + (fails.length ? ' — ' + fails.join('; ') : '');
      refresh().then(renderAll);
    });
  }
  function renderProvidersView() {
    var pv = LIVE.d('provider'), gr = LIVE.d('grant'), bd = LIVE.d('budget');
    var html = pageHeader('PROVIDER GATEWAYS', 'Providers', 'Provider configuration as reported by Core. Keys are write-only: Control can send a key to Core but never reads one back.', btn('View Model Catalog →', 'data-jump-view="models"'));
    html += '<div class="panel" style="border-left:3px solid var(--damar-accent);"><div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;"><div><div style="font-weight:600;color:var(--text-ivory);">Credential &amp; Secret Protection Boundary</div><div style="font-size:12px;color:var(--text-secondary);">Core stores provider keys (DPAPI, current user). Control shows only whether a key exists.</div></div><span class="badge badge-gold">Write-only credentials</span></div></div>';
    if (!pv) return html + panel('Providers', readState('provider', 'providers'));
    html += renderProviderPicker(pv);
    html += '<div class="workspace-grid-12">';
    pv.providers.forEach(function (p) {
      var isActive = pv.active === p.id;
      html += panel(p.label, kvList([
        kv('Provider id', p.id, true), kv('Kind', p.kind === 'live' ? 'OpenAI-compatible' : p.kind), kv('Endpoint', p.baseUrl || 'not configured', true), kv('Configured', p.configured ? 'yes' : 'no'),
        kv('Model grant', p.grantStatus === 'granted' ? p.grant.model + ' until ' + when(p.grant.expiresAt) : p.grantStatus === 'needs-new-grant' ? 'needs a new grant (endpoint changed or expired)' : p.grantStatus === 'none' ? 'none' : 'not required'),
        kv('Key stored', p.hasKey ? (p.keyRemembered ? 'yes (remembered)' : 'yes (this session)') : 'no'), kv('Dispatch', p.executable ? 'executable' : (p.reason || 'not executable')),
        kv('Model', p.model || '-'), kv('Image input', p.capabilities ? p.capabilities.imageInput : '-'), kv('Configuration version', p.configurationVersion, true)
      ]) + '<div style="display:flex;justify-content:flex-end;gap:8px;padding-top:10px;margin-top:10px;border-top:1px solid var(--border-subtle);flex-wrap:wrap;">' +
        (isActive ? '' : btn('Activate', 'data-select-provider="' + escapeHtml(p.id) + '"')) + btn('Connect…', 'data-connect-provider="' + escapeHtml(p.id) + '"') +
        (p.kind === 'live' && p.hasKey ? btn('Forget key', 'data-revoke-provider="' + escapeHtml(p.id) + '"', 'btn-danger') : '') +
        (p.kind === 'live' && !p.virtual ? btn('Remove', 'data-remove-provider="' + escapeHtml(p.id) + '"', 'btn-danger') : '') + '</div>' + keysBlock(p),
        { span: 6, badge: statusBadgeHtml(isActive ? 'ACTIVE' : p.executable ? 'READY' : 'BLOCKED', isActive ? 'active' : p.executable ? 'ready' : 'blocked') });
    });
    html += panel('Model Grant (live dispatch authority)', gr ? kvList([kv('Effective', gr.effective ? 'YES' : 'no'), kv('Revision', num(gr.revision)),
      kv('Grants', (gr.grants || []).length ? gr.grants.map(function (g) { return g.provider + ' / ' + g.model + (g.effective ? ' until ' + when(g.expiresAt) : ' (expired)'); }).join('; ') : 'none'),
      kv('Limits', (gr.grants || []).length ? gr.grants.map(function (g) { return g.provider + ': ' + JSON.stringify(g.limits); }).join('; ') : '-'), kv('Scope', gr.scopeId ? gr.scopeId.slice(0, 16) + '…' : '-', true)]) +
      '<div style="display:flex;justify-content:flex-end;gap:8px;padding-top:10px;margin-top:10px;border-top:1px solid var(--border-subtle);">' + btn('Grant…', 'data-grant="1"') + ((gr.grants || []).length ? btn('Revoke grant…', 'data-revoke-grant="1"', 'btn-danger') : '') + '</div>'
      : readState('grant', 'model grant'), { span: 6 });
    html += panel('Budget', bd ? kvList(Object.keys(bd).map(function (k) { return kv(k, typeof bd[k] === 'object' ? JSON.stringify(bd[k]) : String(bd[k])); })) : readState('budget', 'budget'), { span: 6 });
    return html + routerPanels() + '</div>';
  }
  // ---- Router-grade providers: keys + health per connection, combos, routing and the DAMAR /v1 gateway ----
  function padminConn(id) { var a = LIVE.d('padmin'); return a ? a.connections.filter(function (c) { return c.id === id; })[0] : null; }
  function keysBlock(p) {
    if (p.kind !== 'live' || p.virtual) return '';
    var c = padminConn(p.id); if (!c) return '';
    var id = escapeHtml(p.id), rows = (c.keys || []).map(function (k) {
      var kid = escapeHtml(k.kid);
      return [mono(k.suffix), statusBadgeHtml(k.status === 'ok' ? 'COMPLETED' : k.status === 'disabled' ? 'BLOCKED' : k.status === 'untested' ? 'PENDING' : 'FAILED', L(k.status)), escapeHtml(k.lastOk ? when(k.lastOk) : '-'),
        escapeHtml(k.lastError || '-') + (k.cooldownUntil && k.cooldownUntil > Date.now() ? ' · ' + escapeHtml(L('cooldown until')) + ' ' + escapeHtml(when(k.cooldownUntil)) : ''),
        btn('Test', 'data-key-test="' + id + '" data-kid="' + kid + '"') + (k.kid === 'primary' ? '' : ' ' + btn(k.enabled ? 'Disable' : 'Enable', 'data-key-toggle="' + id + '" data-kid="' + kid + '" data-enabled="' + (!k.enabled) + '"')) + ' ' + btn('Delete', 'data-key-delete="' + id + '" data-kid="' + kid + '"', 'btn-danger')];
    });
    return '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-subtle);">' +
      kvList([kv('Key rotation', L(c.strategy)), kv('Injected-token allowance', num(c.injectedTokens)), kv('Max parallel requests', num(c.maxConcurrency)), kv('Models added / aliases', (c.extraModels || []).join(', ') + (Object.keys(c.aliases || {}).length ? ' · ' + Object.keys(c.aliases).map(function (a) { return a + '→' + c.aliases[a]; }).join(', ') : '') || '-')]) +
      table(['Key', 'Status', 'Last OK', 'Last error', ''], rows, 'No keys yet.') +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;flex-wrap:wrap;">' + btn('Import keys…', 'data-keys-import="' + id + '"') + btn('Test all keys', 'data-keys-test-all="' + id + '"') +
      btn('Test model… (spends tokens)', 'data-model-test="' + id + '"') + btn('Rotation…', 'data-key-strategy="' + id + '"') + btn('Limits…', 'data-conn-limits="' + id + '"') + btn('Catalog…', 'data-catalog="' + id + '"') + '</div></div>';
  }
  function routerPanels() {
    var a = LIVE.d('padmin');
    if (!a) return panel('Combos, routing and gateway', readState('padmin', 'provider router'), { span: 12 });
    var combos = (a.combos || []).map(function (c) { return [mono(c.id), escapeHtml(L(c.strategy)), escapeHtml(c.targets.map(function (t) { return t.connection + '/' + t.model; }).join(' → ')),
      escapeHtml(c.available.length ? c.available.length + ' ' + L('granted') : L('no granted target')), btn('Delete', 'data-combo-delete="' + escapeHtml(c.id) + '"', 'btn-danger')]; });
    var html = panel('Combos (virtual models with fallback)', table(['Combo', 'Strategy', 'Targets', 'Available', ''], combos, 'No combos yet.') +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">' + btn('New combo…', 'data-combo-new="1"') + btn('Routing…', 'data-routing="1"') + '</div>' +
      '<p style="font-size:11.5px;color:var(--text-muted);margin-top:6px;">' + escapeHtml(L('Cooldown after a failed key')) + ': ' + num(Math.round(a.routing.cooldownMs / 1000)) + ' s → ' + num(Math.round(a.routing.maxCooldownMs / 1000)) + ' s · ' + escapeHtml(L('Max parallel requests')) + ': ' + num(a.routing.maxConcurrency) + '</p>', { span: 6 });
    var m = a.meter;
    if (m) html += panel('Usage meter', kvList([kv('In flight', num(m.inFlight) + ' (' + num(m.reservedTokens) + ' tok ' + L('reserved') + ')'), kv('Total tokens', num(m.totalTokens)),
      kv('Estimated (model reports no usage)', num(m.estimated)), kv('Uncertain (usage lost; charged upper bound)', num(m.uncertain)), kv('Over the input bound', num(m.boundExceeded)),
      kv('Models without usage reports', Object.keys(m.usageReporting || {}).filter(function (k) { return m.usageReporting[k] === 'missing'; }).join(', ') || '-')]) +
      table(['When', 'Provider / model', 'Status', 'Charged'], (m.recentUncertain || []).slice().reverse().map(function (u) { return [escapeHtml(when(u.t)), escapeHtml(u.provider + ' / ' + u.model + (u.gatewayKey ? ' · ' + u.gatewayKey : '')), escapeHtml(u.status), num(u.chargedTokens)]; }), 'No uncertain requests.'), { span: 6 });
    var g = a.gateway;
    if (!g) return html;
    var keys = g.keys.filter(function (k) { return !k.revokedAt; }).map(function (k) { return [escapeHtml(k.label), mono(k.prefix), escapeHtml(k.models.join(', ')),
      escapeHtml(num(k.usage.requests) + ' req · ' + num(k.usage.inputTokens + k.usage.outputTokens) + ' tok'), btn('Revoke', 'data-gw-key-revoke="' + escapeHtml(k.id) + '"', 'btn-danger')]; });
    var s = g.snippets;
    html += panel('DAMAR Gateway (OpenAI-compatible /v1)', kvList([kv('Status', g.listening ? L('listening on') + ' ' + g.listening.address + ':' + g.listening.port : L('off')),
      kv('Bind', g.settings.bind === '0.0.0.0' ? L('LAN (all interfaces)') : L('this computer only')), kv('Base URL', s.baseUrl, true)]) +
      table(['Key', 'Prefix', 'Models', 'Usage', ''], keys, 'No gateway keys yet.') +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">' + btn('Gateway settings…', 'data-gw-settings="1"') + btn('Create key…', 'data-gw-key-new="1"', 'btn-primary') + '</div>' +
      [['opencode', 'opencode (opencode.json)'], ['hermes', 'Hermes Agent (config.yaml)'], ['continue', 'Continue.dev'], ['cline', 'Cline / Roo Code'], ['aider', 'Aider'], ['librechat', 'LibreChat'], ['openwebui', 'Open WebUI'], ['generic', L('Any OpenAI client')]].filter(function (x) { return s[x[0]]; }).map(function (x) { var n = x[0]; return '<div style="margin-top:10px;"><div style="font-size:11.5px;color:var(--text-secondary);">' + escapeHtml(x[1]) + '</div><pre style="font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg-inset, rgba(0,0,0,.25));padding:8px;border-radius:6px;margin:4px 0 0;">' + escapeHtml(s[n]) + '</pre></div>'; }).join(''), { span: 6 });
    return html;
  }

  // ---- Pandawa team discussions (Core: /api/r9/pandawa/discussions) ----
  function discussionEvent(e, of) {
    // Conversation-style transcript: each turn is a bubble in chain order (member name, turn, model),
    // Owner interjections sit on the right in gold, and DAMAR's closing decision is its own gold card.
    if (e.type === 'round') return '<div class="page-kicker" style="margin-top:10px;">' + escapeHtml(L('Cycle') + ' ' + e.round) + '</div>';
    if (e.type === 'continued') return '<div style="text-align:center;font-size:11px;color:var(--text-muted);margin:10px 0;">' + escapeHtml(L('Discussion continued by the Owner')) + '</div>';
    if (e.type === 'message' || e.type === 'owner') {
      var own = e.type === 'owner';
      var who = own ? L('You (interjection)') : e.member;
      var meta = (e.turn ? L('Turn') + ' ' + e.turn : L('round') + ' ' + e.round) + (e.model ? ' · ' + e.model : '');
      return '<div style="display:flex;flex-direction:column;' + (own ? 'align-items:flex-end;' : '') + 'margin:8px 0;">' +
        '<div style="font-size:11px;color:var(--damar-accent);font-family:var(--font-mono);">' + escapeHtml(who) + ' · ' + escapeHtml(meta) + '</div>' +
        '<div style="max-width:94%;border:1px solid ' + (own ? 'var(--gold-champagne)' : 'var(--border-subtle)') + ';border-radius:10px;padding:8px 12px;margin-top:3px;font-size:12.5px;color:var(--text-secondary);white-space:pre-wrap;">' + escapeHtml(String(e.text || '')) + '</div></div>';
    }
    if (e.type === 'member_error') return '<div style="font-size:11.5px;color:var(--status-critical);margin:6px 0;">' + escapeHtml(String(e.member || '?')) + ' ' + escapeHtml(L('did not reply')) + ' (' + escapeHtml(e.error || '') + ')</div>';
    if (e.type === 'synthesis') return '<div style="border:1px solid var(--gold-bright);border-radius:10px;padding:10px 14px;margin:12px 0;"><div style="font-size:11px;color:var(--gold-bright);font-family:var(--font-mono);">DAMAR · ' + escapeHtml(L("DAMAR's decision")) + '</div><div style="font-size:12.5px;color:var(--text-secondary);white-space:pre-wrap;margin-top:4px;">' + escapeHtml(String(e.text || '')) + '</div></div>';
    if (e.type === 'final') { var reasons = { CONSENSUS: 'Konvergen', DEADLOCK: 'Buntu substantif', SAFETY_CEILING: 'Batas pengaman siklus tercapai', TOKEN_BUDGET_REACHED: 'Anggaran token tercapai', NO_MEMBER_REPLIED: 'Tidak ada anggota yang menjawab', MEMBERS_UNREACHABLE: 'Anggota tidak terjangkau', CORE_RESTARTED: 'Core dimulai ulang' };
      return '<div style="margin-top:8px;">' + statusBadgeHtml(e.status) + (e.reason ? ' <span style="font-size:11.5px;color:var(--text-muted);">' + escapeHtml(reasons[e.reason] || e.reason) + '</span>' : '') + (Number.isSafeInteger(e.tokens) ? ' <span style="font-size:11.5px;color:var(--text-muted);">' + e.tokens + ' tokens</span>' : '') + '</div>'; }
    return '';
  }
  function renderDiscussionsView() {
    var dl = LIVE.d('discussions'), x = state.discussion;
    var html = pageHeader('DAMAR INTELLIGENCE • PANDAWA TEAM', 'Discussions', 'Team debates run as a sequential chain: each member answers the previous speaker, short and sharp, until they converge or DAMAR rules a deadlock and closes with a decision. Delegations run in parallel.', btn('+ New discussion', 'data-new-discussion="1"', 'btn-primary'));
    if (!dl) return html + panel('Discussions', readState('discussions', 'discussions'), { flush: true });
    html += '<div class="workspace-grid-12">';
    html += panel('Discussions', table(['Topic', 'Mode', 'State', 'Cycle / Turn', 'Tokens', ''], dl.discussions.slice().reverse().map(function (d) {
      return ['<span style="color:var(--text-ivory);">' + escapeHtml(String(d.topic || '-').slice(0, 80)) + '</span>', escapeHtml(d.mode), statusBadgeHtml(d.state), '<span class="td-num">' + d.round + ' / ' + (d.turns != null ? d.turns : '-') + '</span>', '<span class="td-num">' + num(d.tokens) + '</span>', btn('Open', 'data-open-discussion="' + escapeHtml(d.discussionId) + '"')];
    }), 'No discussions yet. Start one here, or with /discuss in the CLI.'), { span: 5, flush: true });
    if (!x || !x.data) html += panel('Discussion', '<div style="font-size:12px;color:var(--text-muted);">' + escapeHtml(L(x && x.error ? x.error : 'Open a discussion to follow it live.')) + '</div>', { span: 7 });
    else {
      var d = x.data, mine = d.cliSession && d.cliSession === state.control.id, of = d.maxRounds;
      var head = kvList([kv('Mode', d.mode), kv('State', d.state), kv('Cycle', d.round), kv('Turn', d.turns != null ? d.turns : '-'),
        kv('Team', Object.keys(d.models || {}).map(function (m) { var r = d.models[m]; return m + ' → ' + (r ? r.connection + '/' + r.model + (r.assigned ? '' : ' (active)') : '?'); }).join(' · '))]);
      var usage = table(['Member', 'Model', 'Calls', 'In', 'Out'], (d.receipts || []).map(function (r) { return [escapeHtml(r.member), mono(r.connection + '/' + r.model), '<span class="td-num">' + r.calls + '</span>', '<span class="td-num">' + r.inputTokens + '</span>', '<span class="td-num">' + r.outputTokens + (r.estimated ? ' ~' : '') + '</span>']; }), 'No provider calls yet.');
      var controls = '';
      if (d.state === 'RUNNING') controls = mine
        ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;"><label for="discInterject" class="skip-link" style="position:absolute;left:-9999px;">' + escapeHtml(L('Interjection')) + '</label><input type="text" class="input-field" id="discInterject" maxlength="2000" style="flex:1;min-width:200px;" placeholder="' + escapeHtml(L('Add your view to the discussion…')) + '" />' + btn('Send', 'data-interject="1"', 'btn-primary') + btn('Stop', 'data-stop-discussion="1"', 'btn-danger') + '</div>'
        : '<div style="font-size:11.5px;color:var(--text-muted);margin-top:10px;">' + escapeHtml(L('Started in a CLI window: interject or stop it there.')) + '</div>';
      else if (d.mode === 'debate' && mine) controls = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">' + btn('Extend discussion', 'data-extend-discussion="1"', 'btn-primary') + '<span style="font-size:11.5px;color:var(--text-muted);">' + escapeHtml(L('Reopens the debate chain from the last decision.')) + '</span></div>';
      html += panel(String(d.topic || L('Discussion')).slice(0, 90), head + controls + '<h3 style="font-size:12px;margin:14px 0 6px;color:var(--damar-accent);">' + escapeHtml(L('Per-member usage')) + '</h3>' + usage +
        '<h3 style="font-size:12px;margin:14px 0 6px;color:var(--damar-accent);">' + escapeHtml(L('Transcript')) + '</h3><div aria-live="polite">' + (d.events || []).map(function (e) { if (e.type === 'round') of = e.of || of; return discussionEvent(e, of); }).join('') + '</div>', { span: 7, badge: statusBadgeHtml(d.state) });
    }
    return html + '</div>';
  }
  function openDiscussion(id) {
    if (state.discussion && state.discussion.stop) state.discussion.stop();
    state.discussion = { id: id, data: null };
    core.get('/api/r9/pandawa/discussions/' + id).then(function (r) {
      if (!state.discussion || state.discussion.id !== id) return;
      if (!r.ok) { state.discussion.error = describeFailure(r); renderAll(); return; }
      state.discussion.data = r.data; renderAll();
      if (r.data.state !== 'RUNNING') return;
      // Live: replay from the next event, append, re-render (never while the Owner is typing an interjection).
      state.discussion.stop = core.stream('/api/r9/pandawa/discussions/' + id + '/events?from=' + r.data.events.length, function (e) {
        var x = state.discussion; if (!x || x.id !== id || !x.data) return;
        if (x.data.events.some(function (o) { return o.seq === e.seq; })) return;
        x.data.events.push(e);
        if (e.type === 'round') x.data.round = e.round;
        if (e.type === 'final') { x.data.state = e.status; core.get('/api/r9/pandawa/discussions/' + id).then(function (f) { if (f.ok && state.discussion && state.discussion.id === id) { state.discussion.data = f.data; renderAll(); } }); }
        var a = document.activeElement; if (!(a && a.id === 'discInterject')) renderAll();
      });
    });
  }
  function shortRole(a) {
    // Registry role/description fields carry the agent's full persona prompt;
    // the table shows the short specialization from the label's parenthetical
    // ("Puntadewa (strategi, sintesis & arbitrase)"), else the first sentence.
    var m = String(a.label || '').match(/\(([^)]{3,60})\)/);
    if (m) return m[1];
    var s = String(a.description || a.role || '').split(/[.!?]\s/)[0].trim();
    return s.length > 80 ? s.slice(0, 77).trimEnd() + '…' : s;
  }
  function renderPandawaView() {
    var runs = LIVE.d('runs'), ag = LIVE.d('agents');
    var st = state.settings; if (!st) ensureSettings();
    var tmModels = (st && st.ok && st.data.pandawa && st.data.pandawa.models) || {};
    var pv = LIVE.d('provider');
    var html = pageHeader('DAMAR INTELLIGENCE • MISSION ORCHESTRATION', 'Pandawa Multi-Agent System', 'Owner-approved runs through Core agentHub. Cancel stops queued runs; a running provider call finishes and its result is discarded.',
      '<button type="button" class="btn btn-primary" id="pandawaCreateTaskBtn">' + escapeHtml(L('+ Delegate Run')) + '</button>');
    var workers = runs ? runs.workers : [];
    var byId = {}; (ag ? ag.agents : []).forEach(function (a) { byId[a.id] = a; });
    var effModel = function (w) { return tmModels[w] ? escapeHtml(tmModels[w]) + ' <span style="color:var(--text-muted);">(diatur)</span>' : escapeHtml(pv ? pv.active + '/' + (pv.model || '-') : '-') + ' <span style="color:var(--text-muted);">(waris)</span>'; };
    html += panel('Pandawa Agent Registry', runs ? table(['Agent', 'Role', 'Model', 'Availability', 'Active runs', 'Completed'], workers.map(function (w) {
      var mine = runs.runs.filter(function (r) { return r.worker === w; });
      var a = byId[w] || {};
      return ['<div style="font-weight:700;color:var(--damar-gold-bright);">' + escapeHtml(a.label || w) + '</div><div style="font-size:10.5px;font-family:var(--font-mono);color:var(--text-muted);">pandawa:' + escapeHtml(w) + '</div>',
        '<span style="font-size:11.5px;color:var(--text-secondary);">' + escapeHtml(shortRole(a)) + '</span>',
        '<span style="font-size:11.5px;font-family:var(--font-mono);color:var(--text-secondary);">' + effModel(w) + '</span>', statusBadgeHtml(a.online === false ? 'OFFLINE' : 'ONLINE'),
        '<span class="td-num">' + mine.filter(function (r) { return TERMINAL.indexOf(r.state) < 0; }).length + '</span>', '<span class="td-num">' + mine.filter(function (r) { return r.state === 'COMPLETED'; }).length + '</span>'];
    })) : readState('runs', 'Pandawa runs'), { flush: true });
    var refs = modelRefs();
    var ppSel = function (m) { var cur = tmModels[m] || ''; var opts = cur && refs.indexOf(cur) < 0 ? refs.concat([cur]) : refs;
      return '<select class="select-field" id="pp_' + m + '" style="width:100%;"><option value=""' + (cur ? '' : ' selected') + '>' + escapeHtml(L('Inherit the main model')) + '</option>' + opts.map(function (r) { return '<option value="' + escapeHtml(r) + '"' + (r === cur ? ' selected' : '') + '>' + escapeHtml(r) + '</option>'; }).join('') + '</select>'; };
    html += panel('Model per Pandawa', '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
      ['werkudara', 'sadewa', 'puntadewa', 'nakula', 'janaka'].map(function (m) { return field('pp_' + m, m, ppSel(m)); }).join('') +
      '</div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;"><span style="font-size:11px;color:var(--text-muted);">Kosong berarti anggota itu mewarisi model utama DAMAR. Pilihan berlaku untuk run dan diskusi anggota tersebut, dan tersimpan di pengaturan Core.</span>' + btn('Save Pandawa models…', 'data-save-pandawa-models="1"', 'btn-primary') + '</div>', { span: 12 });
    html += panel('Run Ledger', runsTable(runs ? runs.runs.slice().reverse() : [], !runs), { flush: true, subtitle: runs ? runs.queued + ' queued' : '' });
    return html;
  }

  // Log page (Owner 2026-11-28): bound to GET /api/r9/logs, the session
  // journals Core always kept on disk. Real entries only; nothing simulated.
  function loadLogs() {
    if (state.logsLoading || (state.logsAt && Date.now() - state.logsAt < 5000)) return;
    state.logsLoading = true;
    core.get('/api/r9/logs').then(function (r) { state.logsLoading = false; state.logsAt = Date.now(); if (r.ok) { state.logs = (r.data && r.data.entries) || []; renderAll(); } });
  }
  // One human line per journal record (the route's structured projection); raw JSON stays as the fallback
  // for record shapes this formatter does not know.
  function logLine(e) {
    var r = e.row || {};
    var cut = function (s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
    if (e.file === 'agent-turn-history.jsonl') return (r.role === 'user' ? 'Pengguna: ' : r.role === 'assistant' ? 'Damar: ' : '') + cut(r.content, 260);
    if (e.file === 'usage-receipts.jsonl') return cut([r.provider, r.model].filter(Boolean).join(' / '), 80) + (r.member ? ' · ' + cut(r.member, 24) : '') + ' · masuk ' + num(r.inputTokens) + ' · keluar ' + num(r.outputTokens) + (r.status ? ' · ' + cut(r.status, 24) : '');
    if (e.file === 'agent-turns.jsonl') return cut(r.type || 'Giliran', 24) + (r.step ? ' · ' + cut(r.step, 200) : r.text ? ' · ' + cut(r.text, 200) : '') + (r.status ? ' · ' + cut(r.status, 24) : '');
    if (e.file === 'cli-sessions.jsonl') return cut(r.type || 'Sesi', 24) + (r.title ? ' · ' + cut(r.title, 80) : '') + (r.role && r.text ? ' · ' + cut(r.text, 160) : '');
    if (e.file === 'discussions.jsonl') return cut(r.type || 'Diskusi', 24) + (r.topic ? ' · ' + cut(r.topic, 160) : '');
    return e.text;
  }

  function renderLogsView() {
    loadLogs();
    var entries = state.logs || [];
    var body = entries.length ? entries.map(function (e) { return '<div style="display:flex;gap:10px;font-size:11.5px;padding:4px 0;border-top:1px solid rgba(255,255,255,.05);"><span style="color:var(--text-muted);flex:none;font-family:var(--font-mono);font-size:11px;">' + escapeHtml(e.t ? new Date(e.t).toLocaleTimeString('id-ID') : '·') + '</span><span style="color:var(--gold-champagne);flex:none;font-family:var(--font-mono);font-size:11px;">' + escapeHtml(e.file.replace('.jsonl', '')) + '</span><span style="color:var(--text-secondary);word-break:break-word;">' + escapeHtml(logLine(e)) + '</span></div>'; }).join('') : '<div style="font-size:12.5px;color:var(--text-secondary);">' + (state.logsAt ? 'Belum ada catatan pada sesi Core ini.' : 'Memuat log dari Core…') + '</div>';
    return pageHeader('DEVELOPMENT • CORE LOGS', 'Log', 'Catatan jurnal sesi Core ini: giliran agen, diskusi, pemakaian, dan sesi. Data asli dari Core.') + '<section class="panel"><div class="panel-body">' + body + '</div></section>';
  }

  function renderUnavailableView(id) {
    var u = UNAVAILABLE[id];
    return pageHeader(u.kicker, u.title, null) + '<section class="panel" data-unavailable="' + id + '"><div class="panel-header"><div class="panel-title-wrap"><h2 class="panel-title">' + escapeHtml(u.title) + '</h2></div>' +
      statusBadgeHtml('NOT_AVAILABLE', 'Belum tersedia') + '</div><div class="panel-body" style="display:flex;flex-direction:column;gap:8px;font-size:12.5px;color:var(--text-secondary);">' +
      '<div>' + escapeHtml(u.why) + '</div><div style="color:var(--text-muted);">Halaman ini tidak menampilkan data simulasi.</div></div></section>';
  }

  function renderMemoryView() {
    var ms = LIVE.d('memoryStats'), pm = state.memory;
    var html = pageHeader('DAMAR INTELLIGENCE • MEMORY & CONTINUITY', 'Memory & Continuity', 'Core memory statistics, Owner-approved project memory per workspace, and per-session undo/redo checkpoints.');
    html += '<div class="workspace-grid-12">';
    html += panel('Core Memory Store', ms ? kvList([kv('Memories', ms.memories.total + ' (' + ms.memories.pinned + ' pinned, ' + ms.memories.sensitive + ' sensitive)'), kv('Entities', num(ms.entities.total)),
      kv('Documents', ms.documents.total + ' (' + ms.documents.chunks + ' chunks)'), kv('Embeddings', ms.embeddings.available ? 'available (' + ms.embeddings.vectors + ' vectors)' : 'unavailable' + (ms.embeddings.lastError ? ', ' + ms.embeddings.lastError : ''))]) : readState('memoryStats', 'memory stats'), { span: 5 });
    var listing = '';
    if (pm && pm.ok) listing = table(['Note', 'Added', ''], (Array.isArray(pm.data) ? pm.data : []).map(function (n) { return [escapeHtml(n.text), escapeHtml(when(n.t || n.createdAt)), btn('Forget', 'data-forget-memory="' + escapeHtml(n.id) + '"', 'btn-danger')]; }), 'No project memory for this workspace.');
    else if (pm) listing = '<div style="font-size:12px;">' + statusBadgeHtml('ERROR', pm.error) + '</div>';
    html += panel('Project Memory', '<div style="display:flex;flex-direction:column;gap:10px;"><label for="memoryRootInput" style="font-size:11.5px;color:var(--text-secondary);">Workspace folder (absolute path)</label>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;"><input type="text" class="input-field" id="memoryRootInput" style="flex:1;min-width:200px;font-family:var(--font-mono);" value="' + escapeHtml(state.workspace) + '" />' + btn('List', 'data-memory-list="1"', 'btn-primary') + btn('Add note…', 'data-memory-add="1"') + '</div>' + listing + '</div>', { span: 7 });
    html += '</div>';
    var ss = LIVE.d('sessions');
    html += panel('Checkpoints (undo / redo)', ss ? table(['Session', 'State', 'Checkpoints', ''], ss.sessions.map(function (s) {
      var c = state.checkpoints[s.sessionId];
      var info = !c ? '-' : c.ok ? escapeHtml(JSON.stringify(c.data).slice(0, 160)) : statusBadgeHtml('ERROR', c.error);
      var held = state.control.held[s.sessionId];
      return [escapeHtml(s.title) + ' ' + mono(s.sessionId.slice(0, 8)), statusBadgeHtml(s.closed ? 'CLOSED' : s.attached ? 'ATTACHED' : 'IDLE'), '<span style="font-size:11.5px;">' + info + '</span>',
        s.closed ? '' : (s.attached && !held ? '<span style="font-size:11px;color:var(--text-muted);">held by a CLI window</span>' : btn(held ? 'Refresh' : 'Attach & list', 'data-checkpoints="' + escapeHtml(s.sessionId) + '"') + (held ? ' ' + btn('Undo…', 'data-undo="' + escapeHtml(s.sessionId) + '"') + ' ' + btn('Redo…', 'data-redo="' + escapeHtml(s.sessionId) + '"') : ''))];
    }), 'No sessions.') : readState('sessions', 'sessions'), { flush: true, subtitle: 'Attaching takes the session lease; a CLI window holding it is never displaced.' });
    return html;
  }

  function renderCliView() {
    var ss = LIVE.d('sessions');
    var html = pageHeader('DEVELOPMENT • DAMAR CLI', 'Damar CLI', 'The CLI is a terminal surface on the same Core. Control lists its sessions; it does not emulate a terminal.');
    html += '<div class="workspace-grid-12">';
    html += panel('Launch', kvList([kv('Command', 'damar.cmd', true), kv('Resume a session', 'damar resume <sessionId>', true), kv('Core endpoint', state.endpoint || 'same origin', true)]), { span: 5 });
    html += panel('CLI Sessions', ss ? table(['Title', 'Attached', 'Messages', 'Sub-agent runs'], ss.sessions.map(function (s) { return [escapeHtml(s.title), statusBadgeHtml(s.attached ? 'ATTACHED' : 'IDLE'), '<span class="td-num">' + num(s.messages) + '</span>', '<span class="td-num">' + num(s.subagentRuns) + '</span>']; }), 'No CLI sessions.') : readState('sessions', 'sessions'), { span: 7, flush: true });
    return html + '</div>';
  }

  function renderRuntimeView() {
    var lc = LIVE.d('lifecycle'), sb = LIVE.d('sandbox'), cx = LIVE.d('context');
    var html = pageHeader('DEVELOPMENT • CORE RUNTIME', 'Runtime', 'Core lifecycle and enforced sandbox boundary. Restart is an Owner action: Core refuses while work is outstanding.');
    html += '<div class="workspace-grid-12">';
    html += panel('Lifecycle', lc ? kvList([kv('State', lc.state.state), kv('Reason', lc.state.reason || '-'), kv('Updated', when(lc.state.updatedAt)), kv('Restart attempts', num(lc.state.attempt)),
      kv('Active turns', num(lc.outstanding.activeTurns)), kv('Pending permissions', num(lc.outstanding.pendingPermissions)), kv('Active Pandawa runs', num(lc.outstanding.activePandawaRuns)),
      kv('Queued Pandawa runs', num(lc.outstanding.queuedPandawaRuns)), kv('Active jobs', num(lc.outstanding.activeJobs)), kv('Job state available', lc.outstanding.jobStateAvailable ? 'yes' : 'no'),
      kv('Restart limit', lc.restartLimit + ' per ' + lc.restartWindowSeconds + ' s')]) +
      '<div style="display:flex;justify-content:flex-end;margin-top:12px;">' + btn('Restart Core…', 'data-lifecycle-restart="1"', 'btn-danger') + '</div>' : readState('lifecycle', 'lifecycle'), { span: 6, badge: lc ? statusBadgeHtml(lc.state.state) : '' });
    html += panel('Host', cx ? kvList([kv('Host', cx.system.host), kv('CPU', cx.system.cpu + ' %'), kv('Memory', cx.system.memory + ' %'), kv('Core uptime', Math.round(cx.system.uptime) + ' s'), kv('AI platform', cx.ai.platform), kv('Model', cx.ai.model || '-')]) : readState('context', 'context'), { span: 6 });
    html += panel('Sandbox Boundary', sb ? kvList(Object.keys(sb).map(function (k) { return kv(k, Array.isArray(sb[k]) ? sb[k].join(' • ') : String(sb[k])); })) : readState('sandbox', 'sandbox'), { span: 12 });
    return html + '</div>';
  }

  function renderDiagnosticsView() {
    var html = pageHeader('DEVELOPMENT • DIAGNOSTICS', 'Diagnostics', 'Measured from this browser: status and latency of every Core read Control uses.', btn('Re-run checks', 'data-run-diagnostics="1"', 'btn-primary'));
    var keys = Object.keys(READS);
    return html + panel('Core route checks', table(['Read', 'Route', 'Status', 'Latency'], keys.map(function (k) {
      var r = state.core[k];
      return [escapeHtml(k), mono(READS[k]), r ? statusBadgeHtml(r.ok ? 'OK' : 'ERROR', r.ok ? String(r.status) : (r.status || 'offline') + ' ' + r.error) : '-', '<span class="td-num">' + (r && r.ms !== undefined ? r.ms + ' ms' : '-') + '</span>'];
    })), { flush: true });
  }

  // Authority Gate mode: the single autonomy setting resolved the same way the broker resolves it
  // (gateMode in agent-turns.cjs). Legacy stored profiles resolve to Mandat; the surfaces write only
  // the canonical values.
  function gateModeOf(profile) { return profile === 'read-only' ? 'read-only' : profile === 'tanya' ? 'tanya' : profile === 'nonaktif' ? 'nonaktif' : 'mandat'; }
  function gateModeLabel(mode) { return mode === 'tanya' ? 'Tanya dulu' : mode === 'nonaktif' ? 'Nonaktif' : mode === 'read-only' ? 'Hanya baca' : 'Mandat'; }
  var GATE_MODE_INFO = {
    mandat: 'Permintaan Anda adalah mandatnya. Kartu izin hanya muncul untuk tindakan yang menyentuh kredensial dan penghapusan; langkah biasa berjalan tanpa kartu.',
    tanya: 'Setiap tindakan berdampak meminta persetujuan Anda lebih dulu lewat kartu izin, termasuk langkah biasa.',
    nonaktif: 'Kartu izin dimatikan. Semua tindakan berjalan langsung dan tetap tercatat di riwayat persetujuan dengan tanda mode Nonaktif. Evaluasi Authority dan audit di dalam tool tetap berjalan.',
    'read-only': 'Semua tindakan berdampak ditolak tanpa bertanya.'
  };
  function gateModePanel(st) {
    if (!st || !st.ok) return panel('Mode Authority Gate', '<div style="font-size:12px;color:var(--text-secondary);">Pengaturan Core belum termuat. Buka halaman Pengaturan atau muat ulang halaman ini.</div>', { span: 12 });
    var mode = gateModeOf(st.data.autonomy);
    var opts = ['mandat', 'tanya', 'nonaktif']; if (mode === 'read-only') opts.push('read-only');
    var body = '<div style="display:flex;flex-direction:column;gap:12px;">' +
      '<div><div style="font-size:11.5px;color:var(--text-secondary);">Mode yang berlaku sekarang</div>' +
      '<div style="font-size:20px;font-weight:700;color:var(--text-ivory);">' + escapeHtml(gateModeLabel(mode)) + '</div>' +
      '<div style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(GATE_MODE_INFO[mode]) + '</div></div>' +
      '<div><label for="gateMode" style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:5px;">Ubah mode</label>' +
      '<select class="select-field" id="gateMode">' + opts.map(function (m) { return '<option value="' + m + '"' + (m === mode ? ' selected' : '') + '>' + gateModeLabel(m) + '</option>'; }).join('') + '</select></div>' +
      '<div style="font-size:11.5px;color:var(--text-muted);display:flex;flex-direction:column;gap:3px;">' +
      '<div><strong style="color:var(--text-secondary);">Mandat</strong>: ' + escapeHtml(GATE_MODE_INFO.mandat) + '</div>' +
      '<div><strong style="color:var(--text-secondary);">Tanya dulu</strong>: ' + escapeHtml(GATE_MODE_INFO.tanya) + '</div>' +
      '<div><strong style="color:var(--text-secondary);">Nonaktif</strong>: ' + escapeHtml(GATE_MODE_INFO.nonaktif) + '</div></div>' +
      '<div style="display:flex;justify-content:flex-end;">' + btn('Simpan mode…', 'data-save-gate-mode="1"', 'btn-primary') + '</div></div>';
    return panel('Mode Authority Gate', body, { span: 12 });
  }

  function renderSecurityView() {
    var sf = LIVE.d('safety'), lc = LIVE.d('lifecycle'), gr = LIVE.d('grant'), st = state.settings;
    if (!st) ensureSettings();
    var html = pageHeader('ADMINISTRATION • SECURITY & GOVERNANCE', 'Security & Governance', 'Safety state, agent permission profile and authority boundaries as Core enforces them.');
    html += '<div class="workspace-grid-12">';
    html += gateModePanel(st);
    html += panel('Safety', sf ? kvList([kv('Emergency stop', sf.stopped ? 'ENGAGED' + (sf.reason ? ', ' + sf.reason : '') : 'off'), kv('Engaged', sf.engaged ? 'yes' : 'no'), kv('Tools', sf.risk.total + ' total • ' + sf.risk.destructive + ' destructive • ' + sf.risk.safe + ' safe'),
      kv('Policy enforcement', sf.policy && sf.policy.enforcement && sf.policy.enforcement.enabled ? 'enabled' : 'disabled')]) : readState('safety', 'safety'), { span: 6, badge: sf ? statusBadgeHtml(sf.stopped ? 'STOPPED' : 'READY', sf.stopped ? 'stopped' : 'running') : '' });
    var af = LIVE.d('activityFeed'), afAnswers = {}, afHist = [];
    if (af && af.events) { af.events.forEach(function (e) { if (e.kind === 'permission_answer') afAnswers[e.permissionId] = e; }); af.events.forEach(function (e) { if (e.kind === 'permission') afHist.push(e); }); afHist = afHist.slice(-8).reverse(); }
    var afHistHtml = afHist.length ? '<div style="margin-top:10px;font-size:11.5px;color:var(--text-secondary);"><div style="color:var(--text-ivory);font-weight:600;margin-bottom:4px;">Riwayat persetujuan (sesi Core ini)</div>' + afHist.map(function (h) { var a = afAnswers[h.permissionId]; var dec = a ? (a.decision === 'once' && a.mode === 'nonaktif' ? 'Disetujui otomatis (Gate Nonaktif)' : a.decision === 'once' ? 'Disetujui sekali' : a.decision === 'session' ? 'Disetujui untuk sesi' : 'Ditolak') : 'Tanpa jawaban'; return '<div style="padding:3px 0;border-top:1px solid rgba(255,255,255,.05);">' + escapeHtml(h.tool || 'Tindakan') + ' · ' + dec + (h.detail ? ' · ' + escapeHtml(String(h.detail).slice(0, 80)) : '') + (h.at ? ' · ' + escapeHtml(new Date(h.at).toLocaleTimeString('id-ID')) : '') + '</div>'; }).join('') + '</div>' : '';
    html += panel('Permissions', kvList([kv('Pending permission requests', lc ? String(lc.outstanding.pendingPermissions) : '-'), kv('Agent autonomy profile', st && st.ok ? gateModeLabel(gateModeOf(st.data.autonomy)) : 'load in Settings'),
      kv('Live model grant', gr ? (gr.effective ? 'effective' : 'none') : '-'), kv('Approvals', 'diputuskan di Presence (inline pada percakapan) atau CLI pemilik giliran')]) +
      '<div style="font-size:11.5px;color:var(--text-muted);margin-top:10px;">Persetujuan eksplisit hanya untuk tindakan yang menyentuh kredensial dan penghapusan; langkah biasa berjalan dengan mandat permintaan pemilik.</div>' + afHistHtml, { span: 6 });
    return html + '</div>';
  }

  function renderSettingsView() {
    var st = state.settings;
    if (!st) ensureSettings();
    var html = pageHeader('ADMINISTRATION • CORE SETTINGS', 'Settings', 'Persistent Core settings (Owner). Changes take effect for every session on this Core profile.');
    if (!st || !st.ok) return html + panel('Core Settings', '<div style="display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--text-secondary);"><div>Settings are read and written through an Owner Control session on Core.</div>' +
      (st ? '<div>' + statusBadgeHtml('ERROR', st.error) + '</div>' : '') + '<div>' + btn('Load settings from Core', 'data-load-settings="1"', 'btn-primary') + '</div></div>');
    var d = st.data, profiles = [['mandat', 'Mandat'], ['tanya', 'Tanya dulu'], ['nonaktif', 'Nonaktif'], ['read-only', 'Hanya baca (read-only)']];
    var curGateMode = gateModeOf(d.autonomy);
    html += '<div class="workspace-grid-12">';
    html += panel('Agent Permissions', '<div style="display:flex;flex-direction:column;gap:12px;"><label for="settingsAutonomy" style="font-size:11.5px;color:var(--text-secondary);">Mode Authority Gate</label><select class="select-field" id="settingsAutonomy">' +
      profiles.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === curGateMode ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select>' +
      '<label for="settingsRouting" style="font-size:11.5px;color:var(--text-secondary);">Skill routing</label><select class="select-field" id="settingsRouting">' + ['auto', 'off'].map(function (p) { return '<option value="' + p + '"' + (p === d.skills.routing ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select>' +
      '<div style="display:flex;justify-content:flex-end;">' + btn('Save…', 'data-save-settings="1"', 'btn-primary') + '</div></div>', { span: 6 });
    html += panel('Workspace Access', kvList([kv('Extra folders', d.extraDirs.length ? d.extraDirs.join(' • ') : 'none'), kv('Updated', d.updatedAt ? when(d.updatedAt) : 'never'), kv('Control session', state.control.id ? state.control.id.slice(0, 12) + '…' : '-', true)]), { span: 6 });
    var tb = d.tokenBudget || { totalTokens: null, maxOutputTokens: null, completions: null };
    html += panel('Anggaran Token', '<div style="display:flex;flex-direction:column;gap:12px;">' +
      '<div style="font-size:11.5px;color:var(--text-secondary);">Pemakaian token adalah urusan pengguna. Kosongkan untuk tanpa batas; Damar tidak memotong giliran, diskusi, atau tugas karena anggaran kecuali Anda mengisinya sendiri. Laporan pemakaian tetap tampil di Diagnostik.</div>' +
      field('tbTotal', 'Total token per sesi Core (kosong = tanpa batas)', '<input type="number" class="input-field" id="tbTotal" min="1000" style="width:100%;" value="' + (tb.totalTokens == null ? '' : escapeHtml(tb.totalTokens)) + '" />') +
      field('tbOutput', 'Token keluaran maksimum per permintaan (kosong = tanpa batas)', '<input type="number" class="input-field" id="tbOutput" min="256" style="width:100%;" value="' + (tb.maxOutputTokens == null ? '' : escapeHtml(tb.maxOutputTokens)) + '" />') +
      field('tbCompletions', 'Jumlah permintaan per sesi Core (kosong = tanpa batas)', '<input type="number" class="input-field" id="tbCompletions" min="1" style="width:100%;" value="' + (tb.completions == null ? '' : escapeHtml(tb.completions)) + '" />') +
      '<div style="display:flex;justify-content:flex-end;">' + btn('Simpan anggaran…', 'data-save-token="1"', 'btn-primary') + '</div></div>', { span: 6 });
    var pr = (LIVE.d('presence') && LIVE.d('presence').presence) || d.presence || {};
    var sel = function (id, opts, cur) { return '<select class="select-field" id="' + id + '" style="width:100%;">' + opts.map(function (o) { return '<option value="' + escapeHtml(o) + '"' + (o === cur ? ' selected' : '') + '>' + escapeHtml(o) + '</option>'; }).join('') + '</select>'; };
    html += panel('Idle Presence & Notch', '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">' +
      field('prIdleOrb', 'Presence → orb (detik, 5–3600)', '<input type="number" class="input-field" id="prIdleOrb" min="5" max="3600" style="width:100%;" value="' + escapeHtml(pr.idleToOrbSec) + '" />') +
      field('prOrbNotch', 'Orb → Notch (detik, 5–3600)', '<input type="number" class="input-field" id="prOrbNotch" min="5" max="3600" style="width:100%;" value="' + escapeHtml(pr.orbToNotchSec) + '" />') +
      field('prNotchHide', 'Notch sembunyi (detik, 10–86400)', '<input type="number" class="input-field" id="prNotchHide" min="10" max="86400" style="width:100%;" value="' + escapeHtml(pr.notchHideSec) + '" />') +
      field('prCharSound', 'Suara karakter', sel('prCharSound', ['enabled', 'disabled'], pr.characterSoundEnabled === false ? 'disabled' : 'enabled')) +
      field('prCharVol', 'Volume suara karakter (%, 0–100)', '<input type="number" class="input-field" id="prCharVol" min="0" max="100" style="width:100%;" value="' + escapeHtml(pr.characterSoundVolume) + '" />') +
      field('prMorph', 'Morph duration (ms, 0–5000)', '<input type="number" class="input-field" id="prMorph" min="0" max="5000" style="width:100%;" value="' + escapeHtml(pr.morphMs) + '" />') +
      field('prMotion', 'Reduced motion', sel('prMotion', ['system', 'on', 'off'], pr.reducedMotion)) +
      field('prNotch', 'Notch', sel('prNotch', ['enabled', 'disabled'], pr.notchEnabled === false ? 'disabled' : 'enabled')) +
      field('prPrivacy', 'Notification privacy', sel('prPrivacy', ['redacted', 'counts-only', 'hidden'], pr.notificationPrivacy)) +
      field('prDisplay', 'Display', '<input type="text" class="input-field" id="prDisplay" maxlength="64" style="width:100%;font-family:var(--font-mono);" value="' + escapeHtml(pr.display) + '" />') +
      field('prPosition', 'Position', sel('prPosition', ['top-center'], pr.position)) +
      field('prVoice', 'Microphone / voice (opt-in)', sel('prVoice', ['off', 'on'], pr.voiceEnabled === true ? 'on' : 'off')) +
      field('prName', 'Your name (greeting, optional)', '<input type="text" class="input-field" id="prName" maxlength="40" style="width:100%;" value="' + escapeHtml(pr.displayName || '') + '" />') +
      field('prSalutation', 'How DAMAR addresses you (optional)', '<input type=\"text\" class=\"input-field\" id=\"prSalutation\" maxlength=\"40\" style=\"width:100%;\" value=\"' + escapeHtml(pr.salutation || '') + '\" />') +
      '</div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;"><span style="font-size:11px;color:var(--text-muted);">Presence membaca ini dari Core (GET /api/r9/presence/settings) · revisi ' + escapeHtml(num(d.revision)) + '</span>' + btn('Save presence…', 'data-save-presence="1"', 'btn-primary') + '</div>', { span: 12 });
    var cl = LIVE.d('cliSettings'), cv = cl ? (cl.cli || cl.defaults) : null;
    html += panel('Damar CLI', cv ? '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;">' +
      field('cliTheme', 'Theme', sel('cliTheme', ['damar-ember', 'damar-holo', 'cyberpunk', 'tokyonight', 'emerald'], cv.theme)) +
      field('cliBanner', 'Banner', sel('cliBanner', ['flame', 'static'], cv.animateBanner ? 'flame' : 'static')) +
      field('cliLanguage', 'Interface language (CLI & Control)', sel('cliLanguage', ['en', 'id'], cv.language)) +
      field('cliHud', 'HUD dock', sel('cliHud', ['left', 'right', 'bottom', 'hidden'], cv.hudPosition)) + '</div><div style="margin-top:12px;">' +
      kvList([kv('Last provider / model', cl.lastSelection ? cl.lastSelection.provider + ' / ' + cl.lastSelection.model : '-'), kv('Source', cl.cli ? 'Core settings (shared with the CLI Settings screen)' : 'defaults (not set yet)')]) +
      '</div><div style="display:flex;justify-content:flex-end;margin-top:10px;">' + btn('Save CLI settings…', 'data-save-cli="1"', 'btn-primary') + '</div>'
      : readState('cliSettings', 'CLI settings') || '', { span: 6 });
    var cg = d.cognitive || {}, num1 = function (id, label, min, max, v) { return field(id, label, '<input type="number" class="input-field" id="' + id + '" min="' + min + '" max="' + max + '" style="width:100%;" value="' + escapeHtml(v) + '" />'); };
    html += panel('Memory & Context', '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">' +
      field('cgMemory', 'Long-term memory', sel('cgMemory', ['on', 'off'], cg.memoryEnabled === false ? 'off' : 'on')) +
      field('cgConsent', 'Ask before remembering', sel('cgConsent', ['always', 'autonomy'], cg.memoryConsent)) +
      num1('cgRetention', 'Keep memories (days, 0 = forever)', 0, 3650, cg.memoryRetentionDays) +
      num1('cgContext', 'Memory in context (chars, 500-20000)', 500, 20000, cg.memoryContextChars) +
      num1('cgTurns', 'Conversation turns kept (0-50)', 0, 50, cg.historyTurns) +
      num1('cgChars', 'Conversation chars kept (2000-400000)', 2000, 400000, cg.historyChars) +
      field('cgMind', 'Core mind block', sel('cgMind', ['on', 'off'], cg.mind)) +
      '</div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;"><span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(L('Project memory export / clear uses the workspace folder from Memory & Continuity.')) + '</span><span style="display:flex;gap:8px;">' +
      btn('Export memory…', 'data-memory-export="1"') + btn('Clear workspace memory…', 'data-memory-clear="1"', 'btn-danger') + btn('Save memory settings…', 'data-save-cognitive="1"', 'btn-primary') + '</span></div>', { span: 12 });
    var tm = d.pandawa || { models: {}, discussion: {} }, refs = modelRefs();
    var refSel = function (m) { var cur = tm.models[m] || ''; var opts = refs.indexOf(cur) < 0 && cur ? refs.concat([cur]) : refs;
      return '<select class="select-field" id="pm_' + m + '" style="width:100%;"><option value=""' + (cur ? '' : ' selected') + '>' + escapeHtml(L(m === 'damar' ? 'Active provider' : "DAMAR's model")) + '</option>' + opts.map(function (r) { return '<option value="' + escapeHtml(r) + '"' + (r === cur ? ' selected' : '') + '>' + escapeHtml(r) + '</option>'; }).join('') + '</select>'; };
    html += panel('Pandawa Team', '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
      ['damar', 'puntadewa', 'werkudara', 'janaka', 'nakula', 'sadewa'].map(function (m) { return field('pm_' + m, m, refSel(m)); }).join('') +
      num1('pdRounds', 'Debate cycle safety limit (1-100)', 1, 100, (tm.discussion || {}).maxRounds) + field('pdBudget', 'Anggaran token per diskusi (kosong = tanpa batas)', '<input type="number" class="input-field" id="pdBudget" min="1000" style="width:100%;" value="' + ((tm.discussion || {}).tokenBudget == null ? '' : escapeHtml((tm.discussion || {}).tokenBudget)) + '" />') +
      num1('pdTimeout', 'Time limit per member reply (seconds, 30-1800)', 30, 1800, (tm.discussion || {}).callTimeoutSec) +
      '</div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;"><span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(L('Model options come from your connected providers. Empty = DAMAR\'s model (or the active provider for DAMAR).')) + '</span>' + btn('Save team…', 'data-save-team="1"', 'btn-primary') + '</div>', { span: 12 });
    var vx = d.voice || {}, vnum = function (id, label, min, max, step, v) { return field(id, label, '<input type="number" class="input-field" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" style="width:100%;" value="' + escapeHtml(v) + '" />'); };
    html += panel('Voice', '<div style="display:flex;flex-direction:column;gap:6px;">' +
      '<label for="vcPitch" style="font-size:11.5px;color:var(--text-secondary);">Voice pitch (semitones, -12 to +12), <span id="vcPitchVal" style="color:var(--text-primary);font-family:var(--font-mono);">' + escapeHtml(vx.pitchSemitones) + '</span></label>' +
      '<input type="range" class="input-field" id="vcPitch" min="-12" max="12" step="0.5" style="width:100%;" value="' + escapeHtml(vx.pitchSemitones) + '" oninput="document.getElementById(\'vcPitchVal\').textContent=this.value" />' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:6px;">' +
      field('vcStyle', 'Voice style', sel('vcStyle', ['normal', 'jarvis'], vx.style)) +
      vnum('vcJarvisPitch', 'Jarvis pitch offset (semitones, -6 to 0)', -6, 0, 0.5, vx.jarvisPitchSemitones) +
      vnum('vcRingHz', 'Jarvis ring modulator (Hz, 5-120)', 5, 120, 1, vx.jarvisRingModHz) +
      vnum('vcRingDepth', 'Jarvis ring depth (0-0.9)', 0, 0.9, 0.05, vx.jarvisRingModDepth) +
      vnum('vcReverbWet', 'Jarvis reverb wet (0-0.5)', 0, 0.5, 0.01, vx.jarvisReverbWet) +
      vnum('vcReverbDecay', 'Jarvis reverb decay (ms, 40-400)', 40, 400, 10, vx.jarvisReverbDecayMs) +
      vnum('vcEqLow', 'Jarvis EQ low shelf (dB, -6 to 6)', -6, 6, 0.5, vx.jarvisEqLowDb) +
      vnum('vcEqPresence', 'Jarvis EQ presence (dB, -6 to 6)', -6, 6, 0.5, vx.jarvisEqPresenceDb) +
      vnum('vcEqHigh', 'Jarvis EQ high shelf (dB, -6 to 6)', -6, 6, 0.5, vx.jarvisEqHighDb) +
      '</div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;"><span style="font-size:11px;color:var(--text-muted);">Pitch and the Jarvis robot preset are post-processing on the local Supertonic M1 output, Indonesian synthesis is unchanged.</span>' + btn('Save voice…', 'data-save-voice="1"', 'btn-primary') + '</div></div>', { span: 12 });
    html += panel('Mobile', '<div data-unavailable="mobile" style="font-size:12px;color:var(--text-secondary);">' + statusBadgeHtml('NOT_AVAILABLE', 'Belum tersedia') + ' Damar Mobile belum terhubung sebagai pendamping. Core saat ini tidak menyimpan pengaturan mobile; pengaturan tampil di sini saat pendamping terhubung.</div>', { span: 6 });
    var pv = LIVE.d('provider');
    var pvRows = pv ? pv.providers.filter(function (p) { return p.kind === 'live' && !p.virtual; }).map(function (p) {
      return '<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--border-subtle);">' + ppTile(p.id, p.label) +
        '<span style="flex:1;font-size:12.5px;color:var(--text-ivory);">' + escapeHtml(p.label) + '<br /><span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">' + escapeHtml(p.model || '') + '</span></span>' + ppConnBadge(p, pv) + '</div>';
    }).join('') : '';
    html += panel('Providers & Models', kvList([kv('Active provider', pv ? pv.active : '-'), kv('Active model', pv ? (pv.model || '-') : '-'), kv('Live inference', pv ? (pv.liveInference ? 'authorized' : 'not authorized') : '-')]) + pvRows +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">' + btn('Providers →', 'data-jump-view="providers"') + btn('Models →', 'data-jump-view="models"') + '</div>', { span: 6 });
    html += helpPanel();
    html += panel('Project Plugins', table(['Plugin', 'Trusted', ''], (d.plugins || []).map(function (p) { return [escapeHtml(p.name), statusBadgeHtml(p.trusted ? 'TRUSTED' : p.error ? 'ERROR' : 'DISABLED', p.trusted ? 'trusted' : p.error || (p.changedSinceTrust ? 'changed since trust' : 'untrusted')), p.key ? btn(p.trusted ? 'Untrust…' : 'Trust…', 'data-trust-plugin="' + escapeHtml(p.key) + '" data-trusted="' + (!p.trusted) + '"') : '']; }), 'No project plugins in the Control session workspace.'), { span: 12, flush: true });
    return html + '</div>';
  }

  // '<connection>/<model>' choices for the Pandawa pickers, from Core's provider list and the models it reported.
  function modelRefs() {
    var pv = LIVE.d('provider'), out = [];
    (pv ? pv.providers : []).forEach(function (p) { var m = state.models[p.id]; (m && m.ok ? m.data.models : (p.model ? [p.model] : [])).forEach(function (x) { if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(p.id)) out.push(p.id + '/' + x); }); });
    return out.filter(function (v, i) { return out.indexOf(v) === i; });
  }
  function helpPanel() {
    var sl = root.DAMAR_SUPPORT || {};
    var link = function (href, text) { return href ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer" style="color:var(--gold-champagne);">' + escapeHtml(L(text)) + '</a>' : ''; };
    return panel('Help & Support', '<ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.9;">' +
      '<li>' + escapeHtml(L('Report a problem')) + ': ' + link(sl.issues, 'GitHub Issues') + '</li>' +
      '<li>' + escapeHtml(L('Questions and ideas')) + ': ' + link(sl.discussions, 'GitHub Discussions') + '</li>' +
      '<li>' + escapeHtml(L('License')) + ': ' + escapeHtml(sl.license || 'MIT') + ' · ' + escapeHtml(L('DAMAR is free and open source.')) + '</li></ul>', { span: 6 });
  }
  var VIEWS = {
    overview: renderOverviewView, activity: renderSessionsView, tasks: renderUsageView, capabilities: function () { return renderCapabilitiesView(); },
    skills: function () { return renderCapabilitiesView('Skills'); }, plugins: function () { return renderCapabilitiesView('Plugins'); }, mcp: function () { return renderCapabilitiesView('MCP'); },
    models: renderModelsView, providers: renderProvidersView, pandawa: renderPandawaView, discussions: renderDiscussionsView, memory: renderMemoryView, cli: renderCliView, runtime: renderRuntimeView,
    diagnostics: renderDiagnosticsView, security: renderSecurityView, settings: renderSettingsView,
    matadewa: function () { return renderUnavailableView('matadewa'); }, cyber: function () { return renderUnavailableView('cyber'); },
    automations: function () { return renderUnavailableView('automations'); }, logs: renderLogsView
  };
  function renderView(id, s) { if (s) state = s; return (VIEWS[id] || VIEWS.overview)(); }

  // ==========================================================================
  // 6. CORE DATA LOADING & OWNER ACTIONS
  // ==========================================================================
  function refresh() {
    var keys = Object.keys(READS);
    return Promise.all(keys.map(function (k) { return core.get(READS[k]).then(function (r) { state.core[k] = r; }); })).then(function () {
      state.loaded = true;
      var cs = LIVE.d('cliSettings'); if (cs) LANG = (cs.cli || cs.defaults).language === 'id' ? 'id' : 'en';
      // Changes made in the CLI (or another Control) show up here: re-read session-bound settings while held.
      if (state.settings && state.settings.ok && state.control.id && state.control.held[state.control.id])
        core.post('/api/r9/settings', { action: 'read', cliSession: state.control.id, client: state.control.client }).then(function (r) { if (r.ok) state.settings = r; });
      var pv = LIVE.d('provider');
      if (pv && (state.activeView === 'models' || !Object.keys(state.models).length))
        return Promise.all(pv.providers.map(function (p) { return core.get('/api/r9/models?provider=' + encodeURIComponent(p.id)).then(function (r) { state.models[p.id] = r; }); }));
    });
  }

  function newClientId() { var a = new Uint8Array(12); root.crypto.getRandomValues(a); return 'ctl_' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function store(k, v) { try { if (v === null) root.localStorage.removeItem(k); else root.localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }

  // The Owner Control session: a normal Core session (same ledger, same lease rules) used for session-bound routes.
  function controlSession() {
    var c = state.control;
    if (c.id && c.held[c.id]) return Promise.resolve(c.id);
    var attach = c.id ? core.post('/api/r9/sessions/' + c.id + '/attach', { client: c.client }) : Promise.resolve({ ok: false });
    return attach.then(function (a) {
      if (a.ok) return c.id;
      return core.post('/api/r9/sessions', { client: c.client, cwd: state.workspace || 'DAMAR Control', title: 'DAMAR Control' }).then(function (r) {
        if (!r.ok) throw r;
        c.id = r.data.sessionId; store('damar.control.session', c.id); return c.id;
      });
    }).then(function (id) { c.held[id] = true; return id; });
  }
  function holdSession(id) {
    return core.post('/api/r9/sessions/' + id + '/attach', { client: state.control.client }).then(function (r) { if (!r.ok) throw r; state.control.held[id] = true; return id; });
  }
  // Lease heartbeat for every session Control holds (empty event batch, the CLI's own pattern).
  function heartbeat() {
    Object.keys(state.control.held).forEach(function (id) {
      core.post('/api/r9/sessions/' + id + '/events', { client: state.control.client, events: [] }).then(function (r) { if (!r.ok) delete state.control.held[id]; });
    });
  }

  function loadSettings() {
    return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'read', cliSession: id, client: state.control.client }); })
      .then(function (r) { state.settings = r; }, function (r) { state.settings = r && r.error ? r : { ok: false, error: 'CONTROL_SESSION_FAILED' }; }).then(renderAll);
  }

  // Pusat Kapabilitas management state (MCP servers, plugins, profile skills)
  // from the Owner-only kapabilitas binding; loaded on open like settings.
  function loadKapabilitas() {
    return core.get('/api/r9/kapabilitas')
      .then(function (r) { state.kapabilitas = r; }, function (r) { state.kapabilitas = r && r.error ? r : { ok: false, error: 'KAPABILITAS_READ_FAILED' }; }).then(renderAll);
  }
  function ensureKapabilitas() {
    if (state.kapabilitas || state.kapabilitasLoading) return;
    state.kapabilitasLoading = true;
    loadKapabilitas().then(function () { state.kapabilitasLoading = false; }, function () { state.kapabilitasLoading = false; });
  }
  // The guided MCP form's fields -> the registry entry shape configStore accepts.
  function kapMcpEntry() {
    var env = {};
    val('kmEnv').split(/\r?\n/).forEach(function (line) { var i = line.indexOf('='); if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
    var tools = val('kmTools') ? val('kmTools').split(',').map(function (s) { return s.trim(); }).filter(Boolean) : null;
    var entry = { id: val('kmId'), command: val('kmCommand'), args: val('kmArgs') };
    if (val('kmCwd')) entry.cwd = val('kmCwd');
    if (Object.keys(env).length) entry.env = env;
    if (tools) entry.allowedTools = tools;
    return entry;
  }

  // Settings back several pages (Pengaturan itself, the Skills tab, the Keamanan autonomy line): like every
  // other page they load on open instead of waiting for a manual "load" click. One request in flight at most.
  function ensureSettings() {
    if (state.settings || state.settingsLoading) return;
    state.settingsLoading = true;
    loadSettings().then(function () { state.settingsLoading = false; }, function () { state.settingsLoading = false; });
  }

  // Confirm dialog -> Core mutation -> toast with Core's own result/error; then re-read Core.
  function ownerAction(title, bodyHtml, run, note) {
    var dlg = document.getElementById('actionModalBackdrop');
    document.getElementById('actionModalTitle').textContent = L(title);
    document.getElementById('actionModalBody').innerHTML = bodyHtml;
    document.getElementById('actionModalError').textContent = '';
    document.getElementById('actionModalNote').textContent = L(note || 'Core enforces Owner authority; nothing changes until Core accepts.');
    var submit = document.getElementById('submitActionModalBtn');
    submit.disabled = false;
    submit.onclick = function () {
      submit.disabled = true;
      Promise.resolve().then(run).then(function (res) {
        if (res && res.ok === false) { document.getElementById('actionModalError').textContent = describeFailure(res); submit.disabled = false; return; }
        closeCc2Dialog(dlg); state.formDirty = false; showToast(L(title) + ': ' + L('accepted by Core'));
        return refresh().then(renderAll);
      }, function (e) { document.getElementById('actionModalError').textContent = e && e.error ? describeFailure(e) : 'Control error: ' + String(e && e.message || e); submit.disabled = false; });
    };
    openCc2Dialog(dlg, dlg.querySelector('input, select, textarea') || submit);
  }
  function field(id, label, input) { return '<div><label for="' + id + '" style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:5px;">' + escapeHtml(L(label)) + '</label>' + input + '</div>'; }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function providerById(id) { var pv = LIVE.d('provider'); return pv ? pv.providers.filter(function (p) { return p.id === id; })[0] : null; }
  function showTestResult(title, data) {
    var list = Array.isArray(data) ? data : [data];
    openInspectorDrawer('TEST', L(title), list.map(function (r) { return kvList([kv('Result', r.ok ? 'OK' : 'FAILED'), kv('Key', r.kid || '-'), kv('Model', r.model || '-'), kv('Latency', r.latencyMs !== undefined ? r.latencyMs + ' ms' : '-'),
      kv('Tokens', r.tokens ? (r.tokens.input + ' in / ' + r.tokens.output + ' out') : r.spendsTokens ? '-' : L('none (metadata only)')), kv('Error', r.error || (r.completion && r.completion.error) || '-')]) + calibrationHtml(r.calibration || (r.completion && r.completion.calibration), r.provider); }).join('<hr style="border:none;border-top:1px solid var(--border-subtle);" />'));
  }
  // The provider reported more prompt tokens than Core's bound: offer the suggested per-connection allowance (Owner confirms).
  function calibrationHtml(c, provider) {
    if (!c) return '';
    return '<div style="margin-top:8px;padding:8px;border:1px solid var(--border-subtle);border-radius:6px;font-size:12px;">' + escapeHtml(L('The provider added hidden prompt tokens beyond the current allowance.')) + ' ' +
      escapeHtml(L('Prompt tokens')) + ': ' + num(c.promptTokens) + ' · ' + escapeHtml(L('bound')) + ': ' + num(c.bound) + ' · ' + escapeHtml(L('allowance')) + ': ' + num(c.currentInjectedTokens) + ' → ' + num(c.suggestedInjectedTokens) +
      (provider ? '<div style="display:flex;justify-content:flex-end;margin-top:6px;">' + btn('Apply suggested allowance…', 'data-apply-allowance="' + escapeHtml(provider) + '" data-value="' + c.suggestedInjectedTokens + '"', 'btn-primary') + '</div>' : '') + '</div>';
  }
  function providerTest(body, title) { core.post('/api/r9/provider-admin/test', body).then(function (r) { if (!r.ok) return showToast(describeFailure(r)); showTestResult(title, tagProvider(r.data, body.provider)); refresh().then(renderAll); }); }
  function tagProvider(data, provider) { return Array.isArray(data) ? data.map(function (x) { return Object.assign({ provider: provider }, x); }) : Object.assign({ provider: provider }, data); }
  function version() { var pv = LIVE.d('provider'); return pv ? pv.configurationVersion || (pv.providers[0] && pv.providers[0].configurationVersion) : undefined; }
  // Onboarding provider steps (see data-onboard): step 1 = Add provider (with "allow all models"), step 2 = Grant.
  (root.DamarControl = root.DamarControl || {}).onboarding = { connect: function () { ACTIONS['data-add-provider'](); }, grant: function () { ACTIONS['data-grant'](); } };

  var ACTIONS = {
    'data-select-provider': function (id) { ownerAction('Activate provider', '<p style="font-size:12.5px;">' + L('Make %s the active provider in Core?').replace('%s', '<strong>' + escapeHtml(id) + '</strong>') + '</p>', function () { return core.post('/api/r9/provider', { provider: id }); }); },
    'data-select-model': function (id, el) {
      var model = el.getAttribute('data-model');
      ownerAction('Activate model', '<p style="font-size:12.5px;">' + L('Activate %s on %s?').replace('%s', '<strong>' + escapeHtml(model) + '</strong>').replace('%s', '<strong>' + escapeHtml(id) + '</strong>') + '</p>', function () { return core.post('/api/r9/provider', { provider: id, model: model, expectedVersion: version() }); });
    },
    'data-revoke-provider': function (id) { ownerAction('Revoke provider', '<p style="font-size:12.5px;">' + L('Remove the stored configuration and key for %s in Core?').replace('%s', '<strong>' + escapeHtml(id) + '</strong>') + '</p>', function () { return core.post('/api/r9/provider/revoke', { provider: id }); }); },
    'data-connect-provider': function (id) {
      var p = providerById(id) || {};
      ownerAction('Connect provider', field('cxLabel', 'Name', '<input type="text" class="input-field" id="cxLabel" style="width:100%;" maxlength="64" value="' + escapeHtml(p.label || '') + '" />') +
        field('cxBase', 'Endpoint (blank = keep)', '<input type="text" class="input-field" id="cxBase" style="width:100%;font-family:var(--font-mono);" value="' + escapeHtml(p.baseUrl || '') + '" />') +
        field('cxKey', 'API key (sent to Core once; never shown again)', '<input type="password" class="input-field" id="cxKey" style="width:100%;" autocomplete="off" />') +
        field('cxInjected', 'Injected-token allowance (hidden prompt tokens a router adds; default 4096)', '<input type="number" class="input-field" id="cxInjected" min="0" max="65536" value="' + (p.injectedTokens != null ? p.injectedTokens : 4096) + '" style="width:100%;" />') +
        field('cxModel', 'Model (optional)', '<input type="text" class="input-field" id="cxModel" style="width:100%;font-family:var(--font-mono);" value="' + escapeHtml(p.model || '') + '" />') +
        '<label style="font-size:12px;display:flex;gap:8px;align-items:center;"><input type="checkbox" id="cxRemember" /> Remember key on this PC (Windows DPAPI)</label>',
      function () {
        var body = { provider: id }, b = val('cxBase'), k = document.getElementById('cxKey').value, m = val('cxModel');
        if (val('cxLabel') && val('cxLabel') !== p.label) body.label = val('cxLabel');
        if (val('cxInjected') !== '' && Number(val('cxInjected')) !== p.injectedTokens) body.injectedTokens = Number(val('cxInjected'));
        if (b && b !== p.baseUrl) body.baseUrl = b; if (k) body.apiKey = k; if (m) { body.model = m; body.expectedVersion = version(); }
        if (document.getElementById('cxRemember').checked) body.remember = true;
        document.getElementById('cxKey').value = '';
        return core.post('/api/r9/connect', body);
      }, 'Connecting configures the provider; live dispatch still needs a model grant.');
    },
    'data-grant': function () {
      var pv = LIVE.d('provider'), live = pv ? pv.providers.filter(function (p) { return p.kind === 'live'; }) : [];
      ownerAction('Grant live model', field('grProvider', 'Provider', '<select class="select-field" id="grProvider" style="width:100%;">' + live.map(function (p) { return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label) + '</option>'; }).join('') + '</select>') +
        field('grApproval', 'Owner approval reference', '<input type="text" class="input-field" id="grApproval" style="width:100%;" />') +
        field('grModel', 'Model (* = every model)', '<input type="text" class="input-field" id="grModel" value="*" style="width:100%;font-family:var(--font-mono);" />') +
        field('grDays', 'Expires in (days, 1-365)', '<input type="number" class="input-field" id="grDays" value="30" min="1" max="365" style="width:100%;" />') +
        field('grLimits', 'Optional limits: completions, max tokens per call, total tokens (blank = none)', '<input type="text" class="input-field" id="grLimits" value="" placeholder="e.g. 100, 4096, 1000000" style="width:100%;font-family:var(--font-mono);" />'),
      function () {
        var body = grantRequest(val('grProvider'), (providerById(val('grProvider')) || {}).baseUrl, val('grApproval'), val('grModel'), val('grDays'), val('grLimits'), Date.now());
        body.expectedVersion = version();
        return core.post('/api/r9/provider/model-grant', body);
      }, 'A grant authorizes paid live inference for this provider. Core validates every field.');
    },
    'data-revoke-grant': function () {
      var gr = LIVE.d('grant'), grants = gr && gr.grants || [];
      ownerAction('Revoke model grant', field('rgProvider', 'Provider', '<select class="select-field" id="rgProvider" style="width:100%;">' + grants.map(function (g) { return '<option value="' + escapeHtml(g.provider) + '">' + escapeHtml(g.provider + ' / ' + g.model) + '</option>'; }).join('') + '</select>') +
        field('rgApproval', 'Owner approval reference', '<input type="text" class="input-field" id="rgApproval" style="width:100%;" />'),
        function () { return core.post('/api/r9/provider/model-grant/revoke', { expectedVersion: version(), approval: val('rgApproval'), provider: val('rgProvider') }); });
    },
    // Add a connection: a preset only prefills name/endpoint. One step: connect, then (default on) allow every model for 30 days.
    'data-add-provider': function () {
      var pv = LIVE.d('provider'), presets = pv && pv.presets || [];
      ownerAction('Add provider', field('apPreset', 'Start from', '<select class="select-field" id="apPreset" style="width:100%;">' + presets.map(function (x) { return '<option value="' + escapeHtml(x.id) + '">' + escapeHtml(x.label) + '</option>'; }).join('') + '</select>') +
        field('apId', 'Connection id (lowercase letters, digits, -)', '<input type="text" class="input-field" id="apId" style="width:100%;font-family:var(--font-mono);" maxlength="32" />') +
        field('apLabel', 'Name', '<input type="text" class="input-field" id="apLabel" style="width:100%;" maxlength="64" />') +
        field('apBase', 'Endpoint (https://…, or http://127.0.0.1:<port>/v1 on this computer)', '<input type="text" class="input-field" id="apBase" style="width:100%;font-family:var(--font-mono);" />') +
        field('apKey', 'API key (sent to Core once; never shown again)', '<input type="password" class="input-field" id="apKey" style="width:100%;" autocomplete="off" />') +
        '<label style="font-size:12px;display:flex;gap:8px;align-items:center;"><input type="checkbox" id="apRemember" /> ' + escapeHtml(L('Remember key on this PC (Windows DPAPI)')) + '</label>' +
        '<label style="font-size:12px;display:flex;gap:8px;align-items:center;"><input type="checkbox" id="apAllowAll" checked /> ' + escapeHtml(L('Allow all models for this connection (30 days)')) + '</label>',
      function () {
        var id = val('apId'), k = document.getElementById('apKey').value, body = { provider: id, label: val('apLabel') || id, baseUrl: val('apBase') };
        if (k) body.apiKey = k; if (document.getElementById('apRemember').checked) body.remember = true;
        var allowAll = document.getElementById('apAllowAll').checked;
        document.getElementById('apKey').value = '';
        return core.post('/api/r9/connect', body).then(function (r) {
          if (!r || r.ok === false || !allowAll) return r;
          return core.post('/api/r9/provider/model-grant', Object.assign(grantRequest(id, r.data.baseUrl, 'control-owner-' + Date.now(), '*', 30, '', Date.now()), { expectedVersion: r.data.configurationVersion }));
        });
      }, 'Core checks the endpoint (/models) before saving. Allowing all models authorizes live inference on this connection.');
      var preset = document.getElementById('apPreset'), fill = function () {
        var x = presets.filter(function (y) { return y.id === preset.value; })[0] || {};
        if (x.id !== 'custom') { document.getElementById('apId').value = x.id || ''; document.getElementById('apLabel').value = x.label || ''; }
        document.getElementById('apBase').value = x.baseUrl || '';
      };
      if (preset) { preset.onchange = fill; fill(); }
    },
    'data-oauth-login': function () {
      return core.post('/api/r9/oauth/openrouter/start', {}).then(function (r) {
        if (r && r.ok !== false && r.data && r.data.authorizeUrl) { window.open(r.data.authorizeUrl, '_blank'); showToast(L('Selesaikan login di browser, lalu kembali ke Dashboard.')); }
        else showToast(L('Gagal memulai login OAuth.'));
      });
    },
    'data-oauth-disconnect': function () {
      ownerAction('Putuskan koneksi OpenRouter', '<p style="font-size:12.5px;">' + escapeHtml(L('Kunci hasil login OAuth dihapus dari vault Core dan dicabut dari koneksi provider.')) + '</p>',
        function () { return core.post('/api/r9/oauth/openrouter/disconnect', {}); });
    },
    // ---- Provider picker actions (bind to the same routes as the detail panels) ----
    'data-pp-toggle': function (id) { state.picker.open[id] = !state.picker.open[id]; renderAll(); },
    'data-pp-advanced': function () { state.picker.advanced = !state.picker.advanced; renderAll(); },
    'data-pp-apikey': function (id) {
      state.picker.open[id] = true; renderAll();
      setTimeout(function () { var el = document.getElementById('ppRow_' + id); if (el) el.scrollIntoView({ block: 'center' }); var k = document.getElementById('ppKey_' + id); if (k) k.focus(); }, 30);
    },
    'data-pp-connect': function (id) {
      var pv = LIVE.d('provider'), preset = (pv && pv.presets || []).filter(function (x) { return x.id === id; })[0] || {};
      var keyEl = document.getElementById('ppKey_' + id), remEl = document.getElementById('ppRemember_' + id);
      var body = { provider: id, label: preset.label || id, baseUrl: preset.baseUrl || '' };
      if (keyEl && keyEl.value) body.apiKey = keyEl.value;
      if (!remEl || remEl.checked) body.remember = true;
      if (keyEl) keyEl.value = '';
      core.post('/api/r9/connect', body).then(function (r) {
        if (!r.ok) { showToast(describeFailure(r)); return; }
        return core.post('/api/r9/provider/model-grant', Object.assign(grantRequest(id, r.data.baseUrl, 'control-owner-' + Date.now(), '*', 30, '', Date.now()), { expectedVersion: r.data.configurationVersion }))
          .then(function (g) {
            state.picker.open[id] = false;
            showToast(g.ok ? L('Terhubung: ') + id + ' — ' + L('model ditemukan otomatis, semua model diizinkan 30 hari.') : describeFailure(g));
            refresh().then(renderAll);
          });
      });
    },
    'data-pp-test': function (id) { ppTestIds([id], null); },
    'data-pp-oauth-check': function () {
      core.post('/api/r9/oauth/openrouter/check', {}).then(function (r) {
        state.picker.groupMsg.oauth = r.ok ? 'OpenRouter: status login diperiksa ulang dari Core.' : ppHumanError(r.error);
        refresh().then(renderAll);
      });
    },
    'data-pp-test-all': function (group) {
      var pv = LIVE.d('provider'); if (!pv) return;
      if (group === 'oauth') { ACTIONS['data-pp-oauth-check'](); return; }
      var live = pv.providers.filter(function (p) { return p.kind === 'live' && !p.virtual; });
      var ids;
      if (group === 'connected') ids = live.map(function (p) { return p.id; });
      else {
        var want = {}; (pv.presets || []).forEach(function (x) { if ((group === 'local') === (x.keyRequired === false)) want[x.id] = true; });
        ids = live.filter(function (p) { return want[p.id]; }).map(function (p) { return p.id; });
      }
      ppTestIds(ids, group);
    },
    'data-pp-activate': function (id) {
      var sel = document.getElementById('ppModel_' + id), model = sel ? sel.value : '';
      var p = providerById(id) || {};
      ownerAction('Aktifkan model', '<p style="font-size:12.5px;">' + escapeHtml(L('Jadikan')) + ' <strong>' + escapeHtml(model || id) + '</strong> ' + escapeHtml(L('di')) + ' <strong>' + escapeHtml(id) + '</strong> ' + escapeHtml(L('sebagai model aktif Damar?')) + '</p>', function () {
        var doSelect = function () { return core.post('/api/r9/provider', { provider: id, model: model || undefined, expectedVersion: version() }); };
        if (p.grantStatus === 'granted') return doSelect();
        return core.post('/api/r9/provider/model-grant', Object.assign(grantRequest(id, p.baseUrl, 'control-owner-' + Date.now(), '*', 30, '', Date.now()), { expectedVersion: version() }))
          .then(function (g) { if (!g.ok) return g; return refresh().then(function () { return doSelect(); }); });
      }, 'Model aktif dipakai semua permukaan Damar. Izin model memberi wewenang inferensi langsung berbayar di koneksi ini.');
    },
    'data-keys-import': function (id) {
      ownerAction('Import keys', field('kiText', 'API keys, one per line (duplicates are skipped; keys are never shown again)', '<textarea class="input-field" id="kiText" rows="6" style="width:100%;font-family:var(--font-mono);" autocomplete="off"></textarea>'),
        function () { var t = document.getElementById('kiText').value; document.getElementById('kiText').value = ''; return core.post('/api/r9/provider-admin/keys', { provider: id, action: 'add', text: t }); },
        'Core stores each key with Windows DPAPI for this user and shows only its last 4 characters.');
    },
    'data-key-toggle': function (id, el) { var on = el.getAttribute('data-enabled') === 'true'; ownerAction(on ? 'Enable key' : 'Disable key', '<p style="font-size:12.5px;">' + escapeHtml(L(on ? 'Enable this key for rotation?' : 'Take this key out of rotation?')) + '</p>',
      function () { return core.post('/api/r9/provider-admin/keys', { provider: id, action: 'set', kid: el.getAttribute('data-kid'), enabled: on }); }); },
    'data-key-delete': function (id, el) { ownerAction('Delete key', '<p style="font-size:12.5px;">' + escapeHtml(L('Delete this key from Core and from secure storage?')) + '</p>',
      function () { return core.post('/api/r9/provider-admin/keys', { provider: id, action: 'delete', kid: el.getAttribute('data-kid') }); }); },
    'data-key-test': function (id, el) { providerTest({ provider: id, kind: 'key', kid: el.getAttribute('data-kid') }, 'Key test (/models, no tokens)'); },
    'data-keys-test-all': function (id) { providerTest({ provider: id, kind: 'keys' }, 'All keys (/models, no tokens)'); },
    'data-model-test': function (id) {
      ownerAction('Test model', field('mtModel', 'Model', '<input type="text" class="input-field" id="mtModel" style="width:100%;font-family:var(--font-mono);" />'),
        function () { return core.post('/api/r9/provider-admin/test', { provider: id, kind: 'model', model: val('mtModel') }).then(function (r) { if (r.ok) setTimeout(function () { showTestResult('Model test', tagProvider(r.data, id)); }, 0); return r; }); },
        'Spends tokens: one tiny completion (max 8 output tokens), metered and covered by the model grant.');
    },
    'data-key-strategy': function (id) {
      var a = LIVE.d('padmin'), c = padminConn(id) || {};
      ownerAction('Key rotation', field('ksStrategy', 'Strategy', '<select class="select-field" id="ksStrategy" style="width:100%;">' + ((a && a.strategies) || []).map(function (x) { return '<option value="' + x + '"' + (x === c.strategy ? ' selected' : '') + '>' + escapeHtml(L(x)) + '</option>'; }).join('') + '</select>'),
        function () { return core.post('/api/r9/provider-admin/strategy', { provider: id, strategy: val('ksStrategy') }); },
        'round-robin: spread requests; fill-first: use keys in order (priority); lru: least recently used first. Failing keys cool down automatically.');
    },
    'data-catalog': function (id) {
      var c = padminConn(id) || {};
      var extras = c.extraModels || [], aliases = Object.keys(c.aliases || {});
      var selOpts = function (list) { return '<option value=""></option>' + list.map(function (m) { return '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>'; }).join(''); };
      ownerAction('Model catalog', field('caAdd', 'Add a model id (optional)', '<input type="text" class="input-field" id="caAdd" style="width:100%;font-family:var(--font-mono);" />') +
        field('caAlias', 'Alias name (optional)', '<input type="text" class="input-field" id="caAlias" style="width:100%;font-family:var(--font-mono);" />') +
        field('caTarget', 'Alias points to model', '<input type="text" class="input-field" id="caTarget" style="width:100%;font-family:var(--font-mono);" />') +
        (extras.length ? field('caRemoveModel', 'Remove an added model (optional)', '<select class="select-field" id="caRemoveModel" style="width:100%;">' + selOpts(extras) + '</select>') : '') +
        (aliases.length ? field('caRemoveAlias', 'Remove an alias (optional)', '<select class="select-field" id="caRemoveAlias" style="width:100%;">' + selOpts(aliases) + '</select>') : ''),
        function () { var body = { provider: id }; if (val('caAdd')) body.addModel = val('caAdd'); if (val('caAlias')) body.alias = { name: val('caAlias'), model: val('caTarget') };
          var rm = document.getElementById('caRemoveModel'), ra = document.getElementById('caRemoveAlias');
          if (rm && rm.value) body.removeModel = rm.value; if (ra && ra.value) body.removeAlias = ra.value;
          return core.post('/api/r9/provider-admin/catalog', body); });
    },
    'data-conn-limits': function (id) {
      var c = padminConn(id) || {};
      ownerAction('Connection limits', field('clConc', 'Max parallel requests (more wait in a queue)', '<input type="number" class="input-field" id="clConc" min="1" max="256" value="' + (c.maxConcurrency || 8) + '" style="width:100%;" />') +
        field('clInj', 'Injected-token allowance', '<input type="number" class="input-field" id="clInj" min="0" max="65536" value="' + (c.injectedTokens != null ? c.injectedTokens : 4096) + '" style="width:100%;" />'),
        function () { return core.post('/api/r9/provider-admin/limits', { provider: id, maxConcurrency: Number(val('clConc')) }).then(function (r) { return r.ok && Number(val('clInj')) !== c.injectedTokens ? core.post('/api/r9/connect', { provider: id, injectedTokens: Number(val('clInj')) }) : r; }); });
    },
    'data-apply-allowance': function (id, el) {
      var v = Number(el.getAttribute('data-value'));
      ownerAction('Apply suggested allowance', '<p style="font-size:12.5px;">' + escapeHtml(L('Set the injected-token allowance of')) + ' <strong>' + escapeHtml(id) + '</strong> → ' + num(v) + '?</p>', function () { return core.post('/api/r9/connect', { provider: id, injectedTokens: v }); });
    },
    'data-combo-new': function () {
      ownerAction('New combo', field('coId', 'Combo name (used as the model id)', '<input type="text" class="input-field" id="coId" style="width:100%;font-family:var(--font-mono);" />') +
        field('coStrategy', 'Strategy', '<select class="select-field" id="coStrategy" style="width:100%;"><option value="fallback">' + escapeHtml(L('fallback')) + '</option><option value="round-robin">' + escapeHtml(L('round-robin')) + '</option></select>') +
        field('coTargets', 'Targets in order, one per line: connection model', '<textarea class="input-field" id="coTargets" rows="4" style="width:100%;font-family:var(--font-mono);" placeholder="my-router cx/model-a&#10;openai gpt-4.1-mini"></textarea>'),
        function () { var targets = val('coTargets').split(/\n+/).map(function (l) { var m = l.trim().split(/\s+/); return { connection: m[0], model: m[1] }; }).filter(function (t) { return t.connection && t.model; });
          return core.post('/api/r9/provider-admin/combos', { action: 'set', combo: { id: val('coId'), strategy: val('coStrategy'), targets: targets } }); },
        'A combo tries its targets in order and falls back on errors. Each target still needs its connection’s model grant.');
    },
    'data-combo-delete': function (cid) { ownerAction('Delete combo', '<p style="font-size:12.5px;">' + escapeHtml(L('Delete combo')) + ' <strong>' + escapeHtml(cid) + '</strong>?</p>', function () { return core.post('/api/r9/provider-admin/combos', { action: 'delete', id: cid }); }); },
    'data-routing': function () {
      var a = LIVE.d('padmin'), r = a ? a.routing : { cooldownMs: 30000, maxCooldownMs: 600000 };
      ownerAction('Routing', field('roCool', 'First cooldown after a failure (seconds)', '<input type="number" class="input-field" id="roCool" min="1" max="3600" value="' + Math.round(r.cooldownMs / 1000) + '" style="width:100%;" />') +
        field('roMax', 'Maximum cooldown (seconds)', '<input type="number" class="input-field" id="roMax" min="1" max="86400" value="' + Math.round(r.maxCooldownMs / 1000) + '" style="width:100%;" />') +
        field('roConc', 'Max parallel requests per connection (default)', '<input type="number" class="input-field" id="roConc" min="1" max="256" value="' + (r.maxConcurrency || 8) + '" style="width:100%;" />') +
        field('roKey', 'Max parallel requests per provider key', '<input type="number" class="input-field" id="roKey" min="1" max="256" value="' + (r.maxPerKey || 8) + '" style="width:100%;" />'),
        function () { return core.post('/api/r9/provider-admin/routing', { cooldownMs: Number(val('roCool')) * 1000, maxCooldownMs: Number(val('roMax')) * 1000, maxConcurrency: Number(val('roConc')), maxPerKey: Number(val('roKey')) }); });
    },
    'data-gw-settings': function () {
      var g = (LIVE.d('padmin') || {}).gateway || { settings: { enabled: false, bind: '127.0.0.1', port: 29631 } };
      ownerAction('Gateway settings', '<label style="font-size:12px;display:flex;gap:8px;align-items:center;"><input type="checkbox" id="gwOn"' + (g.settings.enabled ? ' checked' : '') + ' /> ' + escapeHtml(L('Gateway on')) + '</label>' +
        field('gwBind', 'Listen on', '<select class="select-field" id="gwBind" style="width:100%;"><option value="127.0.0.1"' + (g.settings.bind === '127.0.0.1' ? ' selected' : '') + '>' + escapeHtml(L('this computer only')) + '</option><option value="0.0.0.0"' + (g.settings.bind === '0.0.0.0' ? ' selected' : '') + '>' + escapeHtml(L('LAN (all interfaces)')) + '</option></select>') +
        field('gwPort', 'Port', '<input type="number" class="input-field" id="gwPort" min="1024" max="65535" value="' + g.settings.port + '" style="width:100%;" />'),
        function () { return core.post('/api/r9/gateway', { action: 'settings', enabled: document.getElementById('gwOn').checked, bind: val('gwBind'), port: Number(val('gwPort')) }); },
        'Warning: LAN mode lets other devices on your network use this gateway with a DAMAR gateway key. Keep it on “this computer only” unless you need it.');
    },
    'data-gw-key-new': function () {
      ownerAction('Create gateway key', field('gkLabel', 'Label (e.g. opencode, hermes)', '<input type="text" class="input-field" id="gkLabel" style="width:100%;" maxlength="64" />') +
        field('gkModels', 'Allowed models and combos (comma separated, * = all)', '<input type="text" class="input-field" id="gkModels" value="*" style="width:100%;font-family:var(--font-mono);" />') +
        field('gkLimits', 'Optional limits: requests, total tokens, parallel requests (blank = none; parallel default 8)', '<input type="text" class="input-field" id="gkLimits" placeholder="e.g. 1000, 2000000, 8" style="width:100%;font-family:var(--font-mono);" />'),
        function () {
          var lim = val('gkLimits').split(',').map(function (x) { return x.trim(); }), limits = {};
          if (lim[0]) limits.requests = Number(lim[0]); if (lim[1]) limits.totalTokens = Number(lim[1]); if (lim[2]) limits.concurrency = Number(lim[2]);
          return core.post('/api/r9/gateway', { action: 'create-key', label: val('gkLabel'), models: val('gkModels').split(',').map(function (x) { return x.trim(); }).filter(Boolean), limits: limits })
            .then(function (r) { if (r.ok) setTimeout(function () { openInspectorDrawer('GATEWAY KEY', L('Copy this key now'), '<p style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(L('This is the only time DAMAR shows this key. Core keeps only a hash.')) + '</p><pre style="font-family:var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;">' + escapeHtml(r.data.key) + '</pre>'); }, 0); return r; });
        }, 'The key is shown once. Clients use it as their OpenAI API key with the gateway base URL.');
    },
    'data-gw-key-revoke': function (kid) { ownerAction('Revoke gateway key', '<p style="font-size:12.5px;">' + escapeHtml(L('Clients using this key stop working immediately.')) + '</p>', function () { return core.post('/api/r9/gateway', { action: 'revoke-key', id: kid }); }); },
    'data-remove-provider': function (id) { ownerAction('Remove provider', '<p style="font-size:12.5px;">' + L('Remove the connection %s and its remembered key from Core?').replace('%s', '<strong>' + escapeHtml(id) + '</strong>') + '</p>', function () { return core.post('/api/r9/provider/remove', { provider: id, expectedVersion: version() }); }); },
    'data-cancel-run': function (id) { ownerAction('Cancel Pandawa run', '<p style="font-size:12.5px;">' + L('Request cancellation of %s? A running provider call finishes; its result is discarded.').replace('%s', mono(id)) + '</p>', function () { return core.post('/api/r9/pandawa/runs/' + id + '/cancel', {}); }); },
    'data-inspect-session': function (id) {
      core.get('/api/r9/sessions/' + id).then(function (r) {
        if (!r.ok) return showToast(describeFailure(r));
        var d = r.data;
        openInspectorDrawer('SESSION', d.title, kvList([kv('Session', d.sessionId, true), kv('Workspace', d.cwd), kv('Model', (d.provider || '-') + ' / ' + (d.model || '-')), kv('Tokens', num(d.usage.totalTokens) + (d.usage.complete ? '' : ' (incomplete)')), kv('Cost', typeof d.usage.cost === 'number' ? num(d.usage.cost) : L('Unavailable'))]) +
          '<h3 style="font-size:12px;margin:14px 0 6px;color:var(--damar-accent);">' + escapeHtml(L('Operations')) + '</h3>' + table(['Command', 'State', 'Reason'], d.operations.map(function (o) { return [escapeHtml(o.command || '-'), statusBadgeHtml(o.state), escapeHtml(o.reason || '')]; }), 'None.') +
          '<h3 style="font-size:12px;margin:14px 0 6px;color:var(--damar-accent);">' + escapeHtml(L('Conversation')) + ' (' + d.conversation.length + ')</h3>' + (d.conversation.length ? d.conversation.map(function (m) { return '<div style="font-size:12px;margin-bottom:8px;"><span class="badge badge-neutral">' + escapeHtml(m.role === 'user' ? L('User') : m.role === 'assistant' ? 'Damar' : m.role) + '</span> ' + (m.t ? '<span style="color:var(--text-muted);font-size:11px;">' + escapeHtml(new Date(m.t).toLocaleString('id-ID')) + '</span> ' : '') + '<span style="color:var(--text-secondary);white-space:pre-wrap;">' + escapeHtml(String(m.text).slice(0, 4000)) + '</span></div>'; }).join('') : '<div style="font-size:12px;color:var(--text-muted);">' + escapeHtml(L('No conversation recorded for this session.')) + '</div>'));
      });
    },
    'data-load-usage': function (id) { core.get('/api/r9/usage?cliSession=' + id).then(function (r) { state.usage[id] = r; renderAll(); }); },
    'data-lifecycle-restart': function () {
      ownerAction('Restart Core', '<p style="font-size:12.5px;">' + escapeHtml(L('Core restarts under its supervisor. The restart rotates this tab\'s session credential, so this tab stops working once Core is back: reopen DAMAR Control from Presence or the damar control command. Core refuses the restart while turns, permissions, runs or jobs are outstanding.')) + '</p>', function () {
        return core.post('/api/r9/lifecycle/restart', {});
      });
    },
    'data-load-settings': function () { loadSettings(); },
    'data-save-gate-mode': function () {
      var mode = val('gateMode');
      ownerAction('Simpan mode Authority Gate', '<p style="font-size:12.5px;">Atur mode Authority Gate menjadi <strong>' + escapeHtml(gateModeLabel(mode)) + '</strong>?</p><p style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(GATE_MODE_INFO[mode] || '') + '</p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { autonomy: mode } }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      });
    },
    'data-save-settings': function () {
      var values = { autonomy: val('settingsAutonomy'), skills: { routing: val('settingsRouting'), disabled: state.settings.data.skills.disabled } };
      ownerAction('Save Core settings', '<p style="font-size:12.5px;">' + L('Set autonomy %s, skill routing %s?').replace('%s', '<strong>' + escapeHtml(values.autonomy) + '</strong>').replace('%s', '<strong>' + escapeHtml(values.skills.routing) + '</strong>') + '</p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: values }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      });
    },
    'data-save-token': function () {
      var numOrNull = function (id) { var v = val(id); return v === '' ? null : Number(v); };
      var tokenBudget = { totalTokens: numOrNull('tbTotal'), maxOutputTokens: numOrNull('tbOutput'), completions: numOrNull('tbCompletions') };
      ownerAction('Simpan anggaran token', '<pre style="font-size:11px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(tokenBudget, null, 1)) + '</pre><p style="font-size:12px;">Nilai kosong berarti tanpa batas.</p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { tokenBudget: tokenBudget } }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      });
    },
    'data-save-cli': function () {
      var cli = { theme: val('cliTheme'), animateBanner: val('cliBanner') === 'flame', language: val('cliLanguage'), hudPosition: val('cliHud') };
      ownerAction('Save CLI settings', '<pre style="font-size:11px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(cli, null, 1)) + '</pre>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { cli: cli } }); });
      }, 'Shared with the CLI Settings screen; a running CLI picks it up when its Settings opens or at start.');
    },
    'data-open-discussion': function (id) { openDiscussion(id); },
    'data-interject': function () {
      var text = val('discInterject'), x = state.discussion; if (!text || !x) return;
      core.post('/api/r9/pandawa/discussions/' + x.id + '/interject', { cliSession: state.control.id, client: state.control.client, text: text }).then(function (r) {
        if (!r.ok) return showToast(describeFailure(r)); var el = document.getElementById('discInterject'); if (el) el.value = ''; state.formDirty = false; });
    },
    'data-stop-discussion': function () { var x = state.discussion; if (!x) return;
      ownerAction('Stop discussion', '<p style="font-size:12.5px;">' + escapeHtml(L('Members finish their current reply; nothing further is sent.')) + '</p>', function () { return core.post('/api/r9/pandawa/discussions/' + x.id + '/cancel', { cliSession: state.control.id, client: state.control.client }); }); },
    'data-extend-discussion': function () { var x = state.discussion; if (!x) return;
      ownerAction('Extend discussion', '<p style="font-size:12.5px;">' + escapeHtml(L('The debate chain resumes from the full transcript, including DAMAR\'s decision. Members answer it turn by turn until they converge or DAMAR rules a deadlock.')) + '</p>', function () {
        return core.post('/api/r9/pandawa/discussions/' + x.id + '/extend', { cliSession: state.control.id, client: state.control.client }).then(function (r) { if (r.ok) openDiscussion(x.id); return r; });
      }); },
    'data-save-pandawa-models': function () {
      var models = {}; ['werkudara', 'sadewa', 'puntadewa', 'nakula', 'janaka'].forEach(function (m) { models[m] = val('pp_' + m) || null; });
      ownerAction('Save Pandawa models…', '<pre style="font-size:11px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(models, null, 1)) + '</pre><p style="font-size:12px;">Null berarti anggota itu mewarisi model utama DAMAR.</p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { pandawa: { models: models } } }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      });
    },
    'data-new-discussion': function () {
      ownerAction('New discussion', field('ndMode', 'Mode', '<select class="select-field" id="ndMode" style="width:100%;"><option value="debate">debate</option><option value="delegate">delegate</option></select>') +
        field('ndTopic', 'Topic (debate) or one "member: task" per line (delegate)', '<textarea class="input-field" id="ndTopic" maxlength="4000" style="width:100%;min-height:90px;"></textarea>') +
        '<div style="margin-top:10px;"><div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:5px;">' + escapeHtml(L('Members (debate)')) + '</div><div style="display:flex;gap:10px;flex-wrap:wrap;">' +
        ['puntadewa', 'werkudara', 'janaka', 'nakula', 'sadewa'].map(function (m) { return '<label style="font-size:12px;display:flex;gap:5px;align-items:center;"><input type="checkbox" id="ndm_' + m + '" checked /> ' + m + '</label>'; }).join('') + '</div></div>',
      function () {
        var mode = val('ndMode'), text = val('ndTopic'), body = { mode: mode, topic: text };
        if (mode === 'debate') { body.members = ['puntadewa', 'werkudara', 'janaka', 'nakula', 'sadewa'].filter(function (m) { var el = document.getElementById('ndm_' + m); return el && el.checked; });
          if (body.members.length < 2) { showToast('Pilih minimal dua anggota untuk debat.'); return Promise.reject({ error: 'MEMBERS_MIN_2' }); } }
        if (mode === 'delegate') body.tasks = text.split(/\n|;/).map(function (l) { var i = l.indexOf(':'); return { worker: l.slice(0, i).trim().toLowerCase(), task: l.slice(i + 1).trim() }; }).filter(function (t) { return t.worker && t.task; });
        return controlSession().then(function (id) { body.cliSession = id; body.client = state.control.client; return core.post('/api/r9/pandawa/discussions', body); })
          .then(function (r) { if (r.ok) { navigateTo('discussions'); openDiscussion(r.data.discussionId); } return r; });
      }, 'Runs on the models set in Settings > Pandawa Team and may use paid inference.');
    },
    'data-save-cognitive': function () {
      var cognitive = { memoryEnabled: val('cgMemory') === 'on', memoryConsent: val('cgConsent'), memoryRetentionDays: Number(val('cgRetention')), memoryContextChars: Number(val('cgContext')),
        historyTurns: Number(val('cgTurns')), historyChars: Number(val('cgChars')), mind: val('cgMind') };
      ownerAction('Save memory settings', '<pre style="font-size:11px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(cognitive, null, 1)) + '</pre>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { cognitive: cognitive } }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      });
    },
    'data-save-team': function () {
      var models = {}; ['damar', 'puntadewa', 'werkudara', 'janaka', 'nakula', 'sadewa'].forEach(function (m) { models[m] = val('pm_' + m) || null; });
      var pandawa = { models: models, discussion: { maxRounds: Number(val('pdRounds')), tokenBudget: val('pdBudget') === '' ? null : Number(val('pdBudget')), callTimeoutSec: Number(val('pdTimeout')) } };
      ownerAction('Save Pandawa team', '<pre style="font-size:11px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(pandawa, null, 1)) + '</pre>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { pandawa: pandawa } }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      });
    },
    'data-save-voice': function () {
      var voice = { pitchSemitones: Number(val('vcPitch')), style: val('vcStyle'), jarvisPitchSemitones: Number(val('vcJarvisPitch')), jarvisRingModHz: Number(val('vcRingHz')),
        jarvisRingModDepth: Number(val('vcRingDepth')), jarvisReverbWet: Number(val('vcReverbWet')), jarvisReverbDecayMs: Number(val('vcReverbDecay')),
        jarvisEqLowDb: Number(val('vcEqLow')), jarvisEqPresenceDb: Number(val('vcEqPresence')), jarvisEqHighDb: Number(val('vcEqHigh')) };
      ownerAction('Save voice settings', '<pre style="font-size:11px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(voice, null, 1)) + '</pre>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { voice: voice } }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      }, 'Core validates every value. Applies to local Supertonic TTS output as post-processing (pitch + Jarvis preset).');
    },
    'data-memory-export': function () {
      ownerAction('Export memory', '<p style="font-size:12.5px;">' + escapeHtml(L('Download every workspace\'s project memory notes as a JSON file.')) + '</p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/memory', { action: 'export', cliSession: id, client: state.control.client, root: state.workspace }); }).then(function (r) {
          if (r.ok) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 1)], { type: 'application/json' })); a.download = 'damar-memory-export.json'; document.body.appendChild(a); a.click(); a.remove(); }
          return r; });
      }, 'Needs a workspace folder (Memory & Continuity). The file stays on this PC.');
    },
    'data-memory-clear': function () {
      ownerAction('Clear workspace memory', '<p style="font-size:12.5px;">' + escapeHtml(L('Delete every project memory note of this workspace:')) + ' ' + mono(state.workspace || '-') + '</p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/memory', { action: 'clear', cliSession: id, client: state.control.client, root: state.workspace }); });
      }, 'This cannot be undone.');
    },
    'data-save-presence': function () {
      var presence = { idleToOrbSec: Number(val('prIdleOrb')), orbToNotchSec: Number(val('prOrbNotch')), notchHideSec: Number(val('prNotchHide')), characterSoundEnabled: val('prCharSound') === 'enabled', characterSoundVolume: Number(val('prCharVol')), morphMs: Number(val('prMorph')), reducedMotion: val('prMotion'), notchEnabled: val('prNotch') === 'enabled',
        notificationPrivacy: val('prPrivacy'), display: val('prDisplay'), position: val('prPosition'), voiceEnabled: val('prVoice') === 'on', displayName: val('prName'), salutation: val('prSalutation') };
      ownerAction('Save presence settings', '<pre style="font-size:11px;white-space:pre-wrap;">' + escapeHtml(JSON.stringify(presence, null, 1)) + '</pre>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { presence: presence } }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      }, 'Core validates every value; the presence surface picks it up within 5 s.');
    },
    'data-trust-plugin': function (key, el) {
      var trusted = el.getAttribute('data-trusted') === 'true';
      ownerAction(trusted ? 'Trust plugin' : 'Untrust plugin', '<p style="font-size:12.5px;">' + (trusted ? 'Trust' : 'Untrust') + ' plugin digest ' + mono(key) + '?</p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'trust-plugin', cliSession: id, client: state.control.client, key: key, trusted: trusted }); }).then(function (r) { if (r.ok) loadSettings(); return r; });
      });
    },
    'data-memory-list': function () {
      state.workspace = val('memoryRootInput'); store('damar.control.workspace', state.workspace);
      controlSession().then(function (id) { return core.post('/api/r9/memory', { action: 'list', cliSession: id, client: state.control.client, root: state.workspace }); })
        .then(function (r) { state.memory = r; renderAll(); }, function (r) { state.memory = r && r.error ? r : { ok: false, error: 'CONTROL_SESSION_FAILED' }; renderAll(); });
    },
    'data-memory-add': function () {
      state.workspace = val('memoryRootInput');
      ownerAction('Add project memory', field('memText', 'Note (the agent follows it in this workspace)', '<textarea class="input-field" id="memText" style="width:100%;min-height:80px;"></textarea>'), function () {
        return controlSession().then(function (id) { return core.post('/api/r9/memory', { action: 'add', cliSession: id, client: state.control.client, root: state.workspace, text: val('memText') }); })
          .then(function (r) { if (r.ok) ACTIONS['data-memory-list'](); return r; });
      });
    },
    'data-forget-memory': function (id) {
      ownerAction('Forget project memory', '<p style="font-size:12.5px;">Forget note ' + mono(id) + '?</p>', function () {
        return controlSession().then(function (s) { return core.post('/api/r9/memory', { action: 'forget', cliSession: s, client: state.control.client, root: state.workspace, id: id }); })
          .then(function (r) { if (r.ok) ACTIONS['data-memory-list'](); return r; });
      });
    },
    'data-checkpoints': function (id) {
      (state.control.held[id] ? Promise.resolve(id) : holdSession(id)).then(function () { return core.post('/api/r9/checkpoints', { action: 'list', cliSession: id, client: state.control.client }); })
        .then(function (r) { state.checkpoints[id] = r; renderAll(); }, function (r) { state.checkpoints[id] = r && r.error ? r : { ok: false, error: 'ATTACH_FAILED' }; renderAll(); });
    },
    'data-undo': function (id) { checkpointRun(id, 'undo'); },
    'data-redo': function (id) { checkpointRun(id, 'redo'); },
    'data-cap-tab': function (t) { state.capabilityFilter = t; if (t === 'Skills' && !state.settings) loadSettings(); if (t === 'MCP' || t === 'Plugins') ensureKapabilitas(); renderAll(); },
    'data-kap-mcp-add': function () {
      ownerAction('Tambah server MCP',
        field('kmId', 'ID server (huruf kecil, angka, strip, atau garis bawah)', '<input type="text" class="input-field" id="kmId" style="width:100%;font-family:var(--font-mono);" maxlength="40" />') +
        field('kmCommand', 'Perintah (transport stdio: proses lokal yang dijalankan Core)', '<input type="text" class="input-field" id="kmCommand" style="width:100%;font-family:var(--font-mono);" />') +
        field('kmArgs', 'Argumen (pisahkan dengan spasi)', '<input type="text" class="input-field" id="kmArgs" style="width:100%;font-family:var(--font-mono);" />') +
        field('kmCwd', 'Direktori kerja (opsional)', '<input type="text" class="input-field" id="kmCwd" style="width:100%;font-family:var(--font-mono);" />') +
        field('kmEnv', 'Variabel lingkungan (opsional, satu KUNCI=nilai per baris; nilai disimpan Core dan tidak ditampilkan lagi)', '<textarea class="input-field" id="kmEnv" rows="3" style="width:100%;font-family:var(--font-mono);" autocomplete="off"></textarea>') +
        field('kmTools', 'Tool yang diizinkan (opsional, pisahkan dengan koma; kosong berarti semua tool server)', '<input type="text" class="input-field" id="kmTools" style="width:100%;font-family:var(--font-mono);" />') +
        '<div style="display:flex;justify-content:flex-end;margin-top:4px;">' + btn('Tes koneksi', 'id="kmTestBtn"') + '</div>' +
        '<div id="kmTestResult" style="font-size:12px;margin-top:8px;color:var(--text-secondary);"></div>',
        function () { return core.post('/api/r9/kapabilitas/mcp/save', { entry: kapMcpEntry() }).then(function (r) { if (r.ok) loadKapabilitas(); return r; }); },
        'Tes koneksi menjalankan handshake MCP sungguhan tanpa menyimpan apa pun. Simpan menulis entri ke registry MCP kanonis Core lalu menjalankan servernya.');
      var tb = document.getElementById('kmTestBtn');
      if (tb) tb.onclick = function () {
        var out = document.getElementById('kmTestResult'); if (out) out.textContent = L('Menghubungi server…');
        core.post('/api/r9/kapabilitas/mcp/test', { entry: kapMcpEntry() }).then(function (r) {
          if (!out) return;
          if (!r.ok) { out.textContent = describeFailure(r); return; }
          out.textContent = r.data.ok ? L('Koneksi berhasil. Tool yang dilaporkan server: ') + ((r.data.tools || []).join(', ') || '-') + ' (' + r.data.latencyMs + ' ms)' : L('Koneksi gagal: ') + r.data.error;
        }, function (e) { if (out) out.textContent = 'Control error: ' + String(e && e.message || e); });
      };
    },
    'data-kap-mcp-remove': function (id) {
      ownerAction('Hapus server MCP', '<p style="font-size:12.5px;">' + escapeHtml(L('Hapus server MCP')) + ' <strong>' + escapeHtml(id) + '</strong> ' + escapeHtml(L('dari registry Core? Server dihentikan dan toolnya hilang dari daftar tool.')) + '</p>', function () {
        return core.post('/api/r9/kapabilitas/mcp/remove', { id: id }).then(function (r) { if (r.ok) loadKapabilitas(); return r; });
      });
    },
    'data-kap-plugin-add': function () {
      ownerAction('Pasang plugin',
        field('kpSource', 'Sumber', '<select class="select-field" id="kpSource" style="width:100%;"><option value="folder">Folder lokal</option><option value="zip">Berkas zip</option><option value="git">URL git</option></select>') +
        field('kpPath', 'Jalur folder, jalur berkas zip, atau URL git', '<input type="text" class="input-field" id="kpPath" style="width:100%;font-family:var(--font-mono);" />'),
        function () { return core.post('/api/r9/kapabilitas/plugins/install', { source: val('kpSource'), path: val('kpPath') }).then(function (r) { if (r.ok) loadKapabilitas(); return r; }); },
        'Plugin divalidasi dengan validator loader Damar (manifest.json wajib berisi id, name, version, entry), disalin ke folder plugin pengguna, lalu dimuat langsung. Plugin yang tidak valid ditolak dengan alasannya.');
    },
    'data-kap-plugin-toggle': function (id, el) {
      var on = el.getAttribute('data-enabled') === 'true';
      ownerAction(on ? 'Nonaktifkan plugin' : 'Aktifkan plugin', '<p style="font-size:12.5px;">' + escapeHtml(L(on ? 'Lepas plugin ini dari sesi Core yang berjalan? Foldernya tetap terpasang dan plugin dimuat lagi saat Core dimulai ulang.' : 'Muat plugin ini ke sesi Core yang berjalan?')) + ' <strong>' + escapeHtml(id) + '</strong></p>', function () {
        return core.post('/api/r9/kapabilitas/plugins/enabled', { id: id, enabled: !on }).then(function (r) { if (r.ok) loadKapabilitas(); return r; });
      });
    },
    'data-kap-plugin-remove': function (id) {
      ownerAction('Hapus plugin', '<p style="font-size:12.5px;">' + escapeHtml(L('Hapus plugin')) + ' <strong>' + escapeHtml(id) + '</strong> ' + escapeHtml(L('dari folder plugin pengguna? Plugin dilepas dari sesi dan foldernya dihapus.')) + '</p>', function () {
        return core.post('/api/r9/kapabilitas/plugins/remove', { id: id }).then(function (r) { if (r.ok) loadKapabilitas(); return r; });
      });
    },
    'data-kap-skill-add': function () {
      ownerAction('Impor skill',
        field('ksSource', 'Sumber', '<select class="select-field" id="ksSource" style="width:100%;"><option value="folder">Folder lokal</option><option value="zip">Berkas zip</option></select>') +
        field('ksPath', 'Jalur folder atau berkas zip', '<input type="text" class="input-field" id="ksPath" style="width:100%;font-family:var(--font-mono);" />'),
        function () { return core.post('/api/r9/kapabilitas/skills/import', { source: val('ksSource'), path: val('ksPath') }).then(function (r) { if (r.ok) { loadKapabilitas(); loadSettings(); } return r; }); },
        'Folder skill wajib berisi SKILL.md dengan front matter (name, description, triggers). Skill disalin ke folder skill profil Core dan langsung terbaca di daftar skill.');
    },
    'data-kap-skill-toggle': function (name, el) {
      var on = el.getAttribute('data-enabled') === 'true';
      var st = state.settings; if (!st || !st.ok) return;
      var disabled = (st.data.skills.disabled || []).slice();
      disabled = on ? disabled.concat([name]) : disabled.filter(function (n) { return n !== name; });
      ownerAction(on ? 'Nonaktifkan skill' : 'Aktifkan skill', '<p style="font-size:12.5px;">' + escapeHtml(L(on ? 'Nonaktifkan skill ini untuk routing Core?' : 'Aktifkan kembali skill ini untuk routing Core?')) + ' <strong>' + escapeHtml(name) + '</strong></p>', function () {
        return controlSession().then(function (id) { return core.post('/api/r9/settings', { action: 'update', cliSession: id, client: state.control.client, values: { skills: { disabled: disabled } } }); }).then(function (r) { if (r.ok) { loadSettings(); loadKapabilitas(); } return r; });
      });
    },
    'data-kap-skill-remove': function (name) {
      ownerAction('Hapus skill', '<p style="font-size:12.5px;">' + escapeHtml(L('Hapus skill')) + ' <strong>' + escapeHtml(name) + '</strong> ' + escapeHtml(L('dari folder skill profil Core? Foldernya dihapus.')) + '</p>', function () {
        return core.post('/api/r9/kapabilitas/skills/remove', { name: name }).then(function (r) { if (r.ok) { loadKapabilitas(); loadSettings(); } return r; });
      });
    },
    'data-run-diagnostics': function () { refresh().then(renderAll); },
    'data-jump-view': function (v) { navigateTo(v); },
    // Provider steps are delegated to whatever the provider views expose: DamarControl.onboarding = { connect(), grant() }.
    'data-onboard': function (stepName) { var hook = root.DamarControl && root.DamarControl.onboarding; if (hook && typeof hook[stepName] === 'function') hook[stepName](helpers); else navigateTo('providers'); },
    'data-hide-onboarding': function () { state.onboardingHidden = true; store('damar.control.onboarding', 'hidden'); renderAll(); }
  };
  function checkpointRun(id, kind) {
    core.post('/api/r9/checkpoints', { action: 'preview', kind: kind, cliSession: id, client: state.control.client }).then(function (p) {
      if (!p.ok) return showToast(describeFailure(p));
      ownerAction(kind === 'undo' ? 'Undo last change' : 'Redo change', '<pre style="font-size:11px;white-space:pre-wrap;max-height:240px;overflow:auto;">' + escapeHtml(JSON.stringify(p.data, null, 1)) + '</pre>', function () {
        return core.post('/api/r9/checkpoints', { action: 'run', kind: kind, cliSession: id, client: state.control.client }).then(function (r) { if (r.ok) ACTIONS['data-checkpoints'](id); return r; });
      }, 'Core restores the listed files from its checkpoint ledger.');
    });
  }
  function openDelegate() {
    var runs = LIVE.d('runs'), workers = runs ? runs.workers : ['puntadewa', 'werkudara', 'janaka', 'nakula', 'sadewa'];
    ownerAction('Delegate Pandawa run', field('pwWorker', 'Pandawa worker', '<select class="select-field" id="pwWorker" style="width:100%;">' + workers.map(function (w) { return '<option value="' + escapeHtml(w) + '">' + escapeHtml(w) + '</option>'; }).join('') + '</select>') +
      field('pwTask', 'Task (max 2000 characters)', '<textarea class="input-field" id="pwTask" maxlength="2000" style="width:100%;min-height:90px;"></textarea>'),
    function () {
      var task = val('pwTask');
      return controlSession().then(function (id) { return core.post('/api/r9/pandawa/runs', { cliSession: id, requestId: newClientId().replace('ctl_', 'req_'), worker: val('pwWorker'), task: task }); });
    }, 'The run uses the active provider; Core refuses it when that provider is not executable.');
  }

  // ==========================================================================
  // 7. SHELL (prototype behaviour: sidebar, breadcrumbs, palette, dialogs, drawer, keyboard)
  // ==========================================================================
  var activeCc2Dialog = null, cc2DialogReturnFocus = null;
  function showToast(message) {
    var container = document.getElementById('toastContainer'); if (!container) return;
    var existing = container.querySelectorAll('.toast-item span');
    for (var i = 0; i < existing.length; i++) if (existing[i].textContent === String(message)) return;
    var el = document.createElement('div'); el.className = 'toast-item';
    el.innerHTML = '<span>' + escapeHtml(message) + '</span><button type="button" class="btn btn-ghost btn-sm" style="height:20px;padding:0 5px;" aria-label="Dismiss">✕</button>';
    el.querySelector('button').addEventListener('click', function () { if (el.parentNode) el.parentNode.removeChild(el); });
    container.appendChild(el); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4200);
  }
  function renderSidebar() {
    var navEl = document.getElementById('sidebarNavContainer'); if (!navEl) return;
    navEl.innerHTML = NAV_GROUPS.map(function (grp) {
      return '<div class="nav-group"><div class="nav-group-label">' + escapeHtml(L(grp.group)) + '</div>' + grp.items.map(function (item) {
        var b = item.badgeFn ? item.badgeFn() : null;
        return '<button type="button" class="nav-item' + (state.activeView === item.id ? ' active" aria-current="page' : '') + '" data-nav-id="' + item.id + '" title="' + escapeHtml(L(item.label)) + '"><span class="nav-item-left"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' + item.icon + '</svg><span class="nav-item-label">' + escapeHtml(L(item.label)) + '</span></span>' +
          (b !== null && b !== undefined ? '<span class="nav-item-badge' + (item.badgeClass ? ' ' + item.badgeClass : '') + '">' + escapeHtml(b) + '</span>' : '') + '</button>';
      }).join('') + '</div>';
    }).join('');
    Array.prototype.forEach.call(navEl.querySelectorAll('.nav-item'), function (b) {
      b.addEventListener('click', function () {
        var id = this.getAttribute('data-nav-id');
        if (id === 'skills') state.capabilityFilter = 'Skills'; else if (id === 'plugins') state.capabilityFilter = 'Plugins'; else if (id === 'mcp') state.capabilityFilter = 'MCP';
        navigateTo(id);
      });
    });
  }
  function updateHeader() {
    var groupName = 'Workspace', label = 'Overview';
    NAV_GROUPS.forEach(function (g) { g.items.forEach(function (i) { if (i.id === state.activeView) { groupName = g.group; label = i.label; } }); });
    document.getElementById('breadcrumbGroup').textContent = L(groupName);
    document.getElementById('breadcrumbTitle').textContent = L(label);
    document.documentElement.lang = LANG;
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) { el.textContent = L(el.getAttribute('data-i18n')); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-aria]'), function (el) { el.setAttribute('aria-label', L(el.getAttribute('data-i18n-aria'))); });
    var lc = LIVE.d('lifecycle'), r = state.core.lifecycle;
    var st = lc ? lc.state.state : r ? (r.status === 401 ? 'UNAUTHORIZED' : 'UNREACHABLE') : 'CONNECTING';
    document.getElementById('runtimeTruthState').textContent = st;
    document.getElementById('runtimeTruthDot').className = 'status-dot ' + (st === 'READY' ? 'dot-healthy' : lc ? 'dot-simulated' : r ? 'dot-blocked' : 'dot-neutral');
    document.getElementById('runtimeTruthDetail').textContent = '• Owner session';
    document.getElementById('topbarPendingCount').textContent = lc ? String(lc.outstanding.pendingPermissions) : '–';
    document.getElementById('sidebarEndpointLabel').textContent = state.endpoint || '-';
  }
  function renderAll() {
    var shell = document.getElementById('dashboardShell');
    shell.classList.toggle('sidebar-collapsed', !!state.sidebarCollapsed);
    shell.classList.toggle('mobile-drawer-open', !!state.mobileDrawerOpen);
    renderSidebar(); updateHeader();
    var main = document.getElementById('mainWorkspaceContent');
    if (!state.credentialsPresent) main.innerHTML = pageHeader('DAMAR CONTROL', 'Kredensial Owner diperlukan', 'Buka Control dari Presence (ikon roda gigi) atau dari launcher Owner. Sesi yang sudah masuk bertahan selama sesi browser ini; halaman ini tidak pernah meminta atau menyimpan kredensial.');
    else main.innerHTML = renderView(state.activeView);
  }
  function navigateTo(viewId) {
    state.activeView = viewId; state.mobileDrawerOpen = false; state.formDirty = false;
    store('damar.control.view', viewId);
    if (viewId === 'models') refresh().then(renderAll);
    if (viewId === 'settings' && state.control.id && !state.settings) loadSettings();
    renderAll(); window.scrollTo({ top: 0, behavior: 'auto' });
    var main = document.getElementById('mainWorkspaceContent'); main.setAttribute('tabindex', '-1'); main.focus({ preventScroll: true });
  }
  function updateMobileSidebarInert() {
    var sidebar = document.getElementById('appSidebar');
    if (window.matchMedia('(max-width: 1024px)').matches && !state.mobileDrawerOpen) { sidebar.setAttribute('inert', ''); sidebar.setAttribute('aria-hidden', 'true'); }
    else { sidebar.removeAttribute('inert'); sidebar.removeAttribute('aria-hidden'); }
  }
  function openCc2Dialog(dialog, initialFocus) {
    if (activeCc2Dialog && activeCc2Dialog !== dialog) closeCc2Dialog(activeCc2Dialog, false);
    cc2DialogReturnFocus = document.activeElement; activeCc2Dialog = dialog;
    dialog.classList.add('open'); dialog.setAttribute('aria-hidden', 'false');
    var target = initialFocus || dialog.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
    if (target) setTimeout(function () { if (activeCc2Dialog === dialog) target.focus(); }, 0);
  }
  function closeCc2Dialog(dialog, restoreFocus) {
    if (!dialog) return;
    dialog.classList.remove('open'); dialog.setAttribute('aria-hidden', 'true');
    if (activeCc2Dialog === dialog) {
      activeCc2Dialog = null; var t = cc2DialogReturnFocus; cc2DialogReturnFocus = null;
      if (restoreFocus !== false && t && t.isConnected && typeof t.focus === 'function') t.focus();
    }
  }
  function openInspectorDrawer(kicker, title, bodyHtml) {
    var dk = document.getElementById('drawerKicker'); if (dk) dk.style.display = 'none'; document.getElementById('drawerTitle').textContent = title;
    document.getElementById('drawerBodyContent').innerHTML = bodyHtml;
    openCc2Dialog(document.getElementById('detailDrawerBackdrop'), document.getElementById('closeDetailDrawerBtn'));
  }
  function renderCommandPaletteResults(query) {
    var box = document.getElementById('cmdPaletteResults'), q = String(query || '').toLowerCase().trim(), entries = [];
    NAV_GROUPS.forEach(function (g) { g.items.forEach(function (i) { entries.push({ label: L('Go to') + ' ' + i.label, cat: g.group, action: function () { navigateTo(i.id); } }); }); });
    entries.push({ label: L('Delegate Pandawa run'), cat: 'Action', action: openDelegate });
    entries.push({ label: L('Refresh from Core'), cat: 'Action', action: function () { refresh().then(renderAll); } });
    var sl = root.DAMAR_SUPPORT || {};
    if (sl.issues) entries.push({ label: 'Report a problem (GitHub Issues)', cat: 'Help', action: function () { root.open(sl.issues, '_blank', 'noopener'); } });
    if (sl.discussions) entries.push({ label: 'Ask a question (GitHub Discussions)', cat: 'Help', action: function () { root.open(sl.discussions, '_blank', 'noopener'); } });
    var matched = entries.filter(function (e) { return !q || e.label.toLowerCase().indexOf(q) !== -1 || e.cat.toLowerCase().indexOf(q) !== -1; });
    box.innerHTML = matched.map(function (m, i) { return '<button type="button" class="nav-item" data-cmd-idx="' + i + '" style="padding:9px 12px;"><span style="color:var(--text-ivory);">' + escapeHtml(m.label) + '</span><span class="badge badge-neutral">' + escapeHtml(L(m.cat)) + '</span></button>'; }).join('') ||
      '<div style="padding:18px;text-align:center;color:var(--text-muted);">' + escapeHtml(L('No matching commands.')) + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-cmd-idx]'), function (b) {
      b.addEventListener('click', function () { var m = matched[parseInt(this.getAttribute('data-cmd-idx'), 10)]; closeCc2Dialog(document.getElementById('cmdPaletteBackdrop')); if (m) m.action(); });
    });
  }

  function initGlobalEvents() {
    document.querySelector('.skip-link').addEventListener('click', function (e) { e.preventDefault(); var m = document.getElementById('mainWorkspaceContent'); m.setAttribute('tabindex', '-1'); m.focus(); });
    var brand = document.getElementById('brandHomeBtn');
    brand.addEventListener('click', function () { navigateTo('overview'); });
    brand.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo('overview'); } });
    document.getElementById('sidebarCollapseBtn').addEventListener('click', function () { state.sidebarCollapsed = !state.sidebarCollapsed; store('damar.control.collapsed', state.sidebarCollapsed ? '1' : null); renderAll(); });
    document.getElementById('mobileMenuBtn').addEventListener('click', function () {
      state.mobileDrawerOpen = !state.mobileDrawerOpen; this.setAttribute('aria-expanded', String(state.mobileDrawerOpen)); renderAll(); updateMobileSidebarInert();
      if (state.mobileDrawerOpen) { var f = document.querySelector('#appSidebar .nav-item'); if (f) f.focus(); }
    });
    document.getElementById('openIdlePresenceSidebarBtn').addEventListener('click', function () {
      controlSession().then(function (id) { return core.post('/api/r9/presence/raise', { cliSession: id, client: state.control.client }); })
        .then(function (r) { showToast(r && r.ok ? 'Idle Presence ditampilkan.' : describeFailure(r)); }, function (r) { showToast(describeFailure(r)); });
    });
    document.getElementById('runtimeTruthBadgeBtn').addEventListener('click', function () { navigateTo('runtime'); });
    document.getElementById('topbarNotifBtn').addEventListener('click', function () { navigateTo('security'); });
    document.getElementById('topbarSettingsBtn').addEventListener('click', function () { navigateTo('settings'); });
    document.getElementById('topbarNewTaskBtn').addEventListener('click', openDelegate);
    var cmd = document.getElementById('cmdPaletteBackdrop'), cmdInput = document.getElementById('cmdPaletteSearchInput');
    function openCmd() { openCc2Dialog(cmd, cmdInput); cmdInput.value = ''; renderCommandPaletteResults(''); }
    document.getElementById('cmdPaletteTriggerBtn').addEventListener('click', openCmd);
    document.getElementById('closeCmdPaletteBtn').addEventListener('click', function () { closeCc2Dialog(cmd); });
    cmd.addEventListener('click', function (e) { if (e.target === cmd) closeCc2Dialog(cmd); });
    cmdInput.addEventListener('input', function () { renderCommandPaletteResults(this.value); });
    var act = document.getElementById('actionModalBackdrop');
    ['closeActionModalBtn', 'cancelActionModalBtn'].forEach(function (id) { document.getElementById(id).addEventListener('click', function () { closeCc2Dialog(act); }); });
    var drawer = document.getElementById('detailDrawerBackdrop');
    document.getElementById('closeDetailDrawerBtn').addEventListener('click', function () { closeCc2Dialog(drawer); });
    drawer.addEventListener('click', function (e) { if (e.target === drawer) closeCc2Dialog(drawer); });
    // Delegated actions inside the workspace (data-* attributes map to ACTIONS).
    document.getElementById('mainWorkspaceContent').addEventListener('click', function (e) {
      var el = e.target.closest('button, [data-jump-view]'); if (!el) return;
      if (el.id === 'pandawaCreateTaskBtn') return openDelegate();
      for (var name in ACTIONS) if (el.hasAttribute(name)) { ACTIONS[name](el.getAttribute(name), el); return; }
    });
    window.addEventListener('keydown', function (e) {
      if (activeCc2Dialog && e.key === 'Tab') {
        var stops = Array.prototype.slice.call(activeCc2Dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(function (el) { return el.getClientRects().length > 0; });
        if (!stops.length) { e.preventDefault(); return; }
        var first = stops[0], last = stops[stops.length - 1];
        if (e.shiftKey && (document.activeElement === first || !activeCc2Dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !activeCc2Dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        return;
      }
      if (activeCc2Dialog && e.key === 'Escape') { e.preventDefault(); closeCc2Dialog(activeCc2Dialog); return; }
      if (state.mobileDrawerOpen && e.key === 'Escape') { state.mobileDrawerOpen = false; var mb = document.getElementById('mobileMenuBtn'); mb.setAttribute('aria-expanded', 'false'); renderAll(); updateMobileSidebarInert(); mb.focus(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmd(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); state.sidebarCollapsed = !state.sidebarCollapsed; renderAll(); }
    });
    window.addEventListener('mousemove', function (e) {
      Array.prototype.forEach.call(document.querySelectorAll('.signal-tile, .panel, .cap-card'), function (c) { var r = c.getBoundingClientRect(); c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px'); });
    });
    window.addEventListener('resize', updateMobileSidebarInert);
    // An edited, unsaved form is never replaced by the 5 s live refresh.
    ['input', 'change'].forEach(function (t) { document.getElementById('mainWorkspaceContent').addEventListener(t, function (e) { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) state.formDirty = true; }); });
  }

  function boot() {
    var creds = parseFragment(root.location.hash);
    // Strip the credential from the address bar and history entry immediately.
    if (root.location.hash) root.history.replaceState(null, '', root.location.pathname);
    // Refresh survival (Owner 2026-11-28): the launcher credential is kept in
    // sessionStorage, scoped to this browser session, and re-presented on
    // reload, so a refresh no longer locks the Owner out of his own
    // dashboard. A fresh browser session holds nothing and still gets the
    // credential requirement; the protection itself is unchanged.
    try {
      if (creds.owner) root.sessionStorage.setItem('damar.control.creds', JSON.stringify({ owner: creds.owner, console: creds.console }));
      else { var savedCreds = JSON.parse(root.sessionStorage.getItem('damar.control.creds') || 'null'); if (savedCreds && savedCreds.owner) creds = { owner: savedCreds.owner, console: savedCreds.console || '', view: creds.view }; }
    } catch (e) {}
    state.credentialsPresent = !!creds.owner;
    state.endpoint = root.location.host;
    state.activeView = (VIEWS[creds.view] && creds.view) || load('damar.control.view') || 'overview';
    state.sidebarCollapsed = load('damar.control.collapsed') === '1';
    state.workspace = load('damar.control.workspace') || '';
    state.onboardingHidden = load('damar.control.onboarding') === 'hidden';
    state.control.client = load('damar.control.client') || newClientId(); store('damar.control.client', state.control.client);
    state.control.id = load('damar.control.session');
    core = createCore({ owner: creds.owner, console: creds.console });
    initGlobalEvents(); renderAll(); updateMobileSidebarInert();
    if (!state.credentialsPresent) return;
    refresh().then(renderAll);
    setInterval(heartbeat, 5000);
    // Live refresh; skipped while the Owner is typing or a dialog is open, so input is never clobbered.
    setInterval(function () {
      var a = document.activeElement;
      if (activeCc2Dialog || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
      refresh().then(function () { if (!state.formDirty) renderAll(); });
    }, 5000);
  }

  // Extension point for separately shipped views (src/control/views/*.js, injected by serve.cjs after control.js):
  //   DamarControl.registerView('matadewa', { label, group, icon, render: helpers => html })
  // Replaces a built-in placeholder (e.g. an unavailable view) or appends a nav item to the named group.
  function registerView(id, def) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id) || !def || typeof def.render !== 'function') throw Error('VIEW_INVALID');
    VIEWS[id] = function () { return def.render(helpers); };
    var found = false;
    NAV_GROUPS.forEach(function (g) { g.items.forEach(function (it) { if (it.id === id) { found = true; if (def.label) it.label = def.label; if (def.icon) it.icon = def.icon; delete it.badgeFn; } }); });
    if (!found) { var g = NAV_GROUPS.filter(function (x) { return x.group === def.group; })[0] || NAV_GROUPS[2]; g.items.push({ id: id, label: def.label || id, icon: def.icon || '<circle cx="12" cy="12" r="9"/>' }); }
    if (typeof document !== 'undefined' && document.getElementById('dashboardShell')) renderAll();
  }
  var helpers = { escapeHtml: escapeHtml, statusBadgeHtml: statusBadgeHtml, pageHeader: pageHeader, panel: panel, table: table, kv: kv, kvList: kvList, mono: mono, btn: btn,
    get: function (route) { return core.get(route); }, post: function (route, body) { return core.post(route, body); }, refresh: function () { return refresh().then(renderAll); }, state: function () { return state; }, controlSession: function () { return controlSession(); } };
  root.DamarControl = root.DamarControl || {}; root.DamarControl.registerView = registerView;

  function setLanguage(l) { LANG = l === 'id' ? 'id' : 'en'; }
  var api = { setLanguage: setLanguage, L: L, ERRORS: ERRORS, registerView: registerView, grantRequest: grantRequest, redact: redact, escapeHtml: escapeHtml, parseFragment: parseFragment, createCore: createCore, describeFailure: describeFailure, renderView: renderView, READS: READS, UNAVAILABLE: UNAVAILABLE, VIEWS: Object.keys(VIEWS) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof document !== 'undefined') boot();
})(typeof window !== 'undefined' ? window : globalThis);
