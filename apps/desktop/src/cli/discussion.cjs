'use strict';
// Pandawa team discussion from the CLI: `/discuss <topic>` (debate: rounds, then DAMAR's synthesis with Decision /
// Rationale / Dissent) and `/delegate worker: task; worker: task` (parallel subtasks, DAMAR merges). Core runs the
// discussion (POST /api/r9/pandawa/discussions); the CLI renders its live events, sends Owner interjections typed while
// it runs, and asks Core to stop it on Esc. `/team` shows which model each member uses.
const MEMBERS = ['puntadewa', 'werkudara', 'janaka', 'nakula', 'sadewa'];
const label = m => m ? (m.connection ? m.connection + '/' : '') + (m.model || '?') + (m.assigned ? '' : ' (active)') : '?';

// Parse the command line. Returns null when the line is not a team command.
function discussCommand(line) {
  const m = /^\/?(discuss|delegate|team)(?:\s+([\s\S]{0,4000}))?$/i.exec(String(line).trim());
  if (!m) return null;
  const name = m[1].toLowerCase(), args = (m[2] || '').trim();
  if (name === 'team' || !args) return { name: 'team' };
  if (name === 'discuss') return { name, mode: 'debate', topic: args };
  const tasks = args.split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf(':'); return { worker: s.slice(0, i).trim().toLowerCase(), task: s.slice(i + 1).trim() }; });
  if (!tasks.length || tasks.some(t => !MEMBERS.includes(t.worker) || !t.task)) return { name, error: 'DELEGATE_USAGE' };
  return { name, mode: 'delegate', topic: tasks.map(t => t.worker + ': ' + t.task).join('; ').slice(0, 4000), tasks };
}

// Member -> model (null assignment = DAMAR's model or the active provider), from Core.
async function teamText(client, tr) {
  const r = await client.r9('/api/r9/pandawa/discussions');
  if (!r.ok || !r.body?.data) throw Error(r.body?.error || 'PANDAWA_TEAM_UNAVAILABLE');
  const { settings } = r.body.data, models = settings.models || {};
  const line = m => `  ${m.padEnd(10)} -> ${models[m] || (m === 'damar' ? tr('provider aktif', 'active provider') : tr('model DAMAR', "DAMAR's model"))}`;
  return [tr('Tim Pandawa (ubah di DAMAR Control > Settings):', 'Pandawa team (change in DAMAR Control > Settings):'), line('damar'), ...MEMBERS.map(line),
    tr(`Diskusi: maks ${settings.discussion.maxRounds} ronde, anggaran ${settings.discussion.tokenBudget} token.`, `Discussions: up to ${settings.discussion.maxRounds} rounds, budget ${settings.discussion.tokenBudget} tokens.`),
    tr('Mulai: /discuss <topik>  ·  /delegate janaka: tugas; sadewa: tugas', 'Start: /discuss <topic>  ·  /delegate janaka: task; sadewa: task')].join('\n');
}

async function runDiscussion({ client, clientId, rl, command, signal, tr }) {
  const body = { cliSession: client.sessionId, client: clientId, mode: command.mode, topic: command.topic, ...(command.tasks ? { tasks: command.tasks } : {}) };
  const start = await client.r9('/api/r9/pandawa/discussions', { method: 'POST', role: 'owner', body, signal });
  if (!start.ok || start.body?.success !== true || !/^disc_[a-f0-9]{32}$/.test(start.body.data?.discussionId || '')) throw Error(/^[A-Z_]{3,60}$/.test(start.body?.error || '') ? start.body.error : 'DISCUSSION_START_FAILED');
  const d = start.body.data, id = d.discussionId, route = `/api/r9/pandawa/discussions/${id}`;
  const add = entry => { rl.messages.push(entry); if (rl.messages.length > 200) { rl.messages.shift(); rl.clearSelection = true; } rl.render(); return entry; };
  const post = (action, extra = {}) => client.r9(`${route}/${action}`, { method: 'POST', role: 'owner', body: { cliSession: client.sessionId, client: clientId, ...extra } });
  const cancel = () => { post('cancel').catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  rl.discussion = { id, interject: async text => { const r = await post('interject', { text }); if (!r.ok) throw Error(r.body?.error || 'INTERJECT_FAILED'); add({ role: 'user', text: tr('Anda (sela): ', 'You (interjection): ') + text }); } };
  add({ role: 'assistant', kind: 'notice', text: (d.mode === 'delegate' ? tr('Delegasi Pandawa', 'Pandawa delegation') : tr('Diskusi Pandawa', 'Pandawa discussion')) + ' · ' +
    ['damar', ...d.members].map(m => m + ' -> ' + label(d.models?.[m])).join(', ') + tr(' · ketik untuk menyela, Esc untuk berhenti', ' · type to interject, Esc to stop') });
  let of = d.maxRounds, final = null;
  try {
    final = await client.discussionEvents(id, async e => {
      if (e.type === 'round') { of = e.of || of; add({ role: 'assistant', kind: 'notice', text: tr(`Ronde ${e.round}/${of}`, `Round ${e.round}/${of}`) }); }
      else if (e.type === 'message') add({ role: 'assistant', kind: 'response', streaming: false, pending: false, text: `[${e.member} · ${tr('ronde', 'round')} ${e.round}/${of}] ${String(e.text || '').slice(0, 4000)}` });
      else if (e.type === 'member_error') add({ role: 'assistant', kind: 'notice', text: `${e.member || '?'}: ${tr('tidak menjawab', 'did not reply')} (${e.error})` });
      else if (e.type === 'synthesis') add({ role: 'assistant', kind: 'response', streaming: false, pending: false, text: tr('DAMAR · sintesis (Keputusan / Alasan / Perbedaan pendapat)\n', 'DAMAR · synthesis (Decision / Rationale / Dissent)\n') + String(e.text || '').slice(0, 8000) });
      else if (e.type === 'cancel_requested') add({ role: 'assistant', kind: 'notice', text: tr('Menghentikan diskusi…', 'Stopping the discussion…') });
    }, { signal });
    const t = final?.tokens;
    add({ role: 'assistant', kind: 'notice', text: tr('Diskusi selesai: ', 'Discussion ended: ') + (final?.status || 'UNKNOWN') + (final?.reason ? ' (' + final.reason + ')' : '') + (Number.isSafeInteger(t) ? ` · ${t} ${tr('token', 'tokens')}` : '') });
    return final;
  } finally { rl.discussion = null; signal?.removeEventListener('abort', cancel); }
}

module.exports = { discussCommand, runDiscussion, teamText, MEMBERS };
