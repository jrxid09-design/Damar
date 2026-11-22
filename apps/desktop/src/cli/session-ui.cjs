'use strict';
// Session flow for the W5 CLI: start or resume a Core-recorded session, the /sessions picker, transcript journaling,
// the exit receipt and the `damar sessions` listing. Indonesian is the default language; status codes stay as-is.
const fs = require('node:fs'), path = require('node:path');
const { filterSessionPick } = require('./w5-input.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const pad = n => String(n).padStart(2, '0');
const stamp = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const tail = (p, n = 28) => { const s = String(p || ''); return s.length > n ? '...' + s.slice(-(n - 3)) : s; };

// The resume command shown to the user must actually run: `damar` only when PATH resolves to this package's
// launcher; otherwise the launcher's full path. PATH is never modified.
function resumeCommand(id, env = process.env) {
  const launcher = path.join(ROOT, 'damar.cmd');
  const same = dir => { try { return fs.realpathSync(path.join(dir, 'damar.cmd')).toLowerCase() === fs.realpathSync(launcher).toLowerCase(); } catch { return false; } };
  const onPath = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).some(same);
  return (onPath ? 'damar' : (/\s/.test(launcher) ? `"${launcher}"` : launcher)) + ' resume ' + id;
}

function statusText(s, tr) {
  if (s.attached) return tr('dipakai di jendela lain', 'open in another window');
  if (s.openOperations?.length) return tr('operasi berjalan', 'operation running');
  if (s.unresolvedOperations?.length) return tr(s.unresolvedOperations.length + ' operasi belum terselesaikan', s.unresolvedOperations.length + ' unresolved operation(s)');
  if (s.activeSubagentRuns) return tr('sub-agent berjalan di Core', 'sub-agent running in Core');
  return s.closed ? tr('tersimpan', 'saved') : tr('terputus', 'interrupted');
}
const label = (s, tr) => [s.title, stamp(s.updatedAt), tail(s.cwd), s.model || '-', statusText(s, tr)].join(' · ');

function listText(sessions, tr) {
  if (!sessions.length) return tr('Belum ada sesi tersimpan.', 'No saved sessions yet.');
  const rows = sessions.map(s => `${s.sessionId.slice(0, 12)}  ${stamp(s.updatedAt)}  ${String(s.title).slice(0, 40).padEnd(40)}  ${(s.model || '-').slice(0, 28).padEnd(28)}  ${statusText(s, tr)}`);
  return [tr('ID            Diperbarui        Judul                                     Model                         Status', 'ID            Updated           Title                                     Model                         Status'), ...rows, '',
    tr('Lanjutkan dengan: ', 'Resume with: ') + resumeCommand('<id>')].join('\n');
}

function createSessionUI({ rl, history, tr, print, updateHud, isBusy }) {
  let synced = 0, titled = false;
  const sync = () => {
    if (!history?.id || !Array.isArray(rl.messages)) return;
    if (rl.messages.length < synced) synced = 0;  // `clear` empties the visible transcript; Core keeps the history
    for (; synced < rl.messages.length; synced++) {
      const m = rl.messages[synced];
      if (m.pending) break;  // a response still streaming is journaled once it is complete
      history.record({ type: 'MESSAGE', role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text) });
      if (m.role === 'user' && !titled) { titled = true; history.record({ type: 'TITLE', title: String(m.text).slice(0, 60) }); }
    }
  };
  // Resume after a crash: the dead window's lease still runs for a few seconds; say so while waiting.
  let waiting = false;
  const waitNotice = seconds => { waiting = true; rl.notice = tr(`Menunggu jendela sebelumnya melepas sesi (${seconds} dtk)…`, `Waiting for the previous window to release the session (${seconds} s)…`); rl.render(); };
  const restore = detail => {
    if (waiting) { waiting = false; rl.notice = null; }
    rl.messages.length = 0;
    for (const m of detail.conversation) rl.messages.push({ role: m.role, text: m.text });
    synced = rl.messages.length; titled = true; rl.scroll = 0;
    rl.usage = { snapshot: () => ({ ...detail.usage }) };
    updateHud('subagent', { state: 'READ_ONLY', namespace: 'subagent', runs: detail.subagents });
    const parts = [tr('Sesi dilanjutkan: ', 'Session resumed: ') + detail.title + ' (' + detail.messages + tr(' pesan).', ' messages).')];
    if (detail.unresolvedOperations.length) parts.push(tr('Operasi belum terselesaikan: ', 'Unresolved operations: ') + detail.unresolvedOperations.map(o => (o.command || 'operation') + ' ' + o.state).join(', ') + tr('. Tidak ada yang dijalankan ulang.', '. Nothing was re-run.'));
    if (detail.activeSubagentRuns) parts.push(tr(detail.activeSubagentRuns + ' run sub-agent masih diproses Core.', detail.activeSubagentRuns + ' sub-agent run(s) still processing in Core.'));
    if (detail.model) parts.push(tr('Model tercatat di sesi: ', 'Model recorded in this session: ') + (detail.provider ? detail.provider + '/' : '') + detail.model + tr('. Model default Anda tidak diubah.', '. Your default model is unchanged.'));
    // A transcript line, not the one-row footer: the summary is never cut and the key hints stay visible.
    print(parts.join(' '));
  };
  const openNew = async ({ provider, model } = {}) => {
    titled = false;
    await history.open({ title: tr('Sesi ', 'Session ') + stamp(Date.now()), cwd: require('./agent-turn.cjs').workspace(), ...(provider && model ? { provider, model } : {}) });
  };
  const failNotice = error => { rl.notice = tr('Riwayat sesi tidak tersedia (', 'Session history unavailable (') + (error.message || 'ERROR') + tr('). Sesi ini tidak disimpan.', '). This session is not being saved.'); rl.render(); };
  const openPicker = async (query = '') => {
    const { sessions } = await history.list();
    const all = sessions.filter(s => s.sessionId !== history.id).map(s => ({ id: s.sessionId, label: label(s, tr) }));
    if (!all.length) { print(tr('Belum ada sesi tersimpan lain.', 'No other saved sessions.')); return false; }
    rl.pick = { kind: 'session', all, query: String(query).slice(0, 40), baseTitle: tr('Pilih sesi (ketik untuk mencari)', 'Choose a session (type to search)'), searchLabel: tr('cari', 'search'), choices: [], ids: [], index: 0 };
    filterSessionPick(rl.pick); rl.render(); return true;
  };
  const switchTo = async id => {
    if (isBusy()) { print(tr('Operasi masih berjalan; selesaikan atau hentikan dulu sebelum pindah sesi.', 'An operation is still running; finish or stop it before switching sessions.')); return; }
    sync();
    const previous = history.id;
    try {
      if (previous) await history.close();
      restore(await history.attach(id, { onWait: waitNotice }));
    } catch (error) {
      print(tr('Tidak dapat membuka sesi itu: ', 'Could not open that session: ') + error.message);
      if (previous && !history.id) try { restore(await history.attach(previous)); } catch (again) { failNotice(again); }
    }
  };
  return {
    sync, openPicker, switchTo, failNotice,
    async start({ verb, resumeId, saved }) {
      if (!history) return;
      try {
        if (resumeId) restore(await history.attach(await history.resolve(resumeId), { onWait: waitNotice }));
        else if (verb === 'resume') { if (!await openPicker()) await openNew(saved); }
        else await openNew(saved);
      } catch (error) {
        if (resumeId) { print(tr('Sesi ', 'Session ') + resumeId + tr(' tidak dapat dilanjutkan: ', ' could not be resumed: ') + error.message + tr('. Sesi baru dibuka.', '. A new session was opened.')); try { await openNew(saved); } catch (e) { failNotice(e); } }
        else failNotice(error);
      }
    },
    // Esc in the startup picker: nothing is resumed and a new session starts instead.
    async picked(id) { if (id) return switchTo(id); if (!history.id) try { await openNew(); } catch (e) { failNotice(e); } },
    operation(operationId, command, state, reason) { history?.record({ type: 'OPERATION', operationId, command, state, ...(reason ? { reason } : {}) }); },
    model(result) { if (result?.state === 'SELECTED' && result.provider && result.model) history?.record({ type: 'MODEL', provider: result.provider, model: result.model }); },
    // Exit receipt, printed after the native terminal is restored.
    async receipt({ interrupted }) {
      if (!history) return tr('Sesi ini tidak disimpan: tidak ada sesi Core privat.', 'This session was not saved: no private Core session.');
      sync();
      const id = history.id;
      if (!id) return tr('Sesi ini tidak disimpan.', 'This session was not saved.');
      const summary = await history.close(), lines = [];
      if (!summary) lines.push(tr('Sesi mungkin belum tersimpan lengkap: Core tidak menjawab (', 'The session may not be fully saved: Core did not respond (') + (history.lastError || 'NO_RESPONSE') + ').');
      else lines.push(tr('Sesi tersimpan.', 'Session saved.'));
      if (interrupted) lines.push(tr('Operasi ', 'Operation ') + interrupted.command + tr(' dihentikan saat keluar; hasil akhirnya tidak terkonfirmasi.', ' was stopped on exit; its final outcome is not confirmed.'));
      if (summary?.activeSubagentRuns) lines.push(tr(summary.activeSubagentRuns + ' run sub-agent masih diproses oleh Core. Hasilnya terlihat setelah sesi dilanjutkan.', summary.activeSubagentRuns + ' sub-agent run(s) are still processing in Core. Results are visible after you resume.'));
      if (summary?.unresolvedOperations?.length) lines.push(tr(summary.unresolvedOperations.length + ' operasi belum terselesaikan tercatat di sesi ini.', summary.unresolvedOperations.length + ' unresolved operation(s) are recorded in this session.'));
      lines.push('', tr('Untuk melanjutkan sesi ini, jalankan:', 'To resume this session, run:'), '  ' + resumeCommand(id));
      return lines.join('\n');
    },
  };
}
module.exports = { createSessionUI, listText, resumeCommand, label, statusText };
