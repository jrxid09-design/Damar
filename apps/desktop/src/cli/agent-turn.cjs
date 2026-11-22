'use strict';
// One natural-language agent turn from the W5 composer: starts the turn in Core (POST /api/r9/turns), follows its live
// events and turns them into transcript entries (streamed response box, tool rows, diff overlay, run outcome), asks the
// Owner on the permission card for consequential tools, and cancels the turn when the operation is aborted (Esc).
// Every entry carries a plain `text` summary, which is what the session journal records.
// The Owner's workspace: the directory DAMAR was launched from (RUN_DAMAR_CLI.ps1 passes it in DAMAR_WORKSPACE because the
// CLI process itself runs from the install directory).
const fs = require('node:fs'), path = require('node:path');
function workspace() {
  const w = process.env.DAMAR_WORKSPACE;
  try { if (w && path.isAbsolute(w) && fs.statSync(w).isDirectory()) return path.resolve(w); } catch {}
  return process.cwd();
}
async function runTurn({ client, clientId, rl, text, cwd, signal, tr }) {
  const start = await client.r9('/api/r9/turns', { method: 'POST', role: 'owner', body: { cliSession: client.sessionId, client: clientId, text, cwd }, signal });
  if (!start.ok || start.body?.success !== true || !/^turn-[a-f0-9-]{36}$/.test(start.body.data?.turnId || '')) throw Object.assign(Error(start.body?.error && /^[A-Z_]{1,60}$/.test(start.body.error) ? start.body.error : 'TURN_NOT_STARTED'), { reason: 'HTTP_' + start.status });
  const turnId = start.body.data.turnId;
  rl.plan = null; rl.interrupted = false; rl.doneAt = null;
  let response = null, thinking = null, cancelSent = false;
  const cancel = () => { if (cancelSent) return; cancelSent = true; client.r9(`/api/r9/turns/${turnId}/cancel`, { method: 'POST', role: 'owner', body: rl.exiting ? { reason: 'CLI_EXITED' } : {} }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const add = entry => { rl.messages.push(entry); if (rl.messages.length > 200) { rl.messages.shift(); rl.clearSelection = true; } rl.render(); return entry; };
  // The live response box closes when a tool event arrives (the model's next words open a new box below the tools).
  const close = () => { if (!response) return; response.streaming = false; response.pending = false; if (!response.text.trim()) rl.messages.splice(rl.messages.indexOf(response), 1); response = null; };
  // A lost connection is resumed from the next event; the footer says so while it reconnects.
  // Open permission cards of this turn. The card is not awaited inside the event loop, so a `permission_answer` from
  // another surface (Damar Notch) can arrive and close it; the first decision wins in Core.
  const cards = new Map();
  const decided = d => d === 'deny' ? tr('Ditolak', 'Denied') : d === 'session' ? tr('Diizinkan untuk sesi ini', 'Allowed for this session') : tr('Diizinkan sekali', 'Allowed once');
  const onReconnect = ({ attempt, of }) => { rl.notice = tr(`Koneksi ke Core terputus; menyambung ulang (${attempt}/${of})…`, `Connection to Core lost; reconnecting (${attempt}/${of})…`); rl.render(); };
  const final = await client.turnEvents(turnId, async event => {
    if (rl.notice && /^(Koneksi ke Core terputus|Connection to Core lost)/.test(rl.notice)) { rl.notice = null; }
    if (event.type === 'reasoning' && typeof event.text === 'string') {
      // The model's reasoning is kept apart from its answer: one muted block per stretch of reasoning.
      if (response) close();
      if (!thinking) thinking = add({ role: 'assistant', kind: 'reasoning', reasoning: '', chars: 0, text: '' });
      thinking.reasoning = (thinking.reasoning + event.text).slice(-16384); thinking.chars += event.text.length;
      thinking.text = tr(`Penalaran model · ${thinking.chars} karakter`, `Model reasoning · ${thinking.chars} chars`); rl.render();
      return;
    }
    thinking = null;
    if (event.type === 'delta' && typeof event.text === 'string') {
      if (!response) response = add({ role: 'assistant', kind: 'response', text: '', streaming: true, pending: true });
      response.text += event.text; rl.render();
    } else if (event.type === 'tool' && typeof event.badge === 'string') {
      close(); add({ role: 'assistant', kind: 'tool', badge: event.badge.slice(0, 8), target: String(event.target || '').slice(0, 300), text: `[${event.badge}] ${event.target || ''}` });
    } else if (event.type === 'diff' && event.diff && typeof event.diff === 'object') {
      close(); const d = event.diff, badge = event.badge === 'CREATE' ? 'CREATE' : 'EDIT';
      add({ role: 'assistant', kind: 'tool', badge, target: `${event.path} (+${d.added} -${d.removed})`, text: `[${badge}] ${event.path} (+${d.added} -${d.removed})` });
      add({ role: 'assistant', kind: 'diff', path: String(event.path).slice(0, 200), diff: d, text: `diff ${event.path} +${d.added} -${d.removed}` });
    } else if (event.type === 'run') {
      close(); const ok = event.exitCode === 0;
      add({ role: 'assistant', kind: 'outcome', ok, output: String(event.output || '').slice(-4000), text: (ok ? '✓ ' : '✗ ') + `exit ${event.exitCode} · ${event.durationMs} ms` });
    } else if (event.type === 'permission' && event.card) {
      close();
      if (signal?.aborted) return;   // cancel already sent; Core resolves the pending card as Deny
      const card = { settled: false };
      cards.set(event.id, card);
      Promise.resolve(rl.confirmPermission(event.card)).then(async decision => {
        if (card.settled || decision === 'external') return;   // answered on another surface; its notice is shown below
        card.settled = true; cards.delete(event.id);
        if (signal?.aborted) return;
        const what = decision === 'deny' ? tr('Izin ditolak: ', 'Permission denied: ') : decision === 'session' ? tr('Diizinkan untuk sesi ini: ', 'Allowed for this session: ') : tr('Diizinkan sekali: ', 'Allowed once: ');
        const note = add({ role: 'assistant', kind: 'notice', text: what + event.card.run });
        const answer = await client.r9(`/api/r9/turns/${turnId}/permission`, { method: 'POST', role: 'owner', body: { permissionId: event.id, decision, client: clientId } });
        if (answer.ok) return;
        // Another surface answered first: not an error, the turn already has its decision.
        note.text = answer.body?.error === 'PERMISSION_NOT_PENDING' ? tr('Sudah dijawab di tempat lain: ', 'Already answered elsewhere: ') + event.card.run
          : note.text + ' (' + (answer.body?.error || 'HTTP_' + answer.status) + ')';
        rl.render();
      }).catch(() => {});
    } else if (event.type === 'permission_answer') {
      const card = cards.get(event.id);
      if (!card || card.settled) return;   // our own answer, or a card this window never showed
      card.settled = true; cards.delete(event.id);
      rl.dismissPermission?.();
      add({ role: 'assistant', kind: 'notice', text: (event.surface === 'notch' ? tr('Dijawab dari Damar Notch: ', 'Answered from Damar Notch: ') : tr('Dijawab di tempat lain: ', 'Answered elsewhere: ')) + decided(event.decision) });
    } else if (event.type === 'plan' && Array.isArray(event.steps)) {
      rl.plan = event.steps.slice(0, 12); rl.render();
    } else if (event.type === 'agent' && /^run_[a-f0-9]{32}$/.test(event.runId || '')) {
      // One Pandawa block per run, updated in place: orange while running, green when finished.
      close();
      let block = rl.messages.find(m => m.kind === 'pandawa' && m.runId === event.runId);
      if (!block) block = add({ role: 'assistant', kind: 'pandawa', runId: event.runId, worker: String(event.worker || '').slice(0, 20), task: String(event.task || '').slice(0, 160), pending: true, startedAt: Date.now(), text: '' });
      const final = ['COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN'].includes(event.state);
      Object.assign(block, { endedAt: final ? (block.endedAt || Date.now()) : null, state: event.state, output: event.output ? String(event.output).slice(0, 2000) : null, error: event.error || null, pending: !final,
        text: `[SUB-AGENT] ${block.worker} · ${block.task} · ${event.state}${event.output ? ' · ' + String(event.output).slice(0, 300) : ''}` });
      rl.render();
    } else if (event.type === 'final') {
      close();
      // Recovered from Core's journal (the live stream was lost and Core restarted): show the answer once.
      if (event.recovered && typeof event.text === 'string' && event.text && !rl.messages.some(m => m.kind === 'response' && m.text === event.text))
        add({ role: 'assistant', kind: 'response', text: event.text, streaming: false, pending: false });
    }
  }, { signal, onReconnect });
  for (const card of cards.values()) { card.settled = true; rl.dismissPermission?.(); }   // turn ended: no card stays open
  signal?.removeEventListener('abort', cancel);
  rl.interrupted = final.status === 'CANCELLED'; rl.doneAt = final.status === 'COMPLETED' ? Date.now() : null;
  if (final.status === 'CANCELLED') add({ role: 'assistant', kind: 'notice', text: tr('! dihentikan — giliran dibatalkan oleh pengguna.', '! interrupted — the turn was cancelled by the user.') });
  if (final.status === 'FAILED') add({ role: 'assistant', kind: 'notice', text: '! ' + (PROVIDER_ERRORS[final.errorKind]?.(tr) || tr('Giliran gagal.', 'The turn failed.')) + ' (' + String(final.error || 'UNKNOWN').slice(0, 120) + ')' });
  return final;
}

// Provider failures Core classified (final.errorKind), in the Owner's language with what to do next.
const PROVIDER_ERRORS = Object.freeze({
  QUOTA: tr => tr('Kuota atau saldo penyedia model habis. Isi ulang, atau pilih model lain dengan /model.', 'The model provider\'s quota or credit is used up. Top it up, or choose another model with /model.'),
  AUTH: tr => tr('Penyedia model menolak kunci API. Periksa kunci di Settings › Provider & Model.', 'The model provider rejected the API key. Check the key in Settings › Provider & Model.'),
  RATE_LIMIT: tr => tr('Batas laju penyedia model tercapai. Tunggu sebentar lalu kirim ulang.', 'The model provider\'s rate limit was reached. Wait a moment, then send again.'),
  TIMEOUT: tr => tr('Penyedia model tidak menjawab tepat waktu. Kirim ulang, atau pilih model yang lebih cepat.', 'The model provider did not answer in time. Send again, or choose a faster model.'),
  UNAVAILABLE: tr => tr('Penyedia model sedang tidak tersedia. Coba lagi nanti, atau pilih model lain dengan /model.', 'The model provider is unavailable right now. Try again later, or choose another model with /model.'),
});

// Agent-era commands from the design palette that this build supports, plus honest refusals for the rest.
const UNAVAILABLE = {
  commit: ['Belum tersedia: build ini tidak punya izin git.', 'Not available: this build has no git authority.'],
  compact: ['Belum tersedia: Core meringkas konteks otomatis (8 pesan terbaru + yang relevan).', 'Not available: Core trims context automatically (8 most recent + relevant messages).'],
};
function localCommand(line) {
  const m = /^\/?(review|diff|export|permission|sandbox|commit|compact|add-dir|undo|redo|checkpoints|continue|dismiss)(?:\s+(.{0,200}))?$/i.exec(String(line).trim());
  if (m) return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
  // Project memory: `/memory`, `/memory add <note>`, `/memory forget <n>` (`/memory stats` stays Core's memory statistics).
  const mem = /^\/?memory(?:\s+(add|forget)\s+(.{1,400}))?$/i.exec(String(line).trim());
  return mem ? { name: 'memory', args: mem[1] ? mem[1].toLowerCase() : '', value: (mem[2] || '').trim() } : null;
}
async function runLocal({ name, args, value }, { client, clientId, rl, tr, profile }) {
  if (UNAVAILABLE[name]) return { text: tr(...UNAVAILABLE[name]) };
  const sessionCall = async (route, body) => {
    if (!client || !clientId || !client.sessionId) throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');
    const r = await client.r9(route, { method: 'POST', role: 'owner', body: { cliSession: client.sessionId, client: clientId, ...body } });
    if (!r.ok || r.body?.success !== true) throw Object.assign(Error(/^[A-Z_]{3,60}$/.test(r.body?.error || '') ? r.body.error : 'SERVICE_DENIED_HTTP_' + r.status), { files: r.body?.files });
    return r.body.data;
  };
  // Undo / redo of the agent's file changes, one whole turn at a time, after the Owner approves the exact restore.
  if (name === 'checkpoints') {
    const turns = await sessionCall('/api/r9/checkpoints', { action: 'list' });
    if (!turns.length) return { text: tr('Belum ada perubahan file oleh Damar di sesi ini.', 'Damar has not changed any file in this session.') };
    const label = { applied: tr('aktif', 'applied'), undone: tr('di-undo', 'undone'), dropped: tr('dibuang', 'dropped') };
    return { text: tr('Checkpoint sesi ini (terbaru di bawah):', 'Checkpoints of this session (newest last):') + '\n' + turns.map((t, i) => `  ${i + 1}. [${label[t.state] || t.state}] ` + t.files.map(f => f.path + (f.created ? ' (new)' : '')).join(', ')).join('\n') };
  }
  if (name === 'undo' || name === 'redo') {
    const plan = await sessionCall('/api/r9/checkpoints', { action: 'preview', kind: name });
    if (!plan) return { text: name === 'undo' ? tr('Tidak ada perubahan Damar yang bisa di-undo.', 'There is no Damar change to undo.') : tr('Tidak ada yang bisa di-redo.', 'There is nothing to redo.') };
    if (!plan.ready) return { text: tr('Tidak bisa ', 'Cannot ') + name + tr(': file sudah berubah sejak Damar mengubahnya: ', ': files changed since Damar changed them: ') + plan.files.filter(f => !f.unchanged).map(f => f.path).join(', ') + tr('. Tidak ada yang ditulis.', '. Nothing was written.') };
    const what = { delete: tr('hapus file baru', 'delete new file'), restore: tr('kembalikan isi sebelumnya', 'restore previous content'), recreate: tr('buat ulang', 'recreate'), reapply: tr('terapkan ulang', 're-apply') };
    const decision = await rl.confirmPermission({ tool: name, run: plan.files.map(f => f.path).join(', '), change: plan.files.map(f => `${f.path}: ${what[f.action]}`).join('; '),
      scope: tr('Workspace saat ini', 'Current workspace'), risk: tr('Mengubah file yang sebelumnya diubah Damar', 'Changes files Damar changed before') });
    if (decision === 'deny') return { text: tr('Dibatalkan; tidak ada yang ditulis.', 'Cancelled; nothing was written.') };
    const done = await sessionCall('/api/r9/checkpoints', { action: 'run', kind: name, turnId: plan.turnId });
    return { text: (name === 'undo' ? tr('Di-undo: ', 'Undone: ') : tr('Di-redo: ', 'Redone: ')) + done.files.map(f => `${f.path} (${what[f.action]})`).join(', ') + tr('. Terverifikasi.', '. Verified.') };
  }
  // Persistent project memory of this workspace (kept by Core, isolated per project, changed only with approval).
  if (name === 'memory') {
    const notes = await sessionCall('/api/r9/memory', { action: 'list', root: workspace() });
    if (!args) return { text: notes.length ? tr('Memori proyek untuk ', 'Project memory for ') + workspace() + ':\n' + notes.map((n, i) => `  ${i + 1}. ${n.text}`).join('\n') + tr('\n(/memory add <catatan> · /memory forget <nomor> · /memory stats untuk memori Core)', '\n(/memory add <note> · /memory forget <number> · /memory stats for Core memory)')
      : tr('Memori proyek kosong. Tambah dengan /memory add <catatan> atau minta Damar: "remember that ...".', 'Project memory is empty. Add with /memory add <note> or ask Damar: "remember that ...".') };
    const note = args === 'forget' ? notes[Number(value) - 1] : null;
    if (args === 'forget' && !note) return { text: tr('Nomor catatan tidak ada.', 'No note with that number.') };
    const decision = await rl.confirmPermission({ tool: 'project memory', run: args === 'add' ? value.slice(0, 120) : note.text.slice(0, 120),
      change: args === 'add' ? tr('simpan catatan ke memori proyek', 'save a note to the project memory') : tr('hapus catatan dari memori proyek', 'remove a note from the project memory'),
      scope: tr('Workspace ini (semua sesi berikutnya)', 'This workspace (all future sessions)'), risk: tr('Damar mengikuti memori proyek di giliran berikutnya', 'Damar follows project memory in later turns') });
    if (decision === 'deny') return { text: tr('Dibatalkan; memori proyek tidak berubah.', 'Cancelled; project memory unchanged.') };
    if (args === 'add') { await sessionCall('/api/r9/memory', { action: 'add', root: workspace(), text: value }); return { text: tr('Disimpan ke memori proyek.', 'Saved to project memory.') }; }
    await sessionCall('/api/r9/memory', { action: 'forget', root: workspace(), id: note.id }); return { text: tr('Catatan dihapus dari memori proyek.', 'Note removed from project memory.') };
  }
  // Interrupted work: continue as a NEW turn (stating the request and the completed steps) or dismiss it.
  if (name === 'continue' || name === 'dismiss') {
    const pending = await sessionCall('/api/r9/turns/interrupted', { action: 'get' });
    if (!pending) return { text: tr('Tidak ada pekerjaan yang terputus di sesi ini.', 'There is no interrupted work in this session.') };
    const resolved = await sessionCall('/api/r9/turns/interrupted', { action: name === 'continue' ? 'continued' : 'dismissed', turnId: pending.turnId });
    rl.interruptedTurn = null;
    if (name === 'dismiss') return { text: tr('Pekerjaan terputus diabaikan.', 'Interrupted work dismissed.') };
    return { turn: `Continue the interrupted task: ${resolved.text}` + (resolved.steps.length ? ` (steps already completed: ${resolved.steps.slice(-8).join('; ')})` : '') };
  }
  if (name === 'review') return { turn: tr('Tinjau kode di workspace ini', 'Review the code in this workspace') + (args ? ': ' + args : '') };
  // Agent permissions and extra folders are Core settings (shared with DAMAR Control); changes ask the Owner first.
  if (name === 'permission' || name === 'add-dir') {
    const PROFILES = { ask: 'ask', workspace: 'workspace-auto', 'workspace-auto': 'workspace-auto', full: 'full-access', 'full-access': 'full-access', read: 'read-only', 'read-only': 'read-only' };
    const current = await sessionCall('/api/r9/settings', { action: 'read' });
    if (name === 'permission' && !args) return { text: tr('Profil otonomi: ', 'Autonomy profile: ') + current.autonomy + tr('. Ganti dengan /permission ask|workspace|full|read.', '. Change with /permission ask|workspace|full|read.') };
    if (name === 'add-dir' && !args) return { text: tr('Folder tambahan: ', 'Extra folders: ') + (current.extraDirs.join('; ') || '-') + tr('. Tambah dengan /add-dir <path absolut>.', '. Add with /add-dir <absolute path>.') };
    const values = name === 'permission' ? { autonomy: PROFILES[args.toLowerCase()] } : { extraDirs: [...current.extraDirs, args] };
    if (name === 'permission' && !values.autonomy) return { text: tr('Profil tidak dikenal. Pilihan: ask, workspace, full, read.', 'Unknown profile. Choose: ask, workspace, full, read.') };
    const decision = await rl.confirmPermission({ tool: 'core_settings', run: name + ' ' + args, change: name === 'permission' ? 'autonomy profile -> ' + values.autonomy : 'authorize extra folder ' + args, scope: 'Core settings (all sessions)', risk: 'Changes what the agent may do without asking' });
    if (decision === 'deny') return { text: tr('Dibatalkan; tidak ada yang diubah.', 'Cancelled; nothing was changed.') };
    const saved = await sessionCall('/api/r9/settings', { action: 'update', values });
    return { text: name === 'permission' ? tr('Profil otonomi sekarang: ', 'Autonomy profile is now: ') + saved.autonomy : tr('Folder tambahan: ', 'Extra folders: ') + saved.extraDirs.join('; ') };
  }
  if (name === 'diff') {
    const files = new Map();
    for (const m of rl.messages) {
      let p, a, r;
      if (m.kind === 'diff') [p, a, r] = [m.path, m.diff?.added || 0, m.diff?.removed || 0];
      else { const x = /^diff (\S+) \+(\d+) -(\d+)$/.exec(m.text || ''); if (!x) continue; [p, a, r] = [x[1], Number(x[2]), Number(x[3])]; }
      const prev = files.get(p) || { a: 0, r: 0 }; files.set(p, { a: prev.a + a, r: prev.r + r });
    }
    if (!files.size) return { text: tr('Belum ada file yang diubah Damar di sesi ini.', 'Damar has not changed any file in this session.') };
    return { text: tr('Perubahan oleh Damar di sesi ini:', 'Changes by Damar in this session:') + '\n' + [...files].map(([p, s]) => `  ${p}  +${s.a} -${s.r}`).join('\n') };
  }
  if (name === 'sandbox') {
    if (!client) throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');
    const r = await client.r9('/api/r9/sandbox');
    if (!r.ok || !r.body?.data) throw Error('SANDBOX_STATUS_UNAVAILABLE');
    const d = r.body.data;
    return { text: [tr('Workspace: ', 'Workspace: ') + workspace(), tr('Dilindungi: ', 'Protected: ') + d.protectedRoots, tr('Tulis: ', 'Writes: ') + d.writes,
      tr('Perintah: ', 'Commands: ') + d.commands.join(' · '), tr('Isolasi proses: ', 'Process containment: ') + d.containment, tr('Jaringan: ', 'Network: ') + d.network, tr('Persetujuan: ', 'Approvals: ') + d.approvals].join('\n') };
  }
  if (name === 'export') {
    if (!profile) throw Error('PRIVATE_PROFILE_REQUIRED');
    const dir = path.join(profile, 'exports'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `damar-session-${String(client?.sessionId || 'local').slice(0, 8)}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.md`);
    const body = ['# DAMAR session transcript', '', `Workspace: ${workspace()}`, ''];
    for (const m of rl.messages) body.push(m.role === 'user' ? `**You:** ${m.text}` : String(m.text || ''), '');
    fs.writeFileSync(file, body.join('\n'), { flag: 'wx' });
    return { text: tr('Transkrip diekspor ke ', 'Transcript exported to ') + file };
  }
  return null;
}
module.exports = { runTurn, workspace, localCommand, runLocal };
