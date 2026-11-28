// DAMAR Control, Otomasi view. The daemon automation service's real record,
// served by Core at GET /api/r9/otomasi (Owner only): the daily WhatsApp
// brief's config state, the scheduler's running state, the last processed
// day, and the brief outcomes the service published to the daemon's
// telemetry buffer. The service lives exactly once in the canonical daemon;
// this page is a read projection. Changing the schedule or running a brief
// from Control is not wired: the daemon console rejects legacy action
// ingress for automation and no gated write route exists yet, and the page
// says so instead of offering controls that do nothing. Categories without
// real records render their honest empty state; nothing here is simulated.
// UI language follows the shared CLI language setting
// (GET /api/r9/cli/settings, cli.language; null -> English).
(function (root) {
  'use strict';
  var ot = { data: null, error: null, loading: false, lastLoad: 0, lang: 'en' };
  var H = null;

  var STR = {
    en: { subtitle: 'The scheduled daily brief in the canonical daemon, read live from Core.',
      loading: 'Loading from Core…', briefPanel: 'Daily WhatsApp brief', status: 'Status', active: 'Active', inactive: 'Inactive',
      schedule: 'Daily schedule', atTime: 'at %s', lastProcessed: 'Last brief day processed', never: 'Never yet',
      scheduler: 'Daemon scheduler', running: 'Running', notRunning: 'Not running', readAt: 'Read at',
      source: 'Source', srcDaemon: 'Automation service in the canonical daemon, via Core',
      down: 'The automation state could not be read from the daemon.',
      reasonNotActive: 'The automation projection is not active on the running daemon yet. It activates when the daemon is next relaunched; no data is shown before that.',
      reasonNoCred: 'The daemon credential is not available in this installation, so the automation state cannot be read.',
      reasonUnreachable: 'The Damar daemon is unreachable from Core, so the automation state cannot be read.',
      history: 'Brief history', historyEmpty: 'No brief recorded on the daemon at this time. Briefs the scheduler processes appear here with their real outcomes.',
      historyWaiting: 'Waiting for the daemon projection to be readable.',
      when: 'Time', outcome: 'Outcome', recipients: 'Recipients', size: 'Brief size', chars: '%s characters',
      ocCompleted: 'Delivered', ocUnknown: 'Unknown',
      writePanel: 'Changing automations', writeNote: 'This page reads the automation state. Changing the schedule or running a brief from Control is not connected yet: the write path for automations in the daemon is still closed to legacy action ingress and waits for the canonical Manager path.' },
    id: { subtitle: 'Brief harian terjadwal di daemon kanonis, dibaca langsung dari Core.',
      loading: 'Memuat dari Core…', briefPanel: 'Brief harian WhatsApp', status: 'Status', active: 'Aktif', inactive: 'Nonaktif',
      schedule: 'Jadwal harian', atTime: 'pukul %s', lastProcessed: 'Hari brief terakhir diproses', never: 'Belum pernah',
      scheduler: 'Penjadwal daemon', running: 'Berjalan', notRunning: 'Tidak berjalan', readAt: 'Dibaca pada',
      source: 'Sumber', srcDaemon: 'Layanan otomasi di daemon kanonis, lewat Core',
      down: 'Keadaan otomasi tidak dapat dibaca dari daemon.',
      reasonNotActive: 'Proyeksi otomasi belum aktif pada daemon yang berjalan. Proyeksi aktif setelah daemon dimuat ulang; tidak ada data yang ditampilkan sebelum itu.',
      reasonNoCred: 'Kredensial daemon tidak tersedia pada instalasi ini, jadi keadaan otomasi tidak terbaca.',
      reasonUnreachable: 'Daemon Damar tidak terjangkau dari Core, jadi keadaan otomasi tidak terbaca.',
      history: 'Riwayat brief', historyEmpty: 'Belum ada brief tercatat pada daemon saat ini. Brief yang diproses penjadwal tampil di sini dengan hasil aslinya.',
      historyWaiting: 'Menunggu proyeksi daemon terbaca.',
      when: 'Waktu', outcome: 'Hasil', recipients: 'Penerima', size: 'Ukuran brief', chars: '%s karakter',
      ocCompleted: 'Terkirim', ocUnknown: 'Tidak diketahui',
      writePanel: 'Mengubah otomasi', writeNote: 'Halaman ini membaca keadaan otomasi. Mengubah jadwal atau menjalankan brief dari Control belum terhubung: jalur tulis otomasi di daemon masih ditutup untuk ingress tindakan lama dan menunggu jalur Manager kanonis.' }
  };
  function T(k) { return (STR[ot.lang] || STR.en)[k] || STR.en[k] || k; }
  function esc(v) { return H.escapeHtml(v == null ? '' : String(v)); }
  function when(ts) { return ts ? new Date(ts).toLocaleString(ot.lang === 'id' ? 'id-ID' : 'en-GB') : '-'; }
  function outcomeLabel(o) { if (o === 'COMPLETED') return T('ocCompleted'); if (!o || o === 'UNKNOWN') return T('ocUnknown'); return o; }

  function load() {
    if (!H || ot.loading) return;
    ot.loading = true;
    H.get('/api/r9/cli/settings').then(function (r) { ot.lang = r.ok && r.data && r.data.cli && r.data.cli.language === 'id' ? 'id' : 'en'; });
    H.get('/api/r9/otomasi').then(function (r) {
      ot.loading = false; ot.lastLoad = Date.now();
      if (r.ok && r.data) { ot.data = r.data; ot.error = null; } else ot.error = r.error || ('HTTP ' + r.status);
      if (H) H.refresh();
    });
  }

  function reasonText(reason) {
    if (reason === 'PROYEKSI_BELUM_AKTIF') return T('reasonNotActive');
    if (reason === 'KREDENSIAL_TIDAK_TERSEDIA') return T('reasonNoCred');
    return T('reasonUnreachable');
  }

  function render(helpers) {
    H = helpers;
    if (Date.now() - ot.lastLoad > 15000) load();
    var head = H.pageHeader('WORKSPACE • SCHEDULED WORK', 'Otomasi', T('subtitle'));
    if (!ot.data) return head + H.panel('Otomasi', ot.error ? H.statusBadgeHtml('UNAVAILABLE', 'Core · ' + ot.error) : '<div style="font-size:12px;color:var(--text-muted);">' + esc(T('loading')) + '</div>', { span: 12 });
    var d = ot.data;
    var html = head + '<div class="workspace-grid-12">';
    if (d.available) {
      var st = d.status || {};
      html += H.panel(T('briefPanel'), H.kvList([
        H.kv(T('status'), st.enabled ? T('active') : T('inactive')),
        H.kv(T('schedule'), st.time ? T('atTime').replace('%s', st.time) : '-'),
        H.kv(T('lastProcessed'), st.lastSent || T('never')),
        H.kv(T('scheduler'), st.running ? T('running') : T('notRunning')),
        H.kv(T('readAt'), when(d.generatedAt)),
        H.kv(T('source'), T('srcDaemon'))
      ]), { span: 5, badge: H.statusBadgeHtml(st.enabled ? 'READY' : 'NOT_AVAILABLE', st.enabled ? T('active') : T('inactive')) });
    } else {
      html += H.panel(T('briefPanel'), '<div style="font-size:12.5px;color:var(--text-secondary);">' + esc(reasonText(d.reason)) + '</div>',
        { span: 5, badge: H.statusBadgeHtml('UNAVAILABLE', 'Otomasi') });
    }
    html += H.panel(T('writePanel'), '<div style="font-size:12.5px;color:var(--text-secondary);">' + esc(T('writeNote')) + '</div>', { span: 7 });
    var histBody;
    if (!d.available) histBody = '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">' + esc(T('historyWaiting')) + '</div>';
    else histBody = H.table([T('when'), T('outcome'), T('recipients'), T('size')], (d.briefs || []).map(function (b) {
      return [esc(when(b.at)), esc(outcomeLabel(b.outcome)), esc(String(b.recipients != null ? b.recipients : 0)), esc(b.chars != null ? T('chars').replace('%s', b.chars) : '-')];
    }), T('historyEmpty'));
    html += H.panel(T('history'), histBody, { span: 12, flush: true });
    return html + '</div>';
  }

  var def = { label: 'Otomasi', render: render };
  if (root.DamarControl && root.DamarControl.registerView) root.DamarControl.registerView('automations', def);
  if (typeof module !== 'undefined' && module.exports) module.exports = { def: def, state: ot, STR: STR };
})(typeof window !== 'undefined' ? window : globalThis);
