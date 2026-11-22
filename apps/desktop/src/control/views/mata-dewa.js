// DAMAR Control — Mata Dewa view. Public world feeds, Owner-key feeds, camera grid (official public cameras + the
// Owner's own cameras) and ALPR on own cameras, all served by Core at /api/r9/mata-dewa/*. Capabilities adapted from
// gods-eye-view (MIT, see src/mata-dewa/THIRD_PARTY_NOTICES.md). Control's CSP is same-origin only: no external tiles
// or images; the map is inline SVG and camera frames arrive as JSON and are drawn on <canvas> via createImageBitmap.
// Settings (mataDewa.*) are written only here, by the Owner, through Core's /api/r9/settings; Core validates them.
// UI language follows the shared CLI language setting (GET /api/r9/cli/settings, cli.language; null -> English).
(function (root) {
  'use strict';
  var FEED_ORDER = ['earthquakes', 'disasters', 'cyclones', 'weather', 'openMeteo', 'openaq', 'airQuality', 'flights', 'opensky', 'military', 'vessels', 'fires', 'traffic', 'satellites', 'launches'];
  var md = { status: null, statusError: null, feeds: {}, loading: false, lastLoad: 0, draft: null, saving: false, message: '', lang: 'en',
    cams: {}, camPage: {}, own: [], alpr: null, filter: '', frames: {}, frameLoading: {}, camForm: { kind: 'snapshot' } };
  var H = null;

  // ---- i18n (English first; Indonesian when cli.language === 'id') ---------------------------------------------------
  var STR = {
    en: { subtitle: 'Public world feeds — earthquakes, cyclones, weather, air quality, aircraft, vessels, fires, satellites and launches — plus your own cameras.',
      consentTitle: 'Consent & egress disclosure', consentOn: 'I consent — enable public feeds', consentOff: 'Withdraw consent (stop all feeds)', hosts: 'Hosts',
      given: 'consent given', none: 'no consent · nothing fetched', loading: 'Loading from Core…', plot: 'World plot', noBasemap: 'No basemap: coordinates on a plain grid.',
      addKey: 'Add your key', getKey: 'Get a free key', saveKey: 'Save key (encrypted)', forgetKey: 'Forget key', keyStored: 'Key stored (never shown again)',
      attribution: 'Attribution & licences', commercial: 'Commercial use', feedsRefresh: 'Feeds & refresh (Owner)', areas: 'Areas of interest (max 4)', addArea: 'Add area', remove: 'Remove',
      discard: 'Discard', save: 'Save to Core', saving: 'Saving…', group: 'Satellite group', cameras: 'Cameras', publicCams: 'Official public cameras', ownCams: 'Your cameras',
      cctvNotice: 'Camera privacy & legal notice', accept: 'I understand and accept', filter: 'Filter by name', addCamera: 'Add camera', alpr: 'Licence-plate recognition (ALPR)', alprNotice: 'ALPR legal notice',
      alerts: 'Watchlist alerts', ack: 'Acknowledge all', log: 'Vehicle log', watchlist: 'Watchlist', export: 'Export JSON', deleteAll: 'Delete all entries', retention: 'Retention (days)', interval: 'Scan every (s)',
      engineMissing: 'ALPR engine not installed. Plates are read locally; nothing is sent to any service.', ffmpegMissing: 'ffmpeg not found: RTSP cameras need ffmpeg on PATH (optional, not bundled).',
      sources: 'Public camera sources', search: 'Search', contact: 'Contact URL for data providers (optional)', installEngine: 'Install ALPR engine', installing: 'Installing ALPR engine…', installHosts: 'The install downloads about 150 MB from:', alprOnly: 'ALPR runs only on your own cameras.', disabledAll: 'All feeds are disabled.' },
    id: { subtitle: 'Umpan dunia publik — gempa, siklon, cuaca, kualitas udara, pesawat, kapal, kebakaran, satelit dan peluncuran — serta kamera Anda sendiri.',
      consentTitle: 'Persetujuan & pengungkapan koneksi keluar', consentOn: 'Saya setuju — aktifkan umpan publik', consentOff: 'Cabut persetujuan (hentikan semua umpan)', hosts: 'Host',
      given: 'persetujuan diberikan', none: 'belum ada persetujuan · tidak ada yang diambil', loading: 'Memuat dari Core…', plot: 'Peta dunia', noBasemap: 'Tanpa peta dasar: koordinat pada grid polos.',
      addKey: 'Tambahkan kunci Anda', getKey: 'Dapatkan kunci gratis', saveKey: 'Simpan kunci (terenkripsi)', forgetKey: 'Hapus kunci', keyStored: 'Kunci tersimpan (tidak ditampilkan lagi)',
      attribution: 'Atribusi & lisensi', commercial: 'Penggunaan komersial', feedsRefresh: 'Umpan & penyegaran (Pemilik)', areas: 'Area pantauan (maks 4)', addArea: 'Tambah area', remove: 'Hapus',
      discard: 'Batalkan', save: 'Simpan ke Core', saving: 'Menyimpan…', group: 'Grup satelit', cameras: 'Kamera', publicCams: 'Kamera publik resmi', ownCams: 'Kamera Anda',
      cctvNotice: 'Pemberitahuan privasi & hukum kamera', accept: 'Saya mengerti dan setuju', filter: 'Saring nama', addCamera: 'Tambah kamera', alpr: 'Pengenalan pelat nomor (ALPR)', alprNotice: 'Pemberitahuan hukum ALPR',
      alerts: 'Peringatan daftar pantau', ack: 'Tandai semua dibaca', log: 'Log kendaraan', watchlist: 'Daftar pantau', export: 'Ekspor JSON', deleteAll: 'Hapus semua entri', retention: 'Retensi (hari)', interval: 'Pindai tiap (dtk)',
      engineMissing: 'Mesin ALPR belum terpasang. Pelat dibaca secara lokal; tidak ada data yang dikirim ke layanan mana pun.', ffmpegMissing: 'ffmpeg tidak ditemukan: kamera RTSP memerlukan ffmpeg di PATH (opsional, tidak dibundel).',
      sources: 'Sumber kamera publik', search: 'Cari', contact: 'URL kontak untuk penyedia data (opsional)', installEngine: 'Pasang mesin ALPR', installing: 'Memasang mesin ALPR…', installHosts: 'Pemasangan mengunduh sekitar 150 MB dari:', alprOnly: 'ALPR hanya berjalan pada kamera Anda sendiri.', disabledAll: 'Semua umpan dinonaktifkan.' }
  };
  function T(k) { return (STR[md.lang] && STR[md.lang][k]) || STR.en[k] || k; }
  function esc(v) { return H.escapeHtml(v == null ? '—' : v); }
  function fmt(v, unit) { return v === null || v === undefined ? '—' : String(v) + (unit || ''); }
  function owner() { return !!(md.status && md.status.alpr && md.status.alpr.engine !== undefined); }

  function load() {
    if (md.loading) return; md.loading = true; md.lastLoad = Date.now();
    H.get('/api/r9/cli/settings').then(function (r) { md.lang = r.ok && r.data && r.data.cli && r.data.cli.language === 'id' ? 'id' : 'en'; });
    H.get('/api/r9/mata-dewa/status').then(function (r) {
      md.status = r.ok ? r.data : null; md.statusError = r.ok ? null : r;
      if (!r.ok) return;
      var jobs = [];
      if (r.data.consent) r.data.feeds.forEach(function (f) { if (f.enabled && (f.credential === 'none' || f.credential.hasKey)) jobs.push(H.get('/api/r9/mata-dewa/feeds/' + f.id).then(function (x) { md.feeds[f.id] = x; })); });
      if (r.data.consent) r.data.cctv.sources.forEach(function (s) { jobs.push(loadCams(s)); });
      if (owner()) {
        jobs.push(H.get('/api/r9/mata-dewa/cameras').then(function (x) { md.own = x.ok ? x.data.own : []; }));
        jobs.push(H.get('/api/r9/mata-dewa/alpr').then(function (x) { md.alpr = x.ok ? x.data : null; }));
      }
      return Promise.all(jobs);
    }).then(function () { md.loading = false; H.refresh(); }, function () { md.loading = false; });
  }

  function loadCams(s) {
    var pg = md.camPage[s] || 1;
    return H.get('/api/r9/mata-dewa/cameras/public/' + s + '?q=' + encodeURIComponent(md.filter) + '&page=' + pg).then(function (x) { md.cams[s] = x; });
  }
  // ---- camera frames (JSON base64 -> ImageBitmap -> canvas) --------------------------------------------------------
  function frameRoute(key) { var p = key.split('|'); return p[0] === 'pub' ? '/api/r9/mata-dewa/cameras/public/' + p[1] + '/' + p[2] + '/frame' : p[0] === 'own' ? '/api/r9/mata-dewa/cameras/own/' + p[1] + '/frame' : '/api/r9/mata-dewa/alpr/crops/' + p[1] + '/frame'; }
  function frameTtl(key) { return key.indexOf('own|') === 0 ? 5000 : key.indexOf('crop|') === 0 ? 3600000 : 60000; }
  function drawFrames() {
    if (typeof document === 'undefined') return;
    Array.prototype.forEach.call(document.querySelectorAll('canvas[data-md-frame]'), function (cv) {
      var key = cv.getAttribute('data-md-frame'), f = md.frames[key];
      if (f && f.bitmap) { cv.width = f.bitmap.width; cv.height = f.bitmap.height; cv.getContext('2d').drawImage(f.bitmap, 0, 0); }
      if ((!f || Date.now() - f.at > frameTtl(key)) && !md.frameLoading[key]) {
        md.frameLoading[key] = true;
        H.get(frameRoute(key)).then(function (r) {
          if (!r.ok) { md.frames[key] = { at: Date.now(), error: r.error }; return; }
          var bin = atob(r.data.jpeg), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return createImageBitmap(new Blob([u8], { type: 'image/jpeg' })).then(function (bm) { md.frames[key] = { at: Date.now(), bitmap: bm }; });
        }).then(function () { md.frameLoading[key] = false; drawFrames(); }, function () { md.frameLoading[key] = false; });
      }
    });
  }
  function canvas(key, label) {
    var f = md.frames[key];
    return '<figure style="margin:0;display:flex;flex-direction:column;gap:4px;"><canvas data-md-frame="' + H.escapeHtml(key) + '" role="img" aria-label="' + H.escapeHtml(label) + '" style="width:100%;aspect-ratio:16/9;background:var(--bg-void);border-radius:6px;"></canvas>' +
      '<figcaption style="font-size:11px;color:var(--text-muted);">' + esc(label) + (f && f.error ? ' · <span style="color:var(--status-critical);">' + esc(f.error) + '</span>' : '') + '</figcaption></figure>';
  }
  function grid(cells) { return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:12px;">' + cells.join('') + '</div>'; }

  // ---- map ----------------------------------------------------------------------------------------------------------
  function xy(lat, lon) { return [((Number(lon) + 180) / 360 * 720).toFixed(1), ((90 - Number(lat)) / 180 * 360).toFixed(1)]; }
  function results(id) { var r = md.feeds[id]; return r && r.ok ? r.data.results : []; }
  function dots(id, color, r, title) { var s = ''; results(id).forEach(function (res) { res.items.forEach(function (x) { if (x.lat === null || x.lat === undefined) return; var p = xy(x.lat, x.lon); s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (typeof r === 'function' ? r(x) : r) + '" fill="' + color + '" fill-opacity="0.7"><title>' + esc(title(x)) + '</title></circle>'; }); }); return s; }
  function renderMap(st) {
    var g = '', lon, lat;
    for (lon = -180; lon <= 180; lon += 30) g += '<line x1="' + xy(0, lon)[0] + '" y1="0" x2="' + xy(0, lon)[0] + '" y2="360" />';
    for (lat = -60; lat <= 60; lat += 30) g += '<line x1="0" y1="' + xy(lat, 0)[1] + '" x2="720" y2="' + xy(lat, 0)[1] + '" />';
    var pts = '';
    st.areas.forEach(function (a) { var p = xy(a.lat, a.lon), r = Math.max(2, a.radiusKm / 111 * 2); pts += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + r.toFixed(1) + '" fill="none" stroke="var(--damar-gold-bright)" stroke-dasharray="2 2"><title>' + esc(a.name) + '</title></circle>'; });
    pts += dots('earthquakes', 'var(--status-critical)', function (q) { return Math.max(1.2, (q.magnitude || 0) * 0.9).toFixed(1); }, function (q) { return 'M' + q.magnitude + ' ' + q.place; });
    pts += dots('disasters', 'var(--status-warning)', 3, function (e) { return e.alert + ' ' + e.type + ' ' + e.name; });
    pts += dots('cyclones', 'var(--status-warning)', 5, function (c) { return c.name + ' ' + c.classification + ' ' + c.intensityKt + ' kt'; });
    pts += dots('fires', 'var(--status-warning)', 0.8, function () { return 'fire'; });
    pts += dots('launches', 'var(--status-info)', 2.5, function (l) { return l.name + ' · ' + l.location; });
    pts += dots('military', 'var(--damar-accent)', 1.2, function (f) { return (f.callsign || f.hex) + ' ' + (f.type || ''); });
    ['flights', 'opensky'].forEach(function (id) { pts += dots(id, 'var(--status-success)', 0.9, function (f) { return f.callsign || f.hex || 'aircraft'; }); });
    pts += dots('vessels', 'var(--status-info)', 0.9, function (v) { return v.name || 'vessel'; });
    return '<svg viewBox="0 0 720 360" role="img" aria-label="World plot" style="width:100%;height:auto;background:var(--bg-void);border-radius:8px;"><g stroke="var(--border-subtle)" stroke-width="0.5">' + g + '</g>' + pts + '</svg>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);margin-top:8px;"><span style="color:var(--status-critical);">● quakes</span><span style="color:var(--status-warning);">● cyclones / fires</span><span style="color:var(--status-info);">● launches / vessels</span><span style="color:var(--status-success);">• aircraft</span><span style="color:var(--damar-accent);">• military</span><span>' + esc(T('noBasemap')) + '</span></div>';
  }

  // ---- feed panels --------------------------------------------------------------------------------------------------
  function feedBadge(id) {
    var r = md.feeds[id];
    if (!r) return H.statusBadgeHtml('PENDING', '…');
    if (!r.ok) return H.statusBadgeHtml('ERROR', 'Core ' + r.status + ' · ' + r.error);
    var s = r.data.results.map(function (x) { return x.state; });
    return s.indexOf('ERROR') >= 0 ? H.statusBadgeHtml('ERROR', 'upstream') : s.indexOf('STALE') >= 0 ? H.statusBadgeHtml('WARN', 'stale') : H.statusBadgeHtml('OK', 'live');
  }
  function note(res) {
    return '<div style="font-size:11px;color:var(--text-muted);padding:6px 12px;">' + (res.area ? esc(res.area.name) + ' · ' : '') + (res.fetchedAt ? esc(new Date(res.fetchedAt).toLocaleString()) : '—') +
      (res.error ? ' · <span style="color:var(--status-critical);">' + esc(res.error) + '</span>' : '') + (res.withheld ? ' · ' + res.withheld + ' withheld (LADD/PIA)' : '') + (res.anonymous ? ' · ' + res.anonymous + ' anonymous' : '') + '</div>';
  }
  function aircraftTable(res) { return '<div style="font-size:12px;padding:8px 12px;">' + res.count + ' aircraft</div>' + H.table(['Callsign', 'Hex', 'Reg', 'Type', 'Alt ft', 'GS kt', 'Trk'], res.items.slice(0, 15).map(function (f) { return [H.mono(f.callsign || '—'), H.mono(f.hex || '—'), esc(f.registration), esc(f.type) + (f.military ? ' ' + H.statusBadgeHtml('WARN', 'MIL') : ''), fmt(f.altitudeFt), fmt(f.groundSpeedKt), fmt(f.trackDeg, '°')]; }), '—'); }
  var BODIES = {
    earthquakes: function (res) { return H.table(['Mag', 'Place', 'Depth', 'Time'], res.items.slice(0, 12).map(function (q) { return [H.mono(fmt(q.magnitude)), esc(q.place), fmt(q.depthKm, ' km'), esc(new Date(q.time).toLocaleString())]; }), '—'); },
    cyclones: function (res) { return H.table(['Storm', 'Class', 'Wind kt', 'Pressure', 'Moving', 'Updated'], res.items.map(function (c) { return [esc(c.name), esc(c.classification), fmt(c.intensityKt), fmt(c.pressureMb, ' mb'), fmt(c.movementDir, '°') + ' ' + fmt(c.movementKt, ' kt'), esc(c.updated)]; }), 'No active storms.'); },
    weather: function (res) { var w = res.items[0]; return w ? H.kvList([H.kv('Temperature', fmt(w.temperatureC, ' °C')), H.kv('Sky', fmt(w.symbol)), H.kv('Humidity', fmt(w.humidityPct, ' %')), H.kv('Precipitation (1 h)', fmt(w.precipitationMm, ' mm')), H.kv('Cloud cover', fmt(w.cloudCoverPct, ' %')), H.kv('Wind', fmt(w.windKmh, ' km/h') + ' · ' + fmt(w.windDirDeg, '°'))]) : '—'; },
    disasters: function (res) { return H.table(['Alert', 'Type', 'Event', 'Country', 'Severity', 'From'], res.items.slice(0, 15).map(function (e) { return [H.statusBadgeHtml(e.alert === 'Red' ? 'ERROR' : e.alert === 'Orange' ? 'WARN' : 'OK', e.alert), esc(e.type), esc(e.name), esc(e.country), esc(e.severity), esc(e.from)]; }), '—'); },
    openaq: function (res) { var s = res.items[0]; return s ? '<div style="font-size:12px;padding:8px 12px;">' + esc(s.station) + ' · ' + esc(s.locality) + '</div>' + H.table(['Parameter', 'Value', 'Time'], s.readings.map(function (r) { return [esc(r.parameter), fmt(r.value, ' ' + (r.units || '')), esc(r.time)]; }), '—') : '—'; },
    openMeteo: function (res) { var w = res.items[0]; return w ? H.kvList([H.kv('Temperature', fmt(w.temperatureC, ' °C') + ' (feels ' + fmt(w.apparentC, ' °C') + ')'), H.kv('Precipitation', fmt(w.precipitationMm, ' mm')), H.kv('Cloud cover', fmt(w.cloudCoverPct, ' %')), H.kv('Wind', fmt(w.windKmh, ' km/h') + ' · ' + fmt(w.windDirDeg, '°'))]) : '—'; },
    airQuality: function (res) { var a = res.items[0]; return a ? H.kvList([H.kv('European AQI', fmt(a.europeanAqi)), H.kv('US AQI', fmt(a.usAqi)), H.kv('PM2.5', fmt(a.pm25, ' µg/m³')), H.kv('PM10', fmt(a.pm10, ' µg/m³'))]) : '—'; },
    flights: aircraftTable, opensky: aircraftTable, military: aircraftTable,
    vessels: function (res) { return '<div style="font-size:12px;padding:8px 12px;">' + res.count + ' vessels</div>' + H.table(['Name', 'MMSI', 'IMO', 'Type', 'Speed', 'Dest.'], res.items.slice(0, 15).map(function (v) { return [esc(v.name || 'anonymous'), H.mono(v.mmsi || '—'), H.mono(v.imo || '—'), fmt(v.shipType), fmt(v.speedKt, ' kt'), esc(v.destination)]; }), '—'); },
    fires: function (res) { return '<div style="font-size:12px;padding:8px 12px;">' + res.count + ' detections</div>' + H.table(['Lat', 'Lon', 'Acquired', 'FRP MW', 'Conf.'], res.items.slice(0, 12).map(function (f) { return [fmt(f.lat), fmt(f.lon), esc(f.acquired), fmt(f.frpMw), esc(f.confidence)]; }), '—'); },
    traffic: function (res) { var t = res.items[0]; return t ? H.kvList([H.kv('Current speed', fmt(t.currentKmh, ' km/h')), H.kv('Free-flow speed', fmt(t.freeFlowKmh, ' km/h')), H.kv('Congestion', fmt(t.congestionPct, ' %')), H.kv('Road closed', t.closed ? 'yes' : 'no')]) : '—'; },
    satellites: function (res) { return H.table(['Name', 'NORAD', 'Incl.', 'Period', 'Perigee–Apogee'], res.items.slice(0, 15).map(function (s) { return [esc(s.name), H.mono(s.noradId), fmt(s.inclinationDeg, '°'), fmt(s.periodMin, ' min'), s.perigeeKm + '–' + s.apogeeKm + ' km']; }), '—'); },
    launches: function (res) { return H.table(['NET', 'Mission', 'Provider', 'Status', 'Pad'], res.items.map(function (l) { return [esc(new Date(l.net).toLocaleString()), esc(l.name), esc(l.provider), esc(l.status), esc(l.location)]; }), '—'); }
  };
  function keyForm(f) {
    var inputs = f.credential.fields.map(function (k) { return '<input class="input-field" type="password" autocomplete="off" data-md-key="' + f.id + '" data-k="' + k + '" placeholder="' + k + '" style="width:200px;font-family:var(--font-mono);" />'; }).join(' ');
    return '<div style="display:flex;flex-direction:column;gap:8px;padding:12px;font-size:12px;">' +
      (f.credential.hasKey ? '<div>' + H.statusBadgeHtml('OK', T('keyStored')) + ' ' + H.btn(T('forgetKey'), 'data-md-action="forget-key" data-feed="' + f.id + '"') + '</div>'
        : '<div><strong>' + esc(T('addKey')) + '</strong> · ' + esc(T('getKey')) + ': ' + H.mono(f.credential.signupUrl) + '</div><div style="display:flex;gap:8px;flex-wrap:wrap;">' + inputs + H.btn(T('saveKey'), 'data-md-action="save-key" data-feed="' + f.id + '"', 'btn-primary') + '</div>') + '</div>';
  }
  function feedPanel(f) {
    var r = md.feeds[f.id], body;
    if (f.credential !== 'none' && !f.credential.hasKey) return H.panel(f.label, keyForm(f) + src(f), { span: 6, flush: true, badge: H.statusBadgeHtml('NOT_CONFIGURED', T('addKey')) });
    if (!r) body = '<div style="padding:14px;color:var(--text-muted);font-size:12px;">' + esc(T('loading')) + '</div>';
    else if (!r.ok) body = '<div style="padding:14px;font-size:12px;">' + esc(r.error) + '</div>';
    else body = r.data.results.map(function (res) { return note(res) + (res.items.length ? BODIES[f.id](res) : ''); }).join('');
    return H.panel(f.label, body + (f.credential !== 'none' ? keyForm(f) : '') + src(f), { span: f.perArea ? 6 : 12, flush: true, badge: feedBadge(f.id) });
  }
  function src(f) { return '<div style="font-size:10.5px;color:var(--text-muted);padding:6px 12px;">' + esc(f.attribution) + ' · ' + esc(f.license) + '</div>'; }

  // ---- settings draft -----------------------------------------------------------------------------------------------
  function draftFrom(st) {
    var refresh = {}; st.feeds.forEach(function (f) { refresh[f.id] = f.refreshSec; });
    return { feeds: st.feeds.filter(function (f) { return f.enabled; }).map(function (f) { return f.id; }), areas: st.areas.map(function (a) { return { id: a.id, name: a.name, lat: a.lat, lon: a.lon, radiusKm: a.radiusKm }; }),
      refreshSec: refresh, satelliteGroup: st.satelliteGroup, contactUrl: st.contactUrl || '', cctvSources: st.cctv.sources.slice(), alprRetentionDays: st.alpr.retentionDays, alprIntervalSec: st.alpr.intervalSec };
  }
  function input(attrs, value, width) { return '<input class="input-field" ' + attrs + ' value="' + H.escapeHtml(value) + '" style="width:' + (width || '100%') + ';font-family:var(--font-mono);" />'; }
  function settingsPanel(st) {
    var d = md.draft || (md.draft = draftFrom(st));
    var rows = st.feeds.map(function (f) {
      return ['<label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" data-md-feed="' + f.id + '"' + (d.feeds.indexOf(f.id) >= 0 ? ' checked' : '') + ' /> ' + esc(f.label) + '</label>',
        H.mono(f.host), input('type="number" data-md-refresh="' + f.id + '" min="' + f.minRefreshSec + '" max="86400"', d.refreshSec[f.id], '100px'), esc(f.limits)];
    });
    var areas = d.areas.map(function (a, i) {
      return [input('data-md-area="' + i + '" data-k="name" maxlength="40"', a.name), input('type="number" step="0.0001" data-md-area="' + i + '" data-k="lat"', a.lat, '110px'),
        input('type="number" step="0.0001" data-md-area="' + i + '" data-k="lon"', a.lon, '110px'), input('type="number" data-md-area="' + i + '" data-k="radiusKm" min="5" max="460"', a.radiusKm, '90px'),
        H.btn(T('remove'), 'data-md-action="remove-area" data-i="' + i + '"')];
    });
    var groups = ['stations', 'visual', 'weather', 'gps-ops', 'science', 'geo'].map(function (g) { return '<option' + (g === d.satelliteGroup ? ' selected' : '') + '>' + g + '</option>'; }).join('');
    var srcs = st.cctv.available.map(function (s) { return '<label style="display:flex;gap:8px;align-items:center;font-size:12px;"><input type="checkbox" data-md-cctv="' + s.id + '"' + (d.cctvSources.indexOf(s.id) >= 0 ? ' checked' : '') + ' /> ' + esc(s.label) + ' — ' + esc(s.license) + '</label>'; }).join('');
    return H.panel(T('feedsRefresh'), H.table(['Feed', 'Host', 'Refresh (s)', 'Limits'], rows), { span: 12, flush: true }) +
      H.panel(T('areas'), H.table(['Name', 'Lat', 'Lon', 'Radius km', ''], areas, '—') +
        '<div style="display:flex;flex-direction:column;gap:8px;padding:10px 12px;"><div style="font-size:12px;font-weight:600;">' + esc(T('sources')) + '</div>' + srcs +
        '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px;">' + (d.areas.length < 4 ? H.btn(T('addArea'), 'data-md-action="add-area"') : '') +
        '<label>' + esc(T('group')) + ' <select class="input-field" data-md-group style="width:auto;">' + groups + '</select></label>' +
        '<label>' + esc(T('contact')) + ' ' + input('data-md-text="contactUrl" placeholder="https://… or mailto:…" maxlength="200"', d.contactUrl, '240px') + '</label>' +
        '<label>' + esc(T('retention')) + ' ' + input('type="number" min="1" max="365" data-md-num="alprRetentionDays"', d.alprRetentionDays, '80px') + '</label>' +
        '<label>' + esc(T('interval')) + ' ' + input('type="number" min="5" max="3600" data-md-num="alprIntervalSec"', d.alprIntervalSec, '80px') + '</label>' +
        '<span style="flex:1"></span>' + H.btn(T('discard'), 'data-md-action="discard"') + H.btn(md.saving ? T('saving') : T('save'), 'data-md-action="save"', 'btn-primary') + '</div>' +
        (md.message ? '<div style="font-size:12px;color:var(--text-secondary);">' + esc(md.message) + '</div>' : '') + '</div>', { span: 12, flush: true });
  }

  // ---- cameras & ALPR -------------------------------------------------------------------------------------------------
  function noticePanel(title, text, action) { return H.panel(title, '<div style="display:flex;flex-direction:column;gap:10px;font-size:12.5px;color:var(--text-secondary);"><div>' + esc(text) + '</div><div style="display:flex;justify-content:flex-end;">' + H.btn(T('accept'), 'data-md-action="' + action + '"', 'btn-primary') + '</div></div>', { span: 12, badge: H.statusBadgeHtml('INFO', 'once') }); }
  function camerasSection(st) {
    var html = '';
    st.cctv.sources.forEach(function (s) {
      var r = md.cams[s], body;
      if (!r) body = '<div style="padding:14px;font-size:12px;color:var(--text-muted);">' + esc(T('loading')) + '</div>';
      else if (!r.ok) body = '<div style="padding:14px;font-size:12px;">' + esc(r.error) + '</div>';
      else {
        var d = r.data;
        body = '<div style="padding:10px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><input class="input-field" data-md-filter placeholder="' + H.escapeHtml(T('filter')) + '" value="' + H.escapeHtml(md.filter) + '" style="width:260px;" />' + H.btn(T('search'), 'data-md-action="cam-search"') +
          ' <span style="font-size:11px;color:var(--text-muted);">' + d.total + ' · ' + d.page + '/' + d.pages + '</span>' + (d.page > 1 ? H.btn('‹', 'data-md-action="cam-page" data-src="' + s + '" data-page="' + (d.page - 1) + '"') : '') + (d.page < d.pages ? H.btn('›', 'data-md-action="cam-page" data-src="' + s + '" data-page="' + (d.page + 1) + '"') : '') + '</div>' +
          grid(d.cameras.map(function (c) { return canvas('pub|' + s + '|' + c.id, c.name); })) + '<div style="font-size:10.5px;color:var(--text-muted);padding:6px 12px;">' + esc(r.data.attribution) + ' · ' + esc(r.data.license) + '</div>';
      }
      html += H.panel(T('publicCams') + ' · ' + s, body, { span: 12, flush: true });
    });
    if (!owner()) return html;
    if (!st.cctv.noticeAt) return html + noticePanel(T('cctvNotice'), st.notice.cctv, 'accept-cctv');
    var cf = md.camForm;
    var form = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px;font-size:12px;">' +
      input('data-md-cam="name" placeholder="Name" maxlength="40"', cf.name || '', '140px') +
      '<select class="input-field" data-md-cam="kind" style="width:auto;">' + ['snapshot', 'mjpeg', 'rtsp'].map(function (k) { return '<option' + (k === cf.kind ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>' +
      input('data-md-cam="url" placeholder="http://192.168.1.20/snapshot.jpg or rtsp://…" maxlength="400"', cf.url || '', '320px') +
      '<input class="input-field" data-md-cam="username" autocomplete="off" placeholder="username" style="width:120px;" />' +
      '<input class="input-field" type="password" data-md-cam="password" autocomplete="off" placeholder="password" style="width:120px;" />' +
      (st.alpr.noticeAt ? '<label><input type="checkbox" data-md-cam-alpr' + (cf.alpr ? ' checked' : '') + ' /> ALPR</label>' : '') +
      H.btn(T('addCamera'), 'data-md-action="add-camera"', 'btn-primary') + '</div>' + (st.cctv.ffmpeg ? '' : '<div style="font-size:11px;color:var(--text-muted);padding:0 12px 8px;">' + esc(T('ffmpegMissing')) + '</div>');
    html += H.panel(T('ownCams'), grid(md.own.map(function (c) {
      return '<div>' + canvas('own|' + c.id, c.name + ' · ' + c.kind + (c.alpr ? ' · ALPR' : '')) + '<div style="display:flex;gap:6px;margin-top:4px;">' +
        (st.alpr.noticeAt ? H.btn(c.alpr ? 'ALPR off' : 'ALPR on', 'data-md-action="toggle-alpr" data-id="' + c.id + '" data-on="' + (!c.alpr) + '"') : '') + H.btn(T('remove'), 'data-md-action="remove-camera" data-id="' + c.id + '"') + '</div></div>';
    })) + form, { span: 12, flush: true });
    return html + alprSection(st);
  }
  function alprSection(st) {
    if (!st.alpr.noticeAt) return noticePanel(T('alprNotice'), st.notice.alpr, 'accept-alpr');
    var a = md.alpr, s = st.alpr, html = '';
    var head = '<div style="font-size:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;"><div>' + esc(T('alprOnly')) + ' ' + esc(s.engine || '') + ' · ' + s.enabledCameras + ' cameras · ' + s.entries + ' entries · retention ' + s.retentionDays + ' d' + (s.lastError ? ' · <span style="color:var(--status-critical);">' + esc(s.lastError) + '</span>' : '') + '</div>' +
      (s.engineState && !s.engineState.installed ? '<div style="color:var(--status-warning);">' + esc(T('engineMissing')) + ' ' + esc(T('installHosts')) + ' ' + (s.installHosts || []).map(function (h) { return H.mono(h); }).join(' · ') +
        (s.engineState.error ? ' · ' + esc(s.engineState.error) : '') + '</div><div>' + (s.engineState.installing ? H.statusBadgeHtml('RUNNING', T('installing')) : H.btn(T('installEngine'), 'data-md-action="install-engine"', 'btn-primary')) + '</div>' : '') + '</div>';
    var alerts = a ? H.table(['Time', 'Plate', 'Camera', 'Note', ''], a.alerts.slice(0, 20).map(function (x) { return [esc(new Date(x.t).toLocaleString()), H.mono(x.plate), esc(x.cameraName), esc(x.note), x.acknowledged ? '' : H.statusBadgeHtml('WARN', 'new')]; }), '—') : '';
    var logT = a ? H.table(['Time', 'Plate', 'Camera', 'Conf.', 'Crop', ''], a.entries.slice(0, 30).map(function (e) { return [esc(new Date(e.t).toLocaleString()), H.mono(e.plate), esc(e.cameraName), fmt(e.confidence), e.crop ? '<div style="width:120px;">' + canvas('crop|' + e.id, e.plate) + '</div>' : '—', H.btn(T('remove'), 'data-md-action="alpr-delete" data-id="' + e.id + '"')]; }), '—') : '';
    var wl = a ? H.table(['Plate', 'Note', ''], a.watchlist.map(function (w) { return [H.mono(w.plate), esc(w.note), H.btn(T('remove'), 'data-md-action="wl-remove" data-plate="' + H.escapeHtml(w.plate) + '"')]; }), '—') +
      '<div style="display:flex;gap:8px;padding:10px 12px;"><input class="input-field" data-md-wl="plate" placeholder="B1234XYZ" maxlength="16" style="width:140px;font-family:var(--font-mono);" /><input class="input-field" data-md-wl="note" placeholder="note" maxlength="80" style="width:200px;" />' + H.btn('+', 'data-md-action="wl-add"', 'btn-primary') + '</div>' : '';
    html += H.panel(T('alpr'), head + '<div style="display:flex;gap:8px;padding:0 12px 10px;">' + H.btn(T('ack'), 'data-md-action="alpr-ack"') + H.btn(T('export'), 'data-md-action="alpr-export"') + H.btn(T('deleteAll'), 'data-md-action="alpr-delete-all"') + '</div>', { span: 12, flush: true, badge: s.unacknowledgedAlerts ? H.statusBadgeHtml('WARN', s.unacknowledgedAlerts + ' alerts') : '' });
    html += H.panel(T('alerts'), alerts, { span: 6, flush: true }) + H.panel(T('watchlist'), wl, { span: 6, flush: true }) + H.panel(T('log'), logT, { span: 12, flush: true });
    return html;
  }

  // ---- Owner actions ------------------------------------------------------------------------------------------------
  function after(r, okText) { md.message = r.ok ? okText : 'Core ' + r.status + ' · ' + r.error; md.lastLoad = 0; H.refresh(); return r; }
  function saveSettings(values) {
    md.saving = true; md.message = ''; H.refresh();
    var c = H.state().control;
    return H.controlSession().then(function (id) { return H.post('/api/r9/settings', { action: 'update', cliSession: id, client: c.client, values: { mataDewa: values } }); })
      .then(function (r) { md.saving = false; if (r.ok) { md.draft = null; md.feeds = {}; md.cams = {}; } after(r, 'Saved (revision ' + (r.data && r.data.revision) + ').'); },
        function (r) { md.saving = false; md.message = 'Control session failed: ' + ((r && r.error) || 'unknown'); H.refresh(); });
  }
  function val(sel) { var el = document.querySelector(sel); return el ? el.value : ''; }
  var ACTIONS = {
    'consent-on': function () { saveSettings({ consent: true }); }, 'consent-off': function () { saveSettings({ consent: false }); },
    'accept-cctv': function () { saveSettings({ cctvNoticeAt: new Date().toISOString() }); }, 'accept-alpr': function () { saveSettings({ alprNoticeAt: new Date().toISOString() }); },
    'save-key': function (b) { var f = b.getAttribute('data-feed'), body = {};
      Array.prototype.forEach.call(document.querySelectorAll('[data-md-key="' + f + '"]'), function (el) { body[el.getAttribute('data-k')] = el.value; el.value = ''; });
      H.post('/api/r9/mata-dewa/keys/' + f, body).then(function (r) { delete md.feeds[f]; after(r, T('keyStored')); }); },
    'forget-key': function (b) { var f = b.getAttribute('data-feed'); H.post('/api/r9/mata-dewa/keys/' + f, { forget: true }).then(function (r) { delete md.feeds[f]; after(r, 'OK'); }); },
    'add-camera': function () { var cf = md.camForm, body = { action: 'add', name: val('[data-md-cam="name"]'), kind: cf.kind, url: val('[data-md-cam="url"]'), alpr: !!cf.alpr }, u = val('[data-md-cam="username"]');
      if (u) { body.username = u; body.password = val('[data-md-cam="password"]'); }
      H.post('/api/r9/mata-dewa/cameras', body).then(function (r) { if (r.ok) md.camForm = { kind: 'snapshot' }; after(r, 'Camera added.'); }); },
    'remove-camera': function (b) { H.post('/api/r9/mata-dewa/cameras', { action: 'remove', id: b.getAttribute('data-id') }).then(function (r) { after(r, 'Camera removed.'); }); },
    'toggle-alpr': function (b) { H.post('/api/r9/mata-dewa/cameras', { action: 'update', id: b.getAttribute('data-id'), alpr: b.getAttribute('data-on') === 'true' }).then(function (r) { after(r, 'OK'); }); },
    'wl-add': function () { H.post('/api/r9/mata-dewa/alpr', { action: 'watchlist-add', plate: val('[data-md-wl="plate"]'), note: val('[data-md-wl="note"]') }).then(function (r) { after(r, 'OK'); }); },
    'wl-remove': function (b) { H.post('/api/r9/mata-dewa/alpr', { action: 'watchlist-remove', plate: b.getAttribute('data-plate') }).then(function (r) { after(r, 'OK'); }); },
    'install-engine': function () { if (root.confirm && !root.confirm(T('installEngine') + '?')) return; H.post('/api/r9/mata-dewa/alpr', { action: 'install-engine' }).then(function (r) { after(r, T('installing')); }); },
    'cam-search': function () { md.camPage = {}; md.cams = {}; md.lastLoad = 0; H.refresh(); },
    'cam-page': function (b) { md.camPage[b.getAttribute('data-src')] = +b.getAttribute('data-page'); loadCams(b.getAttribute('data-src')).then(H.refresh); },
    'alpr-ack': function () { H.post('/api/r9/mata-dewa/alpr', { action: 'ack-alerts' }).then(function (r) { after(r, 'OK'); }); },
    'alpr-delete': function (b) { H.post('/api/r9/mata-dewa/alpr', { action: 'delete', id: b.getAttribute('data-id') }).then(function (r) { after(r, 'OK'); }); },
    'alpr-delete-all': function () { if (root.confirm && !root.confirm(T('deleteAll') + '?')) return; H.post('/api/r9/mata-dewa/alpr', { action: 'delete-all' }).then(function (r) { after(r, 'OK'); }); },
    'alpr-export': function () { H.get('/api/r9/mata-dewa/alpr/export').then(function (r) { if (!r.ok) return after(r, '');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 1)], { type: 'application/json' })); a.download = 'damar-alpr-export.json'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }); },
    'add-area': function () { var d = md.draft; if (!d || d.areas.length >= 4) return; var n = 1; while (d.areas.some(function (a) { return a.id === 'area-' + n; })) n++; d.areas.push({ id: 'area-' + n, name: 'Area ' + n, lat: 0, lon: 0, radiusKm: 100 }); H.refresh(); },
    'remove-area': function (b) { if (md.draft) { md.draft.areas.splice(+b.getAttribute('data-i'), 1); H.refresh(); } },
    'discard': function () { md.draft = null; md.message = ''; H.refresh(); },
    'save': function () { if (md.draft) saveSettings(md.draft); }
  };

  function render(helpers) {
    H = helpers;
    if (Date.now() - md.lastLoad > 15000) load();
    if (typeof setTimeout === 'function') setTimeout(drawFrames, 0);
    var head = H.pageHeader('DAMAR INTELLIGENCE • MATA DEWA', 'Mata Dewa', T('subtitle'));
    if (!md.status) return head + H.panel('Mata Dewa', md.statusError ? H.statusBadgeHtml('UNAVAILABLE', 'Core ' + md.statusError.status + ' · ' + md.statusError.error) : '<div style="font-size:12px;color:var(--text-muted);">' + esc(T('loading')) + '</div>', { span: 12 });
    var st = md.status, html = head;
    html += H.panel(T('consentTitle'), '<div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px;color:var(--text-secondary);">' +
      '<div>' + esc(st.notice.consent) + '</div><div>' + esc(T('hosts')) + ': ' + st.egressHosts.map(function (h) { return H.mono(h); }).join(' · ') + '</div>' +
      '<div>' + esc(st.notice.privacy) + '</div><div style="color:var(--text-muted);">' + esc(st.notice.accuracy) + '</div>' +
      '<div style="display:flex;justify-content:flex-end;">' + (st.consent ? H.btn(T('consentOff'), 'data-md-action="consent-off"') : H.btn(T('consentOn'), 'data-md-action="consent-on"', 'btn-primary')) + '</div></div>',
      { span: 12, badge: H.statusBadgeHtml(st.consent ? 'ACTIVE' : 'DISABLED', st.consent ? T('given') : T('none')) });
    var on = st.feeds.filter(function (f) { return f.enabled; }).sort(function (a, b) { return FEED_ORDER.indexOf(a.id) - FEED_ORDER.indexOf(b.id); });
    html += '<div class="workspace-grid-12">';
    if (st.consent) {
      html += H.panel(T('plot'), renderMap(st), { span: 12 });
      on.forEach(function (f) { html += feedPanel(f); });
      if (!on.length) html += H.panel('Feeds', '<div style="font-size:12px;color:var(--text-muted);">' + esc(T('disabledAll')) + '</div>', { span: 12 });
    }
    html += camerasSection(st);
    html += H.panel(T('attribution'), H.table(['Feed', 'Source', 'Licence / terms', T('commercial')], st.feeds.map(function (f) { return [esc(f.label), esc(f.attribution), esc(f.license), esc(f.commercial)]; })
      .concat(st.cctv.available.map(function (s) { return [esc(s.label), esc(s.attribution), esc(s.license), 'see terms']; }))) +
      '<div style="font-size:10.5px;color:var(--text-muted);padding:6px 12px;">Capabilities adapted from God\'s Eye View by Bilawal Sidhu (MIT).</div>', { span: 12, flush: true });
    if (owner()) html += settingsPanel(st);
    return html + '</div>';
  }

  // Delegated events (Control re-renders every 5 s; drafts survive in md.draft / md.camForm / md.filter).
  if (typeof document !== 'undefined') {
    document.addEventListener('input', function (e) {
      var t = e.target; if (!t.getAttribute) return;
      if (t.hasAttribute('data-md-filter')) { md.filter = t.value.slice(0, 60); return; }
      if (t.getAttribute('data-md-cam') === 'name' || t.getAttribute('data-md-cam') === 'url') { md.camForm[t.getAttribute('data-md-cam')] = t.value; return; }
      if (!md.draft) return;
      if (t.hasAttribute('data-md-refresh')) md.draft.refreshSec[t.getAttribute('data-md-refresh')] = parseInt(t.value, 10);
      else if (t.hasAttribute('data-md-num')) md.draft[t.getAttribute('data-md-num')] = parseInt(t.value, 10);
      else if (t.hasAttribute('data-md-text')) md.draft[t.getAttribute('data-md-text')] = t.value.trim();
      else if (t.hasAttribute('data-md-area')) { var a = md.draft.areas[+t.getAttribute('data-md-area')], k = t.getAttribute('data-k'); if (a) a[k] = k === 'name' ? t.value : Number(t.value); }
    });
    document.addEventListener('change', function (e) {
      var t = e.target; if (!t.getAttribute) return;
      if (t.getAttribute('data-md-cam') === 'kind') md.camForm.kind = t.value;
      if (t.hasAttribute('data-md-cam-alpr')) md.camForm.alpr = t.checked;
      if (!md.draft) return;
      if (t.hasAttribute('data-md-feed')) { var id = t.getAttribute('data-md-feed'), i = md.draft.feeds.indexOf(id); if (t.checked && i < 0) md.draft.feeds.push(id); if (!t.checked && i >= 0) md.draft.feeds.splice(i, 1); }
      if (t.hasAttribute('data-md-cctv')) { var s = t.getAttribute('data-md-cctv'), j = md.draft.cctvSources.indexOf(s); if (t.checked && j < 0) md.draft.cctvSources.push(s); if (!t.checked && j >= 0) md.draft.cctvSources.splice(j, 1); }
      if (t.hasAttribute('data-md-group')) md.draft.satelliteGroup = t.value;
    });
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-md-action]'); if (!b || !H) return;
      var fn = ACTIONS[b.getAttribute('data-md-action')]; if (fn) fn(b);
    });
  }

  var def = { label: 'Mata Dewa', render: render };
  if (root.DamarControl && root.DamarControl.registerView) root.DamarControl.registerView('matadewa', def);
  if (typeof module !== 'undefined' && module.exports) module.exports = { def: def, state: md, STR: STR };
})(typeof window !== 'undefined' ? window : globalThis);
