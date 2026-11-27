// DAMAR Control, Produktivitas (MCP) view. Connect cards for the
// productivity MCP suite (src/mcp/productivity): one-click OAuth connect
// per service, per-service toggles, filesystem folder grants and the
// Blender bridge target. All state lives in Core; this view only calls
// /api/v1/console/mcp/productivity/*. Client secrets are write-only:
// they are sent to Core once and stored in the secret vault, never read
// back. Tokens never appear here, Core reports connection metadata
// only.
(function (root) {
  'use strict';
  var mp = { data: null, error: null, loading: false, lastLoad: 0, message: '', health: {} };
  var H = null;

  function esc(v) { return H.escapeHtml(v == null ? '' : v); }
  function load() {
    if (mp.loading || !H) return;
    mp.loading = true;
    H.get('/api/v1/console/mcp/productivity').then(function (r) {
      mp.loading = false;
      if (r.ok) { mp.data = r.data; mp.error = null; mp.lastLoad = Date.now(); }
      else mp.error = r;
      H.refresh();
    }, function () { mp.loading = false; });
  }
  function after(r, okText) {
    mp.message = r && r.ok ? okText : 'Core ' + (r ? r.status : '?') + ' · ' + (r ? r.error : 'NO_RESPONSE');
    mp.lastLoad = 0;
    if (H) H.refresh();
    return r;
  }
  function val(sel) { var el = document.querySelector(sel); return el ? el.value : ''; }

  var ACTIONS = {
    'save-client': function (b) {
      var id = b.getAttribute('data-id');
      var body = { clientId: val('[data-mp-client-id="' + id + '"]'), clientSecret: val('[data-mp-client-secret="' + id + '"]') };
      var sec = document.querySelector('[data-mp-client-secret="' + id + '"]'); if (sec) sec.value = '';
      H.post('/api/v1/console/mcp/productivity/client/' + id, body).then(function (r) { after(r, 'Client tersimpan di vault.'); });
    },
    'forget-client': function (b) {
      var id = b.getAttribute('data-id');
      if (root.confirm && !root.confirm('Hapus client OAuth ' + id + ' dari vault?')) return;
      H.post('/api/v1/console/mcp/productivity/client/' + id, { forget: true }).then(function (r) { after(r, 'Client dihapus.'); });
    },
    'connect': function (b) {
      var id = b.getAttribute('data-id');
      H.post('/api/v1/console/mcp/productivity/connect/' + id, {}).then(function (r) {
        if (r && r.ok && r.data && r.data.authorizeUrl) {
          root.open(r.data.authorizeUrl, '_blank');
          mp.message = 'Selesaikan persetujuan di browser, lalu kembali ke Dashboard.';
          mp.lastLoad = 0;
        } else after(r, '');
        if (H) H.refresh();
      });
    },
    'disconnect': function (b) {
      var id = b.getAttribute('data-id');
      if (root.confirm && !root.confirm('Putuskan koneksi ' + id + '? Token akan dicabut/dihapus.')) return;
      H.post('/api/v1/console/mcp/productivity/disconnect/' + id, {}).then(function (r) { after(r, 'Koneksi diputus.'); });
    },
    'health': function (b) {
      var id = b.getAttribute('data-id');
      H.get('/api/v1/console/mcp/productivity/health/' + id).then(function (r) {
        mp.health[id] = r && r.ok ? r.data : { ok: false, error: r ? r.error : 'NO_RESPONSE' };
        if (H) H.refresh();
      });
    },
    'save-grants': function () {
      var text = val('[data-mp-grants]');
      var grants = text.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      H.post('/api/v1/console/mcp/productivity/filesystem/grants', { grants: grants }).then(function (r) { after(r, 'Folder izin disimpan.'); });
    },
    'save-blender': function () {
      var body = { host: val('[data-mp-blender-host]') || undefined, port: Number(val('[data-mp-blender-port]')) || undefined };
      H.post('/api/v1/console/mcp/productivity/blender/target', body).then(function (r) { after(r, 'Target Blender disimpan.'); });
    },
    'seed': function () {
      H.post('/api/v1/console/mcp/productivity/seed', {}).then(function (r) { after(r, 'Server MCP terdaftar di configs/mcp.json, muat ulang Core agar tool tampil.'); });
    }
  };

  function stateBadge(s) {
    if (s.authType === 'oauth2') {
      if (s.connected) return H.statusBadgeHtml('CONNECTED', s.account && s.account.label ? s.account.label : 'terhubung');
      if (s.clientConfigured) return H.statusBadgeHtml('READY', 'client tersimpan, siap connect');
      return H.statusBadgeHtml('NOT CONFIGURED', 'client OAuth belum diatur');
    }
    if (s.id === 'filesystem') return H.statusBadgeHtml(s.grants && s.grants.length ? 'ACTIVE' : 'IDLE', s.grants && s.grants.length ? s.grants.length + ' folder diizinkan' : 'belum ada folder izin');
    if (s.id === 'blender') return H.statusBadgeHtml('LOCAL', 'bridge ' + (s.target ? s.target.host + ':' + s.target.port : ''));
    return H.statusBadgeHtml('ACTIVE', 'tanpa login');
  }

  function serverPanel(s) {
    var reads = s.tools.filter(function (t) { return t.tier === 'read'; }).length;
    var writes = s.tools.length - reads;
    var rows = [
      H.kv('Autentikasi', s.authType === 'oauth2' ? 'OAuth 2.0 (satu kali login)' : s.authType === 'local' ? 'Lokal, tanpa login' : 'Tanpa login'),
      H.kv('Tool', s.tools.length + ' (' + reads + ' baca · ' + writes + ' tulis/approval)'),
      H.kv('Status', '')
    ];
    var body = H.kvList(rows.slice(0, 2)) + '<div style="margin:6px 0;">' + stateBadge(s) + '</div>';
    body += '<div style="font-size:11.5px;color:var(--text-secondary);">' + s.tools.map(function (t) { return esc(t.name) + (t.tier === 'write' ? ' †' : ''); }).join(' · ') + '</div>';
    body += '<div style="font-size:10.5px;color:var(--text-muted);margin-top:4px;">† tulis, selalu lewat Authority Gate (approval pemilik).</div>';

    if (s.authType === 'oauth2') {
      if (s.services) {
        body += '<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">' + s.services.map(function (sv) {
          return '<label style="font-size:12px;display:flex;gap:8px;align-items:center;"><input type="checkbox" data-mp-service="' + esc(s.id) + '" data-service="' + esc(sv.id) + '"' + (sv.enabled ? ' checked' : '') + ' /> ' + esc(sv.displayName) + '</label>';
        }).join('') + '</div>';
      }
      if (!s.clientConfigured) {
        body += '<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">' +
          '<input type="text" class="input-field" data-mp-client-id="' + esc(s.id) + '" placeholder="Client ID" autocomplete="off" style="width:100%;font-family:var(--font-mono);" />' +
          '<input type="password" class="input-field" data-mp-client-secret="' + esc(s.id) + '" placeholder="Client secret (tersimpan di vault, tidak ditampilkan lagi)" autocomplete="off" style="width:100%;font-family:var(--font-mono);" />' +
          '<div style="font-size:11px;color:var(--text-muted);">' + esc(s.clientSetupHint || '') + '</div></div>';
      }
      body += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap;">' +
        (!s.clientConfigured ? H.btn('Simpan client ke vault', 'data-mp-action="save-client" data-id="' + esc(s.id) + '"', 'btn-primary') : '') +
        (s.clientConfigured && !s.connected ? H.btn('Connect…', 'data-mp-action="connect" data-id="' + esc(s.id) + '"', 'btn-primary') : '') +
        (s.connected ? H.btn('Putuskan koneksi', 'data-mp-action="disconnect" data-id="' + esc(s.id) + '"') : '') +
        (s.clientConfigured ? H.btn('Hapus client', 'data-mp-action="forget-client" data-id="' + esc(s.id) + '"') : '') +
        '</div>';
    }
    if (s.id === 'filesystem') {
      body += '<div style="margin-top:10px;"><div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:6px;">Folder yang diizinkan (satu per baris). Tool filesystem hanya bisa menyentuh folder ini.</div>' +
        '<textarea class="input-field" data-mp-grants rows="4" style="width:100%;font-family:var(--font-mono);">' + esc((s.grants || []).join('\n')) + '</textarea>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:8px;">' + H.btn('Simpan folder izin', 'data-mp-action="save-grants"', 'btn-primary') + '</div></div>';
    }
    if (s.id === 'blender') {
      var t = s.target || { host: '127.0.0.1', port: 9876 };
      body += '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
        '<input type="text" class="input-field" data-mp-blender-host value="' + esc(t.host) + '" style="width:140px;font-family:var(--font-mono);" />' +
        '<input type="text" class="input-field" data-mp-blender-port value="' + esc(t.port) + '" style="width:80px;font-family:var(--font-mono);" />' +
        H.btn('Simpan target', 'data-mp-action="save-blender"') +
        H.btn('Cek bridge', 'data-mp-action="health" data-id="blender"') + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">Pasang addon tools/blender-mcp/damar_blender_addon.py di Blender, lalu Start Server di panel DAMAR MCP (sidebar 3D View).</div>';
      var hb = mp.health.blender;
      if (hb) body += '<div style="font-size:11.5px;margin-top:6px;">Bridge: ' + (hb.ok ? esc('terhubung, ' + (hb.scene || '') + ', ' + (hb.objects != null ? hb.objects : '?') + ' objek') : esc('tidak terjangkau (' + (hb.error || 'gagal') + ')')) + '</div>';
    }
    if (s.id === 'web') {
      body += '<div style="font-size:11.5px;color:var(--text-secondary);margin-top:8px;">Fetch URL publik menjadi teks terbaca + pencarian web. Target privat/loopback ditolak (anti-SSRF).</div>';
    }
    return H.panel(s.displayName, body, { span: 6, badge: H.statusBadgeHtml(s.authType === 'oauth2' ? 'OAUTH2' : s.authType.toUpperCase()) });
  }

  function render(helpers) {
    H = helpers;
    if (Date.now() - mp.lastLoad > 15000) load();
    var head = H.pageHeader('AI INFRASTRUCTURE • MCP PRODUKTIVITAS', 'Produktivitas (MCP)',
      'Hubungkan layanan produktivitas sekali, setelah itu tool-nya hidup di Damar dan setiap aksi tulis lewat Authority Gate. Damar bersifat lokal: tidak ada server cloud Damar, jadi setiap pengguna memakai client OAuth miliknya sendiri (dibuat sekali di konsol penyedia, ditempel di sini, tersimpan terenkripsi di vault).',
      H.btn('Daftarkan semua server ke MCP', 'data-mp-action="seed"', 'btn-primary'));
    if (mp.message) head += '<div class="panel" style="border-left:3px solid var(--damar-accent);"><div class="panel-body" style="font-size:12.5px;">' + esc(mp.message) + '</div></div>';
    if (!mp.data) return head + H.panel('Produktivitas (MCP)', mp.error ? H.statusBadgeHtml('UNAVAILABLE', 'Core ' + mp.error.status + ' · ' + mp.error.error) : '<div style="font-size:12px;color:var(--text-muted);">Memuat dari Core…</div>', { span: 12 });
    var html = head + '<div class="workspace-grid-12">';
    mp.data.servers.forEach(function (s) { html += serverPanel(s); });
    return html + '</div>';
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-mp-action]'); if (!b || !H) return;
      var fn = ACTIONS[b.getAttribute('data-mp-action')]; if (fn) fn(b);
    });
    document.addEventListener('change', function (e) {
      var t = e.target; if (!t.getAttribute || !H) return;
      var sid = t.getAttribute('data-mp-service'); if (!sid) return;
      var body = {}; body[t.getAttribute('data-service')] = t.checked;
      H.post('/api/v1/console/mcp/productivity/services/' + sid, body).then(function (r) { after(r, 'Layanan diperbarui, scope & tool mengikuti saat connect berikutnya.'); });
    });
  }

  var def = { label: 'Produktivitas (MCP)', group: 'AI Infrastructure', icon: '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>', render: render };
  if (root.DamarControl && root.DamarControl.registerView) root.DamarControl.registerView('mcp-productivity', def);
  if (typeof module !== 'undefined' && module.exports) module.exports = { def: def, state: mp };
})(typeof window !== 'undefined' ? window : globalThis);
