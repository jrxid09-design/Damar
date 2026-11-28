// DAMAR Control, Otomasi view. The daemon automation service's real record,
// served by Core at GET /api/r9/otomasi (Owner only): the daily WhatsApp
// brief's config state, the scheduler's running state, the last processed
// day, and the brief outcomes the service published to the daemon's
// telemetry buffer. The service lives exactly once in the canonical daemon.
// This page also writes: the schedule form and the run-now button post to
// Core's owner-only Otomasi write routes, which bind the daemon's
// token-guarded write seam; the daemon applies a saved config through the
// service singleton, so the scheduler picks it up on its next tick with no
// daemon restart. Saving and running are ordinary Owner steps here: no
// approval prompt stands in front of them, and the brief's send keeps
// flowing through the service's own governed submit in the daemon.
// Categories without
// real records render their honest empty state; nothing here is simulated.
// UI language follows the shared CLI language setting
// (GET /api/r9/cli/settings, cli.language; null -> English).
(function (root) {
  'use strict';
  var ot = { data: null, error: null, loading: false, lastLoad: 0, lang: 'en', busy: false, notice: null, noticeOk: false };
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
      writePanel: 'Brief settings', enabledLabel: 'Daily brief active', timeLabel: 'Brief time', save: 'Save', runNow: 'Run now', savedOk: 'Saved. The daemon scheduler applies the new schedule from its next tick, with no daemon restart.', runOk: 'Brief run finished with governed outcome %s. Its record is in the brief history below.', writeDown: 'Settings cannot be changed right now: ', actionFailed: 'The action did not complete.' },
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
      writePanel: 'Pengaturan brief', enabledLabel: 'Brief harian aktif', timeLabel: 'Waktu brief', save: 'Simpan', runNow: 'Jalankan sekarang', savedOk: 'Tersimpan. Penjadwal daemon memakai jadwal baru mulai tick berikutnya, tanpa memuat ulang daemon.', runOk: 'Lari brief selesai dengan hasil governed %s. Catatannya ada di riwayat brief di bawah.', writeDown: 'Pengaturan belum bisa diubah saat ini: ', actionFailed: 'Tindakan tidak selesai.' }
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

  var otoBound = false;
  function bindActions() {
    if (otoBound || typeof document === 'undefined') return;
    otoBound = true;
    document.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-oto-action]') : null;
      if (!el) return;
      var action = el.getAttribute('data-oto-action');
      if (action === 'save') saveConfig();
      else if (action === 'run') runNow();
    });
  }

  function failNotice(r) {
    if (r && r.data && r.data.reason === 'VALIDASI_DITOLAK' && r.data.detail) return r.data.detail;
    if (r && r.data && r.data.reason) return T('writeDown') + reasonText(r.data.reason);
    return (r && r.error) || T('actionFailed');
  }
  function saveConfig() {
    if (!H || ot.busy) return;
    var en = document.getElementById('otoEnabled');
    var tm = document.getElementById('otoTime');
    if (!en || !tm) return;
    ot.busy = true; ot.notice = null;
    H.post('/api/r9/otomasi/config', { enabled: en.checked === true, time: tm.value }).then(function (r) {
      ot.busy = false;
      if (r.ok && r.data && r.data.available) { ot.notice = T('savedOk'); ot.noticeOk = true; }
      else { ot.notice = failNotice(r); ot.noticeOk = false; }
      ot.lastLoad = 0; load();
      if (H) H.refresh();
    });
  }

  function runNow() {
    if (!H || ot.busy) return;
    ot.busy = true; ot.notice = null;
    H.post('/api/r9/otomasi/run', {}).then(function (r) {
      ot.busy = false;
      if (r.ok && r.data && r.data.available && r.data.run) { ot.notice = T('runOk').replace('%s', outcomeLabel(r.data.run.outcome)); ot.noticeOk = true; }
      else { ot.notice = failNotice(r); ot.noticeOk = false; }
      ot.lastLoad = 0; load();
      if (H) H.refresh();
    });
  }
  function writePanelHtml(d) {
    if (!d.available) return '<div style="font-size:12.5px;color:var(--text-secondary);">' + esc(reasonText(d.reason)) + '</div>';
    var st = d.status || {};
    return '<div style="display:flex;flex-direction:column;gap:10px;font-size:12.5px;">'
      + '<label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" id="otoEnabled"' + (st.enabled ? ' checked' : '') + '> ' + esc(T('enabledLabel')) + '</label>'
      + '<label style="display:flex;gap:8px;align-items:center;">' + esc(T('timeLabel')) + ' <input type="time" id="otoTime" class="input-field" style="width:auto;" value="' + esc(st.time || '07:00') + '"></label>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">' + H.btn(T('save'), 'data-oto-action="save"', 'btn-primary') + H.btn(T('runNow'), 'data-oto-action="run"') + '</div>'
      + (ot.notice ? '<div style="font-size:12px;color:' + (ot.noticeOk ? 'var(--text-secondary)' : 'var(--danger, #c0392b)') + ';">' + esc(ot.notice) + '</div>' : '')
      + '</div>';
  }
  function render(helpers) {
    H = helpers;
    bindActions();
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
    html += H.panel(T('writePanel'), writePanelHtml(d), { span: 7 });
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
