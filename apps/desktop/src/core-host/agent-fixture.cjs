'use strict';
// Deterministic agent FIXTURE for offline pipeline verification (no model, no network, no cost).
// It stands in for a provider: it reads the OpenAI-format conversation, picks the next step from the conversation
// state (the latest user task plus the tool results that followed it) and answers with tool calls or text built from
// those REAL tool results. It does not understand arbitrary tasks; recognised task shapes are listed in TASKS and any
// other input gets an honest "offline fixture" reply. A live provider replaces it once the Owner authorizes inference.
const path = require('node:path');

const TASKS = [
  // Payload probes (verification of what the provider actually receives): earlier user turns, or a token anywhere.
  ['probe', /\bprobe payload for ([A-Z0-9-]{6,40})\b/],
  ['skillprobe', /\bskillrouteprobe\b/i],
  ['recall', /\b(what did i ask|apa yang (?:saya|tadi) (?:tanyakan|minta))\b/i],
  ['remember', /\b(?:remember that|ingat(?:lah)? bahwa|catat bahwa)\s+(.{3,300})/i],
  ['delegate', /\b(pandawa|sub-?agent|delegasi(?:kan)?|delegate)\b/i],
  ['explain', /\b(explain|jelaskan|describe|what is this|apa isi|ringkas(?:kan)? proyek)\b/i],
  ['review', /\b(review|tinjau|code review)\b/i],
  ['create', /\b(create|buat(?:kan)?|tulis(?:kan)?|write)\b.*\b(python|script|skrip|\.py)\b/i],
  ['fix', /\b(fix|perbaiki|bug|failing|gagal|run the tests|jalankan (?:tes|test))\b/i],
];
// Demo bug patterns the fixture can repair (a real model would reason; the fixture only applies these known rules).
const FIX_RULES = [
  { find: 'return a - b', replace: 'return a + b', why: 'add() subtracted instead of adding' },
  { find: 'return total / len(values) + 1', replace: 'return total / len(values)', why: 'average() added 1 to the mean' },
];

const text = m => typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(p => p?.text || '').join('') : '';
// Core wraps prompt context and tool results in [[DAMAR:<KIND> <id>]] ... [[/DAMAR:<KIND> <id>]] envelopes: the user task is
// the text outside the envelopes; a tool result is the payload after the envelope's header line.
const ENVELOPE = /\[\[DAMAR:([A-Z_]+) ([a-f0-9]+)\]\][\s\S]*?\[\[\/DAMAR:\1 \2\]\]/g;
const userText = m => text(m).replace(ENVELOPE, '').trim();
const toolText = m => { const t = text(m), x = /^\[\[DAMAR:TOOL ([a-f0-9]+)\]\][^\n]*\n([\s\S]*)\n\[\[\/DAMAR:TOOL \1\]\]\s*$/.exec(t); return x ? x[2] : t; };
const parseArgs = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const parsed = r => { try { return JSON.parse(r); } catch { return null; } };
const lang = task => /\b(jelaskan|perbaiki|buat|tinjau|jalankan|tulis|apa|proyek|delegasi)\b/i.test(task) ? 'id' : 'en';

// Conversation state after the latest user message: the tool calls made and their results, in order.
function stateOf(messages) {
  let start = -1;
  messages.forEach((m, i) => { if (m?.role === 'user') start = i; });
  const task = start >= 0 ? userText(messages[start]) : '';
  const steps = [];
  for (const m of messages.slice(start + 1)) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) steps.push({ id: c.id, name: c.function?.name, args: parseArgs(c.function?.arguments), result: null });
    if (m?.role === 'tool') { const s = steps.find(x => x.id === m.tool_call_id); if (s) s.result = toolText(m); }
  }
  return { task, steps };
}

let callSeq = 0;
const call = (name, args) => ({ id: 'call_fx_' + (++callSeq).toString(36) + '_' + name, name, arguments: JSON.stringify(args) });
const resultOf = (steps, name, n = 0) => steps.filter(s => s.name === name)[n]?.result ?? null;

// Returns { toolCalls: [...] } or { content: '...' }. `offered` = Set of tool names present in the request.
function baseStep(messages, offered) {
  const { task, steps } = stateOf(messages);
  const kind = (TASKS.find(([, re]) => re.test(task)) || ['chat'])[0];
  const t = (id, en) => (lang(task) === 'id' ? id : en);
  if (kind === 'recall') {
    const earlier = messages.filter(m => m?.role === 'user').slice(0, -1).map(userText).filter(Boolean);
    return { content: earlier.length ? t('Sebelumnya di sesi ini Anda meminta: ', 'Earlier in this session you asked: ') + earlier.map((x, i) => `${i + 1}) ${x.slice(0, 120)}`).join(' ')
      : t('Belum ada permintaan sebelumnya di sesi ini.', 'Nothing earlier in this session.') };
  }
  if (kind === 'probe') {
    const token = TASKS[0][1].exec(task)[1], latest = messages.map(m => m?.role).lastIndexOf('user');
    // Earlier probe requests/answers name the token themselves; only other content counts.
    const hits = messages.filter((m, i) => i !== latest && JSON.stringify(m).includes(token) && !/probe payload for|Payload probe /.test(userText(m) || text(m))).length;
    return { content: `Payload probe ${token}: found in ${hits} earlier message(s).` };
  }
  if (kind === 'skillprobe') {
    const routed = messages.some(m => m?.role === 'system' && text(m).includes('ROUTED_SKILL_MARKER_42'));
    return { content: routed ? 'ROUTED_SKILL_PRESENT' : 'ROUTED_SKILL_ABSENT' };
  }
  if (kind === 'remember') {
    if (!offered.has('project_memory_add')) return { content: t('Fixture offline: tool memori proyek tidak ditawarkan.', 'Offline fixture: the project memory tool was not offered.') };
    const note = /\b(?:remember that|ingat(?:lah)? bahwa|catat bahwa)\s+(.{3,300})/i.exec(task)[1].trim();
    const step = steps.find(s => s.name === 'project_memory_add');
    if (!step) return { toolCalls: [call('project_memory_add', { text: note })] };
    const r = parsed(step.result) || {};
    return { content: r.ok ? t(`Disimpan ke memori proyek: ${note}`, `Saved to project memory: ${note}`) : t('Catatan tidak disimpan: ', 'The note was not saved: ') + (r.error || step.result) };
  }
  const missing = ['workspace_list', 'workspace_read'].filter(n => !offered.has(n));
  if (kind !== 'chat' && missing.length) return { content: t('Fixture offline: tool berikut tidak ditawarkan oleh runtime: ', 'Offline fixture: the runtime did not offer these tools: ') + missing.join(', ') };

  if (kind === 'explain' || kind === 'review') {
    if (!steps.length) return { toolCalls: [call('workspace_list', { path: '.' })] };
    const files = ((parsed(resultOf(steps, 'workspace_list')) || {}).entries || []).filter(e => e.type === 'file').map(e => e.name);
    const reads = steps.filter(s => s.name === 'workspace_read');
    const pick = ['README.md', 'readme.md', 'main.py', 'app.py', 'index.js', 'calc.py'].find(f => files.includes(f)) || files.find(f => /\.(py|js|md|txt)$/.test(f));
    if (!reads.length && pick) return { toolCalls: [call('workspace_read', { path: pick })] };
    if (kind === 'review' && !steps.some(s => s.name === 'workspace_grep') && offered.has('workspace_grep')) return { toolCalls: [call('workspace_grep', { pattern: 'TODO|FIXME|XXX', path: '.' })] };
    const read = parsed(reads[0]?.result) || {};
    const head = String(read.content || '').split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / ');
    if (kind === 'explain') return { content: [
      t(`Proyek ini berisi ${files.length} file di root: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', ...' : ''}.`, `This project has ${files.length} files at the root: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', ...' : ''}.`),
      pick ? t(`Saya membaca ${pick} (${read.lines ?? '?'} baris). Awalnya: ${head || '(kosong)'}`, `I read ${pick} (${read.lines ?? '?'} lines). It starts with: ${head || '(empty)'}`) : t('Tidak ada file teks yang bisa dibaca.', 'No readable text file found.'),
      t('(Jawaban fixture offline: dibuat dari hasil tool di atas, bukan oleh model.)', '(Offline fixture answer: built from the tool results above, not by a model.)')].join('\n') };
    const grep = parsed(resultOf(steps, 'workspace_grep')) || { matches: [] };
    return { content: [
      t(`Tinjauan ${pick || 'workspace'}: ${read.lines ?? '?'} baris.`, `Review of ${pick || 'the workspace'}: ${read.lines ?? '?'} lines.`),
      grep.matches.length ? t(`Penanda yang perlu ditindaklanjuti (${grep.matches.length}): `, `Markers to follow up (${grep.matches.length}): `) + grep.matches.slice(0, 6).map(m => `${m.path}:${m.line}`).join(', ') : t('Tidak ada penanda TODO/FIXME.', 'No TODO/FIXME markers.'),
      t('(Jawaban fixture offline, dibuat dari hasil tool.)', '(Offline fixture answer, built from the tool results.)')].join('\n') };
  }

  if (kind === 'create') {
    const target = /\b([A-Za-z]:[\\/](?:[^\s"'<>|?*]+[\\/])*[^\s"'<>|?*]+\.py)\b/.exec(task)?.[1] || (/\b([\w-]+\.py)\b/.exec(task) || [, 'hello.py'])[1];
    const name = path.basename(target);
    const write = steps.find(s => s.name === 'workspace_write');
    if (!write) return { toolCalls: [call('workspace_write', { path: target, content: 'def main():\n    print("Halo dari DAMAR")\n\n\nif __name__ == "__main__":\n    main()\n' })] };
    const w = parsed(write.result) || {};
    if (!w.ok) return { content: t(`File ${name} tidak dibuat: ${w.error || write.result}.`, `${name} was not created: ${w.error || write.result}.`) };
    const run = steps.find(s => s.name === 'workspace_run');
    if (!run) return { toolCalls: [call('workspace_run', { command: 'python', args: [target] })] };
    const r = parsed(run.result) || {};
    return { content: r.ok ? t(`Saya membuat ${name} dan menjalankannya: keluaran "${String(r.stdout || '').trim()}" (exit ${r.exitCode}).`, `I created ${name} and ran it: output "${String(r.stdout || '').trim()}" (exit ${r.exitCode}).`)
      : t(`${name} dibuat, tetapi tidak dijalankan: ${r.error || 'exit ' + r.exitCode}.`, `${name} was created but not run: ${r.error || 'exit ' + r.exitCode}.`) };
  }

  if (kind === 'fix') {
    const runs = steps.filter(s => s.name === 'workspace_run');
    if (!runs.length) return { toolCalls: [call('workspace_run', { command: 'python', args: ['-m', 'unittest'] })] };
    const first = parsed(runs[0].result) || {};
    if (runs.length === 1 && first.error) return { content: t(`Tes tidak dapat dijalankan: ${first.error}.`, `The tests could not be run: ${first.error}.`) };
    if (runs.length === 1 && first.exitCode === 0) return { content: t('Semua tes lulus; tidak ada yang perlu diperbaiki.', 'All tests pass; nothing to fix.') };
    const out = String(first.stdout || '') + String(first.stderr || '');
    // The module under test: a non-test .py file named in the output, else test_<name>.py -> <name>.py.
    const named = [...out.matchAll(/([\w./\\-]+\.py)/g)].map(m => m[1]);
    const testOf = /test_(\w+)\.py/.exec(out);
    const target = named.find(f => !/^test_/.test(path.basename(f))) || (testOf ? testOf[1] + '.py' : null);
    const reads = steps.filter(s => s.name === 'workspace_read');
    if (!reads.length && target) return { toolCalls: [call('workspace_read', { path: target })] };
    const content = String((parsed(reads[0]?.result) || {}).content || '');
    const rule = FIX_RULES.find(r => content.includes(r.find));
    const edits = steps.filter(s => s.name === 'workspace_edit');
    if (!edits.length) {
      if (!rule) return { content: t('Tes gagal, tetapi fixture offline tidak mengenali perbaikannya. Keluaran tes:\n', 'Tests fail, but the offline fixture does not recognise a fix. Test output:\n') + out.slice(-800) };
      return { toolCalls: [call('workspace_edit', { path: reads[0].args.path, old: rule.find, new: rule.replace })] };
    }
    const e = parsed(edits[0].result) || {};
    if (!e.ok) return { content: t(`Perubahan tidak diterapkan: ${e.error || edits[0].result}.`, `The change was not applied: ${e.error || edits[0].result}.`) };
    if (runs.length === 1) return { toolCalls: [call('workspace_run', { command: 'python', args: ['-m', 'unittest'] })] };
    const second = parsed(runs[1].result) || {};
    return { content: second.exitCode === 0
      ? t(`Diperbaiki: ${rule?.why ?? 'perubahan diterapkan'} (${reads[0].args.path}). Tes dijalankan ulang dan lulus.`, `Fixed: ${rule?.why ?? 'change applied'} (${reads[0].args.path}). Tests re-run and pass.`)
      : t('Perubahan diterapkan, tetapi tes masih gagal:\n', 'Change applied, but tests still fail:\n') + (second.error ? second.error + ' ' : '') + (String(second.stdout || '') + String(second.stderr || '')).slice(-600) };
  }

  if (kind === 'delegate') {
    if (!offered.has('pandawa_delegate')) return { content: t('Fixture offline: tool delegasi Pandawa tidak ditawarkan.', 'Offline fixture: the Pandawa delegation tool was not offered.') };
    const d = steps.find(s => s.name === 'pandawa_delegate');
    // "in parallel" / "paralel": a security review and a test review at the same time (two Pandawa runs).
    if (!d && /\b(parallel|paralel|bersamaan)\b/i.test(task)) return { toolCalls: [call('pandawa_delegate', { tasks: [{ worker: 'janaka', task: 'Security review: ' + task.slice(0, 160) }, { worker: 'sadewa', task: 'Test review: ' + task.slice(0, 160) }] })] };
    if (!d) return { toolCalls: [call('pandawa_delegate', { worker: /security|keamanan/i.test(task) ? 'janaka' : 'sadewa', task: task.slice(0, 200) })] };
    const r = parsed(d.result) || {};
    if (r.parallel) return { content: t('Sub-agent berjalan paralel: ', 'Sub-agents ran in parallel: ') + r.results.map(x => `${x.worker} ${x.state === 'COMPLETED' ? t('selesai', 'finished') : x.state}`).join(', ') + '. ' + r.results.filter(x => x.output).map(x => `${x.worker}: ${String(x.output).slice(0, 120)}`).join(' | ') };
    if (!r.state) return { content: t('Delegasi tidak dijalankan: ', 'Delegation did not run: ') + (r.error || d.result) };
    return { content: r.state === 'COMPLETED' ? t(`Sub-agent ${r.worker} selesai. Hasilnya: ${String(r.output || '').slice(0, 300)}`, `Sub-agent ${r.worker} finished. Its result: ${String(r.output || '').slice(0, 300)}`)
      : t(`Sub-agent ${r.worker} berakhir dengan status ${r.state}${r.error ? ' (' + r.error + ')' : ''}.`, `Sub-agent ${r.worker} ended with status ${r.state}${r.error ? ' (' + r.error + ')' : ''}.`) };
  }

  return { content: t('Ini fixture offline DAMAR (tanpa model live). Pesan Anda diterima. Tugas yang dikenali: jelaskan proyek, tinjau kode, buat script Python, perbaiki bug / jalankan tes, delegasi ke Pandawa.',
    'This is the DAMAR offline fixture (no live model). Your message was received. Recognised tasks: explain the project, review code, create a Python script, fix a bug / run the tests, delegate to Pandawa.') };
}

// Live plan (the design's sidebar Plan x/N): for multi-step tasks the fixture states its plan with the read-only
// plan_update tool before each step, derived from the REAL tool results so far; the final state (all done, or the
// interrupted step marked stopped) is reported before the closing answer.
const PLANS = {
  fix: [['Jalankan tes', 'Run the tests'], ['Baca modul yang gagal', 'Read the failing module'], ['Terapkan perbaikan', 'Apply the fix'], ['Jalankan ulang tes', 'Re-run the tests']],
  create: [['Tulis file', 'Write the file'], ['Jalankan file', 'Run the file']],
};
function nextStep(messages, offered) {
  const result = baseStep(messages, offered);
  const { task, steps } = stateOf(messages);
  const kind = (TASKS.find(([, re]) => re.test(task)) || ['chat'])[0];
  if (!PLANS[kind] || !offered.has('plan_update')) return result;
  const ok = name => steps.some(s => s.name === name && (parsed(s.result) || {}).ok);
  const runs = steps.filter(s => s.name === 'workspace_run' && s.result !== null);
  const done = kind === 'fix'
    ? (runs.length >= 2 && (parsed(runs[1].result) || {}).exitCode === 0 ? 4 : ok('workspace_edit') ? 3 : steps.some(s => s.name === 'workspace_read') ? 2 : runs.length ? 1 : 0)
    : (ok('workspace_run') ? 2 : ok('workspace_write') ? 1 : 0);
  const labels = PLANS[kind].map(([id, en]) => (lang(task) === 'id' ? id : en)), total = labels.length;
  const plan = stopped => call('plan_update', { steps: labels.map((label, i) => ({ label, state: i < done ? 'done' : i === done ? (stopped ? 'stopped' : 'active') : 'pending' })) });
  if (result.toolCalls) return { toolCalls: [plan(false), ...result.toolCalls] };
  const last = steps.filter(s => s.name === 'plan_update').at(-1)?.args?.steps || [];
  const terminal = last.length && (last.every(s => s.state === 'done') || last.some(s => s.state === 'stopped'));
  if (!terminal && steps.length) return { toolCalls: [plan(done < total)] };
  return result;
}
module.exports = { nextStep, stateOf, FIX_RULES };
