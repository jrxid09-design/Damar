// DAMAR Control, Damar Cyber view. Werkudara's real defensive record, served
// by Core at GET /api/r9/cyber (Owner only): patrol and task runs from Core's
// durable Pandawa registry, plus the DCD posture projection Core reads from
// the canonical daemon, which owns the single detection engine. Categories
// without real records render their honest empty state; nothing here is
// simulated. UI language follows the shared CLI language setting
// (GET /api/r9/cli/settings, cli.language; null -> English).
(function (root) {
  'use strict';
  var cy = { data: null, error: null, loading: false, lastLoad: 0, lang: 'en' };
  var H = null;

  var STR = {
    en: { subtitle: 'Werkudara patrol record and the DCD detection posture, read live from Core.',
      loading: 'Loading from Core…', dcdStatus: 'DCD posture', engine: 'Engine', activeIncidents: 'Active incidents', totalIncidents: 'Total incidents', readAt: 'Read at',
      dcdDown: 'The DCD posture projection could not be read from the daemon.',
      reasonNotActive: 'The posture projection is not active on the running daemon yet. It activates when the daemon is next relaunched; no data is shown before that.',
      reasonNoCred: 'The daemon credential is not available in this installation, so the posture cannot be read.',
      reasonUnreachable: 'The Damar daemon is unreachable from Core, so the posture cannot be read.',
      patrol: 'Werkudara patrols', patrolEmpty: 'No Werkudara patrol recorded on this Core session yet. Patrols run through Damar appear here with their real results.',
      incidents: 'Defence events', incidentsEmpty: 'No incidents recorded in the detection engine at this time.', incidentsWaiting: 'Waiting for the daemon projection to be readable.',
      activity: 'Werkudara activity', totalRuns: 'Recorded tasks', completed: 'Completed', failed: 'Failed', lastRun: 'Most recent',
      activityEmpty: 'No Werkudara task recorded on this Core session yet.',
      when: 'Time', state: 'Status', task: 'Task', result: 'Result', risk: 'Risk', summary: 'Summary', source: 'Source',
      srcPatrol: 'Core Pandawa registry (Werkudara runs)', srcDcd: 'DCD engine in the canonical daemon, via Core',
      stCOMPLETED: 'Completed', stFAILED: 'Failed', stRUNNING: 'Running', stACCEPTED: 'Waiting', stCANCELLED: 'Cancelled', stOUTCOME_UNKNOWN: 'Outcome unknown' },
    id: { subtitle: 'Catatan patroli Werkudara dan postur deteksi DCD, dibaca langsung dari Core.',
      loading: 'Memuat dari Core…', dcdStatus: 'Postur DCD', engine: 'Mesin', activeIncidents: 'Insiden aktif', totalIncidents: 'Total insiden', readAt: 'Dibaca pada',
      dcdDown: 'Proyeksi postur DCD tidak dapat dibaca dari daemon.',
      reasonNotActive: 'Proyeksi postur belum aktif pada daemon yang berjalan. Proyeksi aktif setelah daemon dimuat ulang; tidak ada data yang ditampilkan sebelum itu.',
      reasonNoCred: 'Kredensial daemon tidak tersedia pada instalasi ini, jadi postur tidak terbaca.',
      reasonUnreachable: 'Daemon Damar tidak terjangkau dari Core, jadi postur tidak terbaca.',
      patrol: 'Patroli Werkudara', patrolEmpty: 'Belum ada patroli Werkudara tercatat pada sesi Core ini. Patroli yang dijalankan lewat Damar tampil di sini dengan hasil aslinya.',
      incidents: 'Kejadian pertahanan', incidentsEmpty: 'Tidak ada insiden tercatat di mesin deteksi saat ini.', incidentsWaiting: 'Menunggu proyeksi daemon terbaca.',
      activity: 'Aktivitas Werkudara', totalRuns: 'Tugas tercatat', completed: 'Selesai', failed: 'Gagal', lastRun: 'Terakhir',
      activityEmpty: 'Belum ada tugas Werkudara tercatat pada sesi Core ini.',
      when: 'Waktu', state: 'Status', task: 'Tugas', result: 'Hasil', risk: 'Risiko', summary: 'Ringkasan', source: 'Sumber',
      srcPatrol: 'Registri Pandawa Core (tugas Werkudara)', srcDcd: 'Mesin DCD di daemon kanonis, lewat Core',
      stCOMPLETED: 'Selesai', stFAILED: 'Gagal', stRUNNING: 'Berjalan', stACCEPTED: 'Menunggu', stCANCELLED: 'Dibatalkan', stOUTCOME_UNKNOWN: 'Hasil belum diketahui' }
  };
  function T(k) { return (STR[cy.lang] || STR.en)[k] || STR.en[k] || k; }
  function esc(v) { return H.escapeHtml(v == null ? '' : String(v)); }
  function when(ts) { return ts ? new Date(ts).toLocaleString(cy.lang === 'id' ? 'id-ID' : 'en-GB') : '-'; }
  function stateLabel(s) { return T('st' + s) || s || '-'; }
  function cut(v, n) { var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

  function load() {
    if (!H || cy.loading) return;
    cy.loading = true;
    H.get('/api/r9/cli/settings').then(function (r) { cy.lang = r.ok && r.data && r.data.cli && r.data.cli.language === 'id' ? 'id' : 'en'; });
    H.get('/api/r9/cyber').then(function (r) {
      cy.loading = false; cy.lastLoad = Date.now();
      if (r.ok && r.data) { cy.data = r.data; cy.error = null; } else cy.error = r.error || ('HTTP ' + r.status);
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
    if (Date.now() - cy.lastLoad > 15000) load();
    var head = H.pageHeader('DAMAR INTELLIGENCE • SECURITY POSTURE', 'Damar Cyber', T('subtitle'));
    if (!cy.data) return head + H.panel('Damar Cyber', cy.error ? H.statusBadgeHtml('UNAVAILABLE', 'Core · ' + cy.error) : '<div style="font-size:12px;color:var(--text-muted);">' + esc(T('loading')) + '</div>', { span: 12 });
    var d = cy.data, wk = d.werkudara || { runs: [], totalRuns: 0, completed: 0, failed: 0, lastRunAt: null }, dcd = d.dcd || { available: false };
    var html = head + '<div class="workspace-grid-12">';
    if (dcd.available) {
      html += H.panel(T('dcdStatus'), H.kvList([H.kv(T('engine'), 'DCD'), H.kv(T('activeIncidents'), String(dcd.counts ? dcd.counts.active : 0)),
        H.kv(T('totalIncidents'), String(dcd.counts ? dcd.counts.total : 0)), H.kv(T('readAt'), when(dcd.generatedAt)), H.kv(T('source'), T('srcDcd'))]),
        { span: 5, badge: H.statusBadgeHtml('READY', T('activeIncidents') + ' ' + (dcd.counts ? dcd.counts.active : 0)) });
    } else {
      html += H.panel(T('dcdStatus'), '<div style="font-size:12.5px;color:var(--text-secondary);">' + esc(reasonText(dcd.reason)) + '</div>',
        { span: 5, badge: H.statusBadgeHtml('UNAVAILABLE', 'DCD') });
    }
    html += H.panel(T('activity'), wk.totalRuns ? H.kvList([H.kv(T('totalRuns'), String(wk.totalRuns)), H.kv(T('completed'), String(wk.completed)),
      H.kv(T('failed'), String(wk.failed)), H.kv(T('lastRun'), when(wk.lastRunAt)), H.kv(T('source'), T('srcPatrol'))])
      : '<div style="font-size:12.5px;color:var(--text-secondary);">' + esc(T('activityEmpty')) + '</div>', { span: 7 });
    var runRow = function (r) { return [esc(when(r.createdAt)), H.statusBadgeHtml(r.state, stateLabel(r.state)), esc(cut(r.task, 140)), esc(cut(r.outputPreview || r.error || '', 160))]; };
    html += H.panel(T('patrol'), H.table([T('when'), T('state'), T('task'), T('result')], (d.patroli || []).map(runRow), T('patrolEmpty')), { span: 12, flush: true });
    var incBody;
    if (!dcd.available) incBody = '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">' + esc(T('incidentsWaiting')) + '</div>';
    else incBody = H.table([T('when'), T('risk'), T('state'), T('summary')], (dcd.incidents || []).map(function (i) {
      return [esc(when(i.createdAt)), esc(i.riskLevel || '-'), esc(i.state || '-'), esc(cut(i.summary, 200))]; }), T('incidentsEmpty'));
    html += H.panel(T('incidents'), incBody, { span: 12, flush: true });
    html += H.panel(T('activity') + ' · Werkudara', H.table([T('when'), T('state'), T('task'), T('result')], (wk.runs || []).map(runRow), T('activityEmpty')), { span: 12, flush: true });
    return html + '</div>';
  }

  var def = { label: 'Damar Cyber', render: render };
  if (root.DamarControl && root.DamarControl.registerView) root.DamarControl.registerView('cyber', def);
  if (typeof module !== 'undefined' && module.exports) module.exports = { def: def, state: cy, STR: STR };
})(typeof window !== 'undefined' ? window : globalThis);
