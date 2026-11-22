'use strict';
// Settings Control Center (Owner HTML prototype: six cards). A form model with real controls; every value comes from
// DAMAR Core or the private profile, and every change goes through the same Core routes / appearance handler the typed
// commands use. Controls without a Core contract are shown disabled with the reason (never simulated).
// Draft semantics: edits stay in the draft; Apply sends them (one Owner confirmation for Core changes) and keeps the
// panel open; Save = Apply + persist to the private profile + close; Cancel / Esc discards the draft (nothing sent).
// The API key is held only in this object's memory until Apply, sent once in the Core POST body, then wiped; the view
// carries a mask, never the key.
const { themes } = require('./appearance.cjs');
// Client pre-check of Core's URL policy (Core decides): plain http only to this computer, https to any host, no user:password.
const BASE_URL = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])|https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
const KEY_OK = k => typeof k === 'string' && k.length > 0 && k.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(k);

class SettingsCenter {
  constructor(tui, deps) {
    this.tui = tui; this.deps = deps || {}; this.focus = 0; this.open = null; this.openIndex = 0; this.optionStart = 0; this.errors = {}; this.status = null; this.busy = false;
    this.core = null; this.models = { id: null, list: [], error: null }; this.secret = ''; this.loadError = null; this.baseUrlReplaceOnType = true;
    this.draft = this.appearanceNow();
  }
  t(id, en) { return this.tui.language === 'id' ? id : en; }
  appearanceNow() {
    const tui = this.tui;
    return { theme: tui.theme || 'damar-ember', language: tui.language === 'id' ? 'id' : 'en', flame: tui.bannerMode !== 'static', sidebar: tui.sidebarEnabled !== false, details: !!tui.details, hudPosition: tui.hudPosition || 'left' };
  }
  async load() {
    this.status = this.t('Membaca pengaturan dari Core…', 'Reading settings from Core…'); this.tui.render();
    try {
      if (!this.deps.core) throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');
      this.core = await this.deps.core();
      this.draft.provider = this.core.provider.active; this.draft.model = this.core.provider.model || '';
      this.draft.autonomy = this.core.settings?.autonomy || 'ask';
      this.draft.skillRouting = this.core.settings?.skills?.routing || 'auto';
      this.draft.extraDirsText = (this.core.settings?.extraDirs || []).join(';');
      const firstPlugin = this.core.settings?.plugins?.find(p => p.key);
      this.draft.pluginKey = firstPlugin?.key || null; this.draft.pluginTrusted = !!firstPlugin?.trusted;
      this.draft.baseUrl = this.providerRow(this.draft.provider)?.baseUrl || '';
      await this.loadModels(this.draft.provider);
      this.status = null;
    } catch (error) { this.loadError = code(error); this.status = this.t('Core tidak tersedia: ', 'Core unavailable: ') + this.loadError; }
    this.tui.render();
  }
  providerRow(id) { return this.core?.provider.providers.find(p => p.id === id) || null; }
  async loadModels(id) {
    this.models = { id, list: [], error: null };
    const row = this.providerRow(id);
    if (!row?.configured) { this.models.error = 'PROVIDER_NOT_CONNECTED'; return; }
    try { const m = await this.deps.models(id); if (m.error) this.models.error = m.error.error || 'MODEL_LIST_REJECTED'; else this.models.list = m.models; }
    catch (error) { this.models.error = code(error); }
  }

  // ---- fields (recomputed from live state each time) ----
  fields() {
    const t = this.t.bind(this), d = this.draft, core = this.core, row = this.providerRow(d.provider);
    const providers = core ? core.provider.providers : [];
    const live = row?.kind === 'live';
    const sandbox = core?.sandbox || null, catalogs = this.tui.hud?.catalogs || {};
    const unavailable = (id, card, label, reason) => ({ id, card, kind: 'info', label, value: 'UNAVAILABLE', reason, disabled: true });
    return [
      // 1. Provider & Model
      { id: 'provider', card: 0, kind: 'select', label: 'Provider', value: d.provider, disabled: !core || !providers.length,
        reason: core && !providers.length ? t('Belum ada provider. Hubungkan satu: connect (menampilkan preset), atau DAMAR Control > Providers', 'No provider yet. Connect one: connect (shows presets), or DAMAR Control > Providers') : null,
        options: providers.map(p => ({ value: p.id, label: (p.kind === 'live' && p.label ? p.label + ' [' + p.id + ']' : p.id) + (p.kind !== 'live' ? t('  (offline, siap)', '  (offline, ready)') : p.grantStatus === 'granted' ? t('  (diizinkan)', '  (granted)') : p.grantStatus === 'needs-new-grant' ? t('  (perlu grant baru)', '  (needs a new grant)') : t('  (perlu model grant)', '  (needs a model grant)')) })) },
      { id: 'baseUrl', card: 0, kind: 'text', label: 'Base URL', value: typeof d.baseUrl === 'string' ? d.baseUrl : (row?.baseUrl || ''), placeholder: 'https://<host>/v1', disabled: !core || !live,
        reason: !core || !live ? t('fixture offline: tanpa URL', 'offline fixture: no URL') : t('https ke host mana pun; http hanya untuk komputer ini. Disimpan oleh Core.', 'https to any host; http only for this computer. Saved by Core.') },
      { id: 'apiKey', card: 0, kind: 'secret', label: 'API Key', value: this.secret ? '•'.repeat(Math.min(24, this.secret.length)) : '',
         placeholder: row?.hasKey ? (row.keyRemembered ? t('tersimpan', 'saved') : t('di memori Core', 'in Core memory')) : t('belum ada', 'none'),
        disabled: !core || !live, reason: core && !live ? t('fixture offline tidak memerlukan key', 'offline fixtures need no key') : null },
      { id: 'revokeKey', card: 0, kind: 'button', label: t('Cabut kredensial provider', 'Revoke provider credential'), action: 'revoke', disabled: !core || !live || !row?.hasKey,
        reason: row?.hasKey ? t('menghapus key dari memori Core dan penyimpanan aman', 'removes the key from Core memory and secure storage') : t('tidak ada kredensial tersimpan', 'no credential is configured') },
      { id: 'model', card: 0, kind: 'select', label: t('Model Aktif', 'Active Model'), value: d.model, options: this.models.list.map(m => ({ value: m, label: m })), disabled: !core || !this.models.list.length,
        reason: this.models.error ? (this.models.error === 'PROVIDER_NOT_CONNECTED' ? t('hubungkan dulu: isi URL/key lalu Terapkan', 'connect first: fill URL/key, then Apply') : this.models.error) : null },
      { id: 'streaming', card: 0, kind: 'info', label: 'Streaming Output', value: 'ON', reason: t('selalu: Core men-stream setiap giliran (SSE)', 'always: Core streams every turn (SSE)') },
      // 2. Permission & Sandbox
      { id: 'autonomy', card: 1, kind: 'select', label: t('Profil Otonomi', 'Autonomy Profile'), value: d.autonomy || 'ask', disabled: !core?.settings,
        options: ['ask', 'workspace-auto', 'full-access', 'read-only'].map(value => ({ value, label: value })) },
      { id: 'sandbox', card: 1, kind: 'info', label: 'Sandbox', value: sandbox ? `${t('tulis', 'writes')}: ${sandbox.writes} · ${t('jaringan', 'network')}: ${sandbox.network}` : '—',
        reason: sandbox ? `${t('isolasi', 'containment')}: ${sandbox.containment}` : null },
      core?.settings ? { id: 'extraDir', card: 1, kind: 'text', label: t('Direktori Tambahan (; pemisah)', 'Extra Allowed Dirs (; separated)'), value: d.extraDirsText || '', disabled: false } : unavailable('extraDir', 1, t('Direktori Tambahan', 'Extra Allowed Dirs'), t('Core settings unavailable', 'Core settings unavailable')),
      core?.settings?.plugins?.some(p => p.key) ? { id: 'pluginKey', card: 1, kind: 'select', label: t('Plugin Proyek', 'Project Plugin'), value: d.pluginKey,
        options: core.settings.plugins.filter(p => p.key).map(p => ({ value: p.key, label: p.name + (p.changedSinceTrust ? ' (changed)' : '') })) } : unavailable('pluginKey', 1, t('Plugin Proyek', 'Project Plugin'), t('tidak ada plugin proyek yang valid', 'no valid project plugin')),
      core?.settings?.plugins?.some(p => p.key) ? { id: 'trustPlugins', card: 1, kind: 'toggle', label: t('Percayai Plugin Proyek', 'Trust Project Plugin'), value: !!d.pluginTrusted,
        reason: core.settings.plugins.find(p => p.key === d.pluginKey)?.name || null } : unavailable('trustPlugins', 1, t('Percayai Plugin Proyek', 'Trust Project Plugins'), t('tidak ada plugin proyek yang valid', 'no valid project plugin')),
      // 3. Capabilities & Agents
      core?.settings ? { id: 'skill', card: 2, kind: 'select', label: t('Routing Skill Aktif', 'Active Skill Routing'), value: d.skillRouting || 'auto',
        options: ['auto', 'off'].map(value => ({ value, label: value })) } : unavailable('skill', 2, t('Routing Skill Aktif', 'Active Skill Routing'), t('Core settings unavailable', 'Core settings unavailable')),
      { id: 'mcp', card: 2, kind: 'info', label: 'MCP Servers', value: catalogValue(catalogs.mcp, t) },
      { id: 'plugins', card: 2, kind: 'info', label: 'Plugins', value: catalogValue(catalogs.plugins, t) },
      { id: 'act-agents', card: 2, kind: 'button', label: t('Kesehatan Pandawa (agents list)', 'Pandawa health (agents list)'), command: 'agents list' },
      { id: 'act-mcp', card: 2, kind: 'button', label: t('Muat katalog MCP (mcp list)', 'Load MCP catalog (mcp list)'), command: 'mcp list' },
      { id: 'act-plugins', card: 2, kind: 'button', label: t('Katalog Plugins (plugins list)', 'Plugins catalog (plugins list)'), command: 'plugins list' },
      { id: 'act-tools', card: 2, kind: 'button', label: t('Katalog Tools (tools list)', 'Tools catalog (tools list)'), command: 'tools list' },
      // 4. Appearance & Animation
      { id: 'theme', card: 3, kind: 'select', label: t('Tema Warna', 'Colour Theme'), value: d.theme, options: themes.map(v => ({ value: v, label: v })) },
      { id: 'language', card: 3, kind: 'select', label: t('Bahasa', 'Language'), value: d.language, options: [{ value: 'id', label: 'Indonesia' }, { value: 'en', label: 'English' }] },
      { id: 'flame', card: 3, kind: 'toggle', label: t('Animasi Api Damar', 'Damar Flame Animation'), value: d.flame },
      { id: 'sidebar', card: 3, kind: 'toggle', label: t('Panel Sidebar', 'Sidebar Panel'), value: d.sidebar },
      { id: 'hudPosition', card: 3, kind: 'select', label: t('Posisi Live HUD', 'Live HUD Position'), value: d.hudPosition,
        options: ['left', 'right', 'bottom', 'hidden'].map(value => ({ value, label: value })) },
      { id: 'details', card: 3, kind: 'toggle', label: t('Detail Diperluas (Ctrl+T)', 'Expand Details (Ctrl+T)'), value: d.details },
      // 5. Context, Git & Session
      { id: 'act-context', card: 4, kind: 'button', label: t('Status Konteks (context status)', 'Context Status (context status)'), command: 'context status' },
      { id: 'act-review', card: 4, kind: 'button', label: t('Tinjau Kode (/review)', 'Code Review (/review)'), command: '/review' },
      { id: 'act-usage', card: 4, kind: 'button', label: t('Pemakaian Token (usage)', 'Token Usage (usage)'), command: 'usage' },
      { id: 'act-clear', card: 4, kind: 'button', label: t('Bersihkan Layar (clear)', 'Clear Screen (clear)'), command: 'clear' },
      // 6. Diagnostics & Save
      { id: 'act-test', card: 5, kind: 'button', label: t('Tes Koneksi Provider', 'Test Provider Connection'), action: 'test', disabled: !core },
      { id: 'act-doctor', card: 5, kind: 'button', label: 'System Doctor (doctor)', command: 'doctor' },
      { id: 'save', card: 5, kind: 'button', label: t('✓ Simpan & Terapkan', '✓ Save & Apply'), action: 'save', primary: true },
      { id: 'apply', card: 5, kind: 'button', label: t('Terapkan', 'Apply'), action: 'apply' },
      { id: 'cancel', card: 5, kind: 'button', label: t('Batal', 'Cancel'), action: 'cancel' },
    ];
  }
  focusable() { return this.fields().filter(x => !x.disabled && x.kind !== 'info'); }
  focusField(id) { const index = this.focusable().findIndex(field => field.id === id); if (index >= 0) this.focus = index; }
  current() { const list = this.focusable(); this.focus = Math.max(0, Math.min(list.length - 1, this.focus)); return list[this.focus]; }
  dirty() {
    const a = this.appearanceNow(), d = this.draft, core = this.core;
    const appearance = ['theme', 'language', 'flame', 'sidebar', 'details', 'hudPosition'].some(k => a[k] !== d[k]);
    const provider = !!core && (d.provider !== core.provider.active || (d.model || '') !== (core.provider.model || '') || !!this.secret
       || ((this.providerRow(d.provider)?.kind === 'live') && !require('./provider-endpoint.cjs').sameEndpoint(d.provider, d.baseUrl || '', this.providerRow(d.provider)?.baseUrl || '')));
    const coreSettings = !!core?.settings && (d.autonomy !== core.settings.autonomy || d.skillRouting !== core.settings.skills.routing || d.extraDirsText !== (core.settings.extraDirs || []).join(';'));
    const plugin = !!core?.settings?.plugins?.find(p => p.key === d.pluginKey && p.trusted !== !!d.pluginTrusted);
    return { appearance, provider, coreSettings, plugin, any: appearance || provider || coreSettings || plugin };
  }
  validate() {
    const e = {}, d = this.draft;
    if (this.dirty().provider) {
      if (!this.providerRow(d.provider)) e.provider = 'UNKNOWN_PROVIDER';
       if (this.providerRow(d.provider)?.kind === 'live' && !BASE_URL.test(d.baseUrl || '')) e.baseUrl = this.t('gunakan https://<host>/v1, atau http://127.0.0.1:<port>/v1 untuk komputer ini', 'use https://<host>/v1, or http://127.0.0.1:<port>/v1 for this computer');
       if (this.providerRow(d.provider)?.kind === 'live' && !require('./subagents.cjs').modelAuthorized(this.providerRow(d.provider), d.model)) e.model = 'LIVE_MODEL_NOT_AUTHORIZED';
      if (this.secret && !KEY_OK(this.secret)) e.apiKey = 'INVALID_API_KEY_FORMAT';
      if (d.model && this.models.id === d.provider && this.models.list.length && !this.models.list.includes(d.model)) e.model = 'MODEL_NOT_OFFERED_BY_PROVIDER';
    }
    if (!themes.includes(d.theme)) e.theme = 'UNKNOWN_ORIGINAL_THEME';
    if (d.extraDirsText && d.extraDirsText.split(';').length > 8) e.extraDir = 'MAX_EIGHT_DIRECTORIES';
    this.errors = e; return !Object.keys(e).length;
  }

  // ---- edits ----
  async setValue(id, value) {
    const d = this.draft;
    if (id === 'provider') {
      if (value === d.provider) return;
      d.provider = value; d.model = ''; this.secret = ''; d.baseUrl = this.providerRow(value)?.baseUrl || ''; this.baseUrlReplaceOnType = true;
      this.status = this.t('Membaca model…', 'Reading models…'); this.tui.render();
      await this.loadModels(value); this.status = null;
      const saved = this.providerRow(value)?.model;
      d.model = saved && this.models.list.includes(saved) ? saved : (this.providerRow(value)?.kind === 'live' ? '' : (this.models.list[0] || ''));
    } else if (id === 'skill') d.skillRouting = value;
    else if (id === 'pluginKey') { d.pluginKey = value; d.pluginTrusted = !!this.core.settings.plugins.find(p => p.key === value)?.trusted; }
    else if (['theme', 'language', 'model', 'autonomy', 'hudPosition'].includes(id)) d[id] = value;
    else if (id === 'trustPlugins') d.pluginTrusted = !!value;
    else if (['flame', 'sidebar', 'details'].includes(id)) d[id] = !!value;
    delete this.errors[id]; this.tui.render();
  }
  typeInto(id, ch) {
    if (id === 'baseUrl') {
      const current = this.baseUrlReplaceOnType ? '' : (this.draft.baseUrl || '');
      this.draft.baseUrl = (current + ch).slice(0, 120); this.baseUrlReplaceOnType = false; delete this.errors.baseUrl;
    }
    if (id === 'extraDir') { this.draft.extraDirsText = ((this.draft.extraDirsText || '') + ch).slice(0, 1800); delete this.errors.extraDir; }
    if (id === 'apiKey') { this.secret = (this.secret + ch).slice(0, 512); delete this.errors.apiKey; }
  }
  backspace(id) {
    if (id === 'baseUrl') { this.draft.baseUrl = (this.draft.baseUrl || '').slice(0, -1); this.baseUrlReplaceOnType = false; }
    if (id === 'extraDir') this.draft.extraDirsText = (this.draft.extraDirsText || '').slice(0, -1);
    if (id === 'apiKey') this.secret = this.secret.slice(0, -1);
  }

  // ---- actions ----
  async apply({ persist = false, close = false } = {}) {
    if (this.busy) return false;
    if (!this.validate()) { this.status = this.t('Periksa isian yang ditandai.', 'Check the marked fields.'); this.tui.render(); return false; }
    const dirty = this.dirty(), d = this.draft;
    this.busy = true; this.status = this.t('Menerapkan…', 'Applying…'); this.tui.render();
    try {
      if (dirty.provider) {
        const apiKey = this.secret || undefined; this.secret = '';
        const result = await this.deps.applyProvider({ provider: d.provider, model: d.model || undefined,
          baseUrl: this.providerRow(d.provider)?.kind === 'live' && !require('./provider-endpoint.cjs').sameEndpoint(d.provider, d.baseUrl, this.providerRow(d.provider)?.baseUrl) ? d.baseUrl : undefined, apiKey });
        if (result.state === 'CONNECTED') {
           this.core = await this.deps.core(); d.provider = result.provider; d.model = this.providerRow(result.provider)?.model || '';
           d.baseUrl = this.providerRow(result.provider)?.baseUrl || '';
          await this.loadModels(d.provider);
          if (dirty.appearance) {
            const tui = this.tui;
            tui.theme = d.theme; tui.language = d.language; tui.bannerMode = d.flame ? 'flame' : 'static';
            tui.sidebarEnabled = d.sidebar; tui.details = d.details; tui.hudPosition = d.hudPosition;
          }
          if (persist) await this.deps.persist?.({ theme: d.theme, bannerMode: d.flame ? 'flame' : 'static', language: d.language, hudPosition: d.hudPosition });
            this.status = this.t('Provider tersambung. Pilih model; inferensi belum aktif.',
              'Provider connected. Choose a model explicitly; inference is still disabled.');
          if (close) this.deps.close?.(this.status);
          this.tui.render();
          return true;
        }
         if (result.state !== 'SELECTED') {
           this.errors[result.error === 'PROVIDER_URL_NOT_ALLOWED' ? 'baseUrl' : result.error === 'LIVE_MODEL_NOT_AUTHORIZED' ? 'model' : 'provider'] = result.error || result.state;
           this.core = await this.deps.core();
           if (result.reconciliation) {
             d.provider = this.core.provider.active;
             d.model = this.providerRow(d.provider)?.model || '';
             d.baseUrl = this.providerRow(d.provider)?.baseUrl || '';
             await this.loadModels(d.provider);
           }
           this.status = (result.state === 'OUTCOME_UNKNOWN' ? this.t('Hasil belum pasti; jangan kirim ulang key. ', 'Outcome uncertain; do not resend the key. ') : result.reconciliation ? this.t('Status Core dimuat ulang; periksa sebelum menerapkan lagi. ', 'Core state refreshed; review before another Apply. ') : result.configurationSaved ? this.t('Koneksi tersimpan, pemilihan model gagal: ', 'Connection saved, model selection failed: ') : this.t('Penerapan ditolak; status Core dimuat ulang: ', 'Apply rejected; Core state refreshed: ')) + (result.error || result.state);
           return false;
         }
        this.deps.selected?.(result);
         this.core = await this.deps.core(); d.provider = this.core.provider.active; d.model = this.core.provider.model || ''; await this.loadModels(d.provider);
         d.baseUrl = this.providerRow(d.provider)?.baseUrl || '';
        if (persist) await this.deps.persist?.({ provider: result.provider, model: result.model });
      }
      if (dirty.coreSettings) {
        await this.deps.applySettings({ autonomy: d.autonomy, extraDirs: (d.extraDirsText || '').split(';').map(s => s.trim()).filter(Boolean), skills: { routing: d.skillRouting } });
        this.core = await this.deps.core();
      }
      if (dirty.plugin) {
        await this.deps.trustPlugin(d.pluginKey, !!d.pluginTrusted);
        this.core = await this.deps.core();
      }
      if (dirty.appearance || persist) {
        const tui = this.tui;
        tui.theme = d.theme; tui.language = d.language; tui.bannerMode = d.flame ? 'flame' : 'static'; tui.sidebarEnabled = d.sidebar; tui.details = d.details; tui.hudPosition = d.hudPosition;
        if (persist) await this.deps.persist?.({ theme: d.theme, bannerMode: tui.bannerMode, language: d.language, hudPosition: d.hudPosition });
      }
      this.status = persist ? this.t('Disimpan ke DAMAR Core dan diterapkan.', 'Saved to DAMAR Core and applied.') : dirty.any ? this.t('Diterapkan (sesi ini).', 'Applied (this session).') : this.t('Tidak ada perubahan.', 'No changes.');
      if (close) this.deps.close?.(this.status);
      return true;
    } catch (error) {
      this.secret = '';
      this.status = code(error) === 'OWNER_CONFIRMATION_CANCELLED' ? this.t('Dibatalkan; tidak ada yang diubah.', 'Cancelled; nothing was changed.') : this.t('Gagal: ', 'Failed: ') + code(error);
      return false;
    } finally { this.busy = false; this.tui.render(); }
  }
  cancel() { const dirty = this.dirty().any; this.secret = ''; this.deps.close?.(dirty ? this.t('Perubahan dibatalkan; tidak ada yang dikirim.', 'Changes discarded; nothing was sent.') : null); }
  async test() {
    const id = this.draft.provider; this.status = this.t('Menguji ', 'Testing ') + id + '…'; this.tui.render();
    await this.loadModels(id);
    this.status = this.models.error ? id + ': ' + this.models.error : id + this.t(': terjangkau, ', ': reachable, ') + this.models.list.length + this.t(' model (metadata saja, tanpa inferensi)', ' models (metadata only, no inference)');
    this.tui.render();
  }
  async revokeCredential() {
    const provider = this.draft.provider;
    if (!this.deps.revokeProvider || !this.providerRow(provider)?.hasKey) return false;
    this.busy = true; this.status = this.t('Mencabut kredensial…', 'Revoking credential…'); this.tui.render();
    try {
      await this.deps.revokeProvider(provider);
       this.secret = '';
      this.core = await this.deps.core(); this.draft.provider = this.core.provider.active; this.draft.model = this.core.provider.model || '';
      await this.loadModels(this.draft.provider);
      this.status = this.t('Kredensial dicabut dari memori dan penyimpanan aman.', 'Credential revoked from memory and secure storage.');
      return true;
    } catch (error) {
      this.status = this.t('Gagal mencabut kredensial: ', 'Credential revocation failed: ') + code(error);
      return false;
    } finally { this.busy = false; this.tui.render(); }
  }
  async activate(field) {
    if (!field || field.disabled || this.busy) return;
    if (field.kind === 'toggle') return this.setValue(field.id, !field.value);
    if (field.kind === 'select') {
      this.open = this.open === field.id ? null : field.id;
      this.openIndex = Math.max(0, field.options.findIndex(o => o.value === field.value));
      this.optionStart = Math.floor(this.openIndex / 8) * 8;
      this.tui.render(); return;
    }
    if (field.kind === 'button') {
      if (field.action === 'save') return this.apply({ persist: true, close: true });
      if (field.action === 'apply') return this.apply();
      if (field.action === 'cancel') return this.cancel();
      if (field.action === 'test') return this.test();
      if (field.action === 'revoke') return this.revokeCredential();
      if (field.command) { this.secret = ''; this.deps.close?.(null); this.deps.run?.(field.command); }
    }
  }
  async choose(field, index) {
    const option = field.options[index];
    this.open = null;
    if (option && !option.disabled) await this.setValue(field.id, option.value); else this.tui.render();
  }
  moveOption(field, delta) {
    const count = field?.options?.length || 0;
    if (!count) return;
    this.openIndex = Math.max(0, Math.min(count - 1, this.openIndex + delta));
    const visible = Math.min(8, count);
    if (this.openIndex < this.optionStart) this.optionStart = this.openIndex;
    else if (this.openIndex >= this.optionStart + visible) this.optionStart = this.openIndex - visible + 1;
    this.tui.render();
  }

  // ---- input ----
  async key(text, key) {
    if (this.busy) return;
    if (key.name === 'f1') { this.showHelp = !this.showHelp; return this.tui.render(); }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      const section = (this.current()?.card || 0) + (key.name === 'pagedown' ? 1 : -1);
      return this.click({ field: '@section' + ((section + 6) % 6) });
    }
    const field = this.current();
    if (this.open && field?.id === this.open) {
      if (key.name === 'escape') { this.open = null; return this.tui.render(); }
      if (key.name === 'up' || key.name === 'down') return this.moveOption(field, key.name === 'down' ? 1 : -1);
      if (key.name === 'return' || key.name === 'space' || text === ' ') return this.choose(field, this.openIndex);
      return;
    }
    if (key.name === 'escape') return this.cancel();
    if (key.ctrl && key.name === 's') return this.apply({ persist: true, close: true });
    const n = this.focusable().length;
    if (key.name === 'tab' && !key.shift || key.name === 'down') { this.focus = (this.focus + 1) % n; return this.tui.render(); }
    if (key.name === 'tab' && key.shift || key.name === 'up') { this.focus = (this.focus - 1 + n) % n; return this.tui.render(); }
    if (field && ['text', 'secret'].includes(field.kind)) {
      if (key.name === 'backspace') { this.backspace(field.id); return this.tui.render(); }
      if (key.name === 'return') {
        if (field.id === 'apiKey' && this.secret) return this.apply();
        this.focus = (this.focus + 1) % n; return this.tui.render();
      }
      if (typeof text === 'string' && text.length === 1 && text >= ' ' && !key.ctrl && !key.meta) { this.typeInto(field.id, text); return this.tui.render(); }
      return;
    }
    if (field?.kind === 'select' && (key.name === 'left' || key.name === 'right')) {
      const opts = field.options.filter(o => !o.disabled); if (!opts.length) return;
      const at = opts.findIndex(o => o.value === field.value), next = opts[(at + (key.name === 'right' ? 1 : -1) + opts.length) % opts.length];
      return this.setValue(field.id, next.value);
    }
    if (field?.kind === 'toggle' && (key.name === 'left' || key.name === 'right')) return this.setValue(field.id, !field.value);
    if (key.name === 'return' || key.name === 'space' || text === ' ') return this.activate(field);
  }
  async click(hit) {
    if (this.busy || !hit) return;
    if (/^@section[0-5]$/.test(hit.field)) {
      const section = Number(hit.field.slice(-1));
      const first = this.focusable().find(f => f.card === section);
      if (first) this.focusField(first.id);
      this.open = null; this.showHelp = false; this.tui.render(); return;
    }
    const field = this.fields().find(x => x.id === hit.field);
    if (!field || field.disabled || field.kind === 'info') return;
    this.focus = Math.max(0, this.focusable().findIndex(x => x.id === field.id));
    if (Number.isInteger(hit.option)) return this.choose(field, hit.option);
    if (field.kind === 'text' || field.kind === 'secret') return this.tui.render();
    return this.activate(field);
  }
  wheel(direction) {
    if (this.open) return this.moveOption(this.fields().find(f => f.id === this.open), direction > 0 ? 1 : -1);
    const n = this.focusable().length; this.focus = (this.focus + (direction > 0 ? 1 : -1) + n) % n; this.tui.render();
  }
  flash(message) { if (message) { this.status = message; this.tui.render(); } }

  // ---- view for the renderer (never the key) ----
  view() {
    const cur = this.current(), t = this.t.bind(this);
    return {
      compact: true,
      cardLayout: true,
      section: cur?.card ?? 0,
      sections: [t('Provider', 'Provider'), t('Izin', 'Permissions'), t('Agen', 'Agents'), t('Tampilan', 'Appearance'), t('Sesi', 'Session'), t('Diagnostik', 'Diagnostics')],
      help: this.showHelp ? (cur?.reason || t('Tab pindah · Enter pilih · Esc batal', 'Tab move · Enter select · Esc cancel')) : null,
      title: t('Pusat Kontrol Pengaturan DAMAR CLI', 'DAMAR CLI Settings Control Center'),
      cards: ['1. Provider & Model', t('2. Izin & Sandbox', '2. Permission & Sandbox'), t('3. Kapabilitas & Agen', '3. Capabilities & Agents'),
        t('4. Tampilan & Animasi', '4. Appearance & Animation'), t('5. Konteks, Git & Sesi', '5. Context, Git & Session'), t('6. Diagnostik & Simpan', '6. Diagnostics & Save')],
      fields: this.fields().map(f => ({ id: f.id, card: f.card, kind: f.kind, label: f.label,
        value: f.kind === 'select' ? (f.options.find(o => o.value === f.value)?.label ?? String(f.value ?? '')) : f.value,
        placeholder: f.placeholder || null, disabled: !!f.disabled, reason: f.reason || null, error: this.errors[f.id] || null, primary: !!f.primary,
         focused: cur?.id === f.id, open: this.open === f.id, openIndex: this.open === f.id ? this.openIndex : null,
         optionStart: this.open === f.id ? this.optionStart : null,
         options: this.open === f.id ? f.options.map(o => ({ label: o.label, disabled: !!o.disabled })) : null })),
      dirty: this.dirty().any, busy: this.busy, status: this.status,
       hint: t('Tab/↑↓ pindah · PgUp/PgDn bagian · F1 bantuan · Ctrl+S simpan · Esc batal',
               'Tab/↑↓ move · PgUp/PgDn section · F1 help · Ctrl+S save · Esc cancel'),
    };
  }
}
function catalogValue(record, t) {
  if (!record || typeof record !== 'object' || record.state == null || record.state === 'NOT_QUERIED') return t('belum dimuat', 'not loaded');
  if (record.state === 'UNAVAILABLE') return 'UNAVAILABLE';
  const n = Array.isArray(record.items) ? record.items.length : Number.isInteger(record.count) ? record.count : null;
  return n === null ? String(record.state) : n + t(' terdaftar', ' registered');
}
function code(error) { return typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.message) ? error.message : 'SETTINGS_FAILED'; }
module.exports = { SettingsCenter, BASE_URL };
