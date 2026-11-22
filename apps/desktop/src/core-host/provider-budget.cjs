'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Per-Core-session runaway guards (not product limits); Owner grants may set tighter ones.
const MAX_COMPLETIONS = 10000, MAX_OUTPUT = 32768, MAX_TOTAL = 50000000;
// Tokenizer-free upper bound: byte-level BPE emits at most one token per UTF-8 byte, and JSON
// escaping only adds bytes; plus chat-template overhead per message. Inline (data:) images are
// bounded by their base64 size; remote image URLs cannot be bounded, so they are refused (null).
function byteInputBound(body, provider) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || /"url"\s*:\s*"(?!data:)/.test(JSON.stringify(messages))) return null;
  const counted = { messages, tools: body.tools, tool_choice: body.tool_choice, response_format: body.response_format };
  return Buffer.byteLength(JSON.stringify(counted), 'utf8') + 16 * messages.length + 64 + injectedTokens(provider);
}
// Routers/gateways may inject hidden prompt text the client never sees. Each connection carries its own allowance
// (default 4096); a request that exceeds it is flagged (boundExceeded) so the Owner can raise the allowance.
const { DEFAULT_INJECTED_TOKENS } = require('./provider-registry.cjs');
const injectedTokens = p => Number.isSafeInteger(p?.injectedTokens) && p.injectedTokens >= 0 ? p.injectedTokens : DEFAULT_INJECTED_TOKENS;
function readUsage(value) {
  const usage = value?.usage;
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0 ? { input, output } : null;
}
function createProviderBudget({ file, httpClient, turnContext, provider, ledger: sharedLedger = null, limits = {}, inputTokenBound = null }) {
  const maxCompletions = limits.completions ?? MAX_COMPLETIONS;
  const maxOutput = limits.maxTokens ?? MAX_OUTPUT;
  const maxTotal = limits.totalTokens ?? MAX_TOTAL;
  if (!path.isAbsolute(file) || !httpClient || !turnContext || typeof provider !== 'function') throw new TypeError('PROVIDER_BUDGET_DEPENDENCY_INVALID');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ledger = sharedLedger || [];
  // Concurrent accounting: every request reserves an upper bound (input bound + max output) against the shared budgets;
  // settling replaces it with the provider-reported usage. A request whose usage is lost is charged its reserved upper
  // bound and marked uncertain: only that request (never the whole meter) is affected. `blocked` = the ledger file
  // itself cannot be written (nothing can be recorded, so nothing may run).
  let attempts = 0, total = 0, inFlight = 0, open = 0, blocked = false, uncertain = 0, boundExceeded = 0, estimated = 0;
  // Learned per provider/model: does it report usage? Models that never do are metered by a conservative estimate.
  const usageReporting = new Map();
  const recentUncertain = [];
  const reservations = new Map();
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text && !text.endsWith('\n')) throw Error('PROVIDER_USAGE_LEDGER_CORRUPT');
    for (const line of text.split('\n').filter(Boolean)) {
      let row; try { row = JSON.parse(line); } catch { throw Error('PROVIDER_USAGE_LEDGER_CORRUPT'); }
      if (row.event === 'RESERVED') {
        if (!row.reservationId || reservations.has(row.reservationId)) throw Error('PROVIDER_USAGE_LEDGER_CORRUPT');
        reservations.set(row.reservationId, row); attempts++; continue;
      }
      let charge = Number.isSafeInteger(row.reservedTokens) ? row.reservedTokens : 0;
      if (row.event === 'SETTLED') {
        if (!reservations.has(row.reservationId)) throw Error('PROVIDER_USAGE_LEDGER_CORRUPT');
        charge = reservations.get(row.reservationId).reservedTokens || 0;
        reservations.delete(row.reservationId);
      } else {
        attempts += 1;
      }
      if (!Number.isSafeInteger(row.inputTokens) || row.inputTokens < 0 || !Number.isSafeInteger(row.outputTokens) || row.outputTokens < 0) { uncertain++; total += Number.isSafeInteger(row.chargedTokens) ? row.chargedTokens : charge; }
      else total += row.inputTokens + row.outputTokens;
    }
    // Interrupted reservations (Core stopped mid-request): charged their upper bound, marked uncertain.
    for (const r of reservations.values()) { uncertain++; total += Number.isSafeInteger(r.reservedTokens) ? r.reservedTokens : 0; }
  }
  const current = () => provider();
  const append = row => {
    let fd;
    try { fd = fs.openSync(file, 'a', 0o600); fs.writeFileSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); }
    catch { blocked = true; throw Error('PROVIDER_USAGE_STORE_UNAVAILABLE'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const exhausted = () => { throw Object.assign(Error('LIVE_INFERENCE_BUDGET_EXHAUSTED'), { code: 'LIVE_INFERENCE_BUDGET_EXHAUSTED' }); };
  // p: the dispatch target (default: the active selection); extra: attribution copied onto the ledger row.
  // Synchronous check-and-reserve: Node runs it atomically, so concurrent requests can never over-commit a budget.
  const reserve = (url, options, p = current(), extra = {}) => {
    if (p?.kind !== 'live') return null;
    if (!p.executable) throw Object.assign(Error(p.reason || 'LIVE_INFERENCE_NOT_AUTHORIZED'), { code: p.reason || 'LIVE_INFERENCE_NOT_AUTHORIZED' });
    if (blocked) throw Object.assign(Error('PROVIDER_USAGE_METER_UNAVAILABLE'), { code: 'PROVIDER_USAGE_METER_UNAVAILABLE' });
    if (p.limits && attempts >= p.limits.completions) exhausted();
    if (attempts >= maxCompletions) exhausted();
    const u = new URL(url);
    if (!['/chat/completions', '/completions', '/embeddings'].some(x => u.origin + u.pathname === String(p.baseUrl || '').replace(/\/$/, '') + x)) throw Object.assign(Error('PROVIDER_ROUTE_MISMATCH'), { code: 'PROVIDER_ROUTE_MISMATCH' });
    let body = options?.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { throw Error('PROVIDER_REQUEST_INVALID'); } }
    if (!body || typeof body !== 'object' || body.model !== p.model) throw Object.assign(Error('PROVIDER_MODEL_ROUTE_MISMATCH'), { code: 'PROVIDER_MODEL_ROUTE_MISMATCH' });
    const requested = body.max_tokens;
    // Scoped grants cannot use a guessed tokenizer or output-only count as a total-token bound: they require a Core-owned
    // authoritative input upper bound. Unscoped requests use it when available, to reserve concurrently.
    const inputBound = typeof inputTokenBound === 'function' ? inputTokenBound(body, p) : null;
    if (p.limits && (!Number.isSafeInteger(inputBound) || inputBound < 0)) throw Error('PROVIDER_INPUT_TOKEN_BOUND_REQUIRED');
    const outputLimit = Math.min(maxOutput, p.limits?.maxTokens ?? maxOutput);
    body = { ...body, max_tokens: Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, outputLimit) : outputLimit };
    const reservedTokens = (Number.isSafeInteger(inputBound) ? inputBound : 0) + body.max_tokens;
    const totalLimit = Math.min(maxTotal, p.limits?.totalTokens ?? maxTotal);
    if (total + inFlight + reservedTokens > totalLimit) exhausted();
    const turn = turnContext.getStore();
    const id = require('node:crypto').randomUUID();
    // p.billed: the connection + model that actually serve this request (a Pandawa member route), when it differs.
    const billed = p.billed || p;
    append({ event: 'RESERVED', reservationId: id, t: new Date().toISOString(), provider: billed.id, model: billed.model, reservedTokens });
    attempts += 1; inFlight += reservedTokens; open++;
    const row = { ...extra, responseId: id, provider: billed.id, model: billed.model, turnId: turn?.id || null, lastUser: lastUser(body.messages), tools: Array.isArray(body.tools) ? body.tools.length : 0,
      inputBound, outputLimit: body.max_tokens, reservedTokens, totalLimit, status: 'IN_FLIGHT', usageReported: false, promptTokens: null, completionTokens: null };
    ledger.push(row);
    return { body, row };
  };
  // usage null + outputText known (a model that reports no usage): conservative estimate = Core's input upper bound +
  // the output's UTF-8 byte count (>= its token count), capped by max_tokens; marked estimated. usage null otherwise
  // (lost): charge the reservation's upper bound, mark this request uncertain. Neither stops other requests.
  const finish = (row, usage, status, outputText) => {
    if (row.status !== 'IN_FLIGHT') return false;
    row.status = status; inFlight -= row.reservedTokens; open--;
    if (/^(COMPLETED|UNKNOWN_USAGE)/.test(status)) usageReporting.set(row.provider + '/' + row.model, usage ? 'reports' : 'missing');
    let charged = null, isEstimate = false;
    if (!usage && typeof outputText === 'string' && Number.isSafeInteger(row.inputBound)) {
      usage = { input: row.inputBound, output: Math.min(row.outputLimit, Buffer.byteLength(outputText, 'utf8')) };
      isEstimate = true; row.estimated = true; estimated++; row.status = status = 'ESTIMATED';
    }
    if (usage) {
      row.usageReported = !isEstimate; row.promptTokens = usage.input; row.completionTokens = usage.output;
      total += usage.input + usage.output;
      if (!isEstimate && row.inputBound !== null && usage.input > row.inputBound) { row.boundExceeded = true; boundExceeded++; }
    } else {
      charged = row.reservedTokens; total += charged; row.uncertain = true; uncertain++;
      recentUncertain.push({ t: new Date().toISOString(), provider: row.provider, model: row.model, status, chargedTokens: charged, ...(row.gatewayKey ? { gatewayKey: row.gatewayKey } : {}) });
      if (recentUncertain.length > 20) recentUncertain.shift();
    }
    append({ event: 'SETTLED', reservationId: row.responseId, t: new Date().toISOString(), provider: row.provider, model: row.model, status: row.status,
      inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null, totalTokens: usage ? usage.input + usage.output : null, ...(charged !== null ? { chargedTokens: charged } : {}), ...(isEstimate ? { estimated: true } : {}) });
    return Boolean(usage) && total <= row.totalLimit;
  };
  // Statuses that are refusals before generation by spec: settled as zero tokens (failover never costs budget).
  // A 5xx that reports usage is recorded; any other non-2xx without usage is uncertain for that request.
  const PRE_GENERATION = new Set([400, 401, 403, 404, 413, 422, 429]);
  const statusOf = error => { const m = /^(\d{3})\b/.exec(String(error?.message || '')); return m ? Number(m[1]) : null; };
  const usageIn = text => { try { return readUsage(typeof text === 'string' ? JSON.parse(text) : text); } catch { return null; } };
  const settleRefusal = (row, status, data) => {
    if (PRE_GENERATION.has(status)) return finish(row, { input: 0, output: 0 }, `HTTP_${status}_REFUSED`);
    const usage = usageIn(data);
    return finish(row, usage, usage ? `HTTP_${status}_WITH_USAGE` : `HTTP_${status || 'ERROR'}_UNCERTAIN`);
  };
  // send(url, options) -> HttpClient-shaped response { success, status, data }.
  const meteredPost = async (p, url, options, send, extra) => {
    const req = reserve(url, options, p, extra); const requestOptions = { ...options, body: req.body };
    let response;
    try { response = await send(url, requestOptions); }
    catch (error) { finish(req.row, null, 'FAILED_UNCERTAIN'); throw error; }
    if (!response?.success) { settleRefusal(req.row, response?.status, response?.data); return response; }
    const usage = readUsage(response.data);
    finish(req.row, usage, usage ? 'COMPLETED' : 'UNKNOWN_USAGE', usage ? undefined : outputOf(response.data));
    // The answer was generated (and is paid for) either way: it is returned; the next reservation sees the new total.
    return response;
  };
  // send(url, options) -> ReadableStream of SSE bytes, or throws `${status} ...` (error.detail: body) for a refusal.
  const meteredStream = async (p, url, options, send, extra) => {
    const req = reserve(url, options, p, extra);
    let stream;
    try { stream = await send(url, { ...options, body: req.body }); }
    catch (error) { const st = statusOf(error); if (st) settleRefusal(req.row, st, error.detail); else finish(req.row, null, 'FAILED_UNCERTAIN'); throw error; }
    const reader = stream.getReader(), decoder = new TextDecoder(); let pending = '', usage = null, text = '';
    const settle = (status, complete = false) => finish(req.row, usage, status, complete ? text : undefined);
    return new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) { settle(usage ? 'COMPLETED' : 'UNKNOWN_USAGE', true); controller.close(); return; }
          pending += decoder.decode(part.value, { stream: true });
          const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
          for (const line of lines) if (line.startsWith('data:')) {
            const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') continue;
            try { const chunk = JSON.parse(raw); usage = readUsage(chunk) || usage; text += outputOf(chunk, true); } catch {}
          }
          controller.enqueue(part.value);
        } catch (error) { settle(usage ? 'COMPLETED_PARTIAL' : 'FAILED_UNCERTAIN'); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { settle(usage ? 'CANCELLED_WITH_USAGE' : 'CANCELLED_UNCERTAIN'); } },
    });
  };
  const originalPost = httpClient.post;
  if (!originalPost.__damarProviderBudget) {
    const wrapped = async function (url, options = {}) {
      if (current()?.kind !== 'live') return originalPost.call(this, url, options);
      return meteredPost(current(), url, options, (u, o) => originalPost.call(this, u, o));
    };
    wrapped.__damarProviderBudget = true; httpClient.post = wrapped;
  }
  const originalStream = httpClient.stream;
  if (!originalStream.__damarProviderBudget) {
    const wrapped = async function (url, options = {}) {
      if (current()?.kind !== 'live') return originalStream.call(this, url, options);
      return meteredStream(current(), url, options, (u, o) => originalStream.call(this, u, o));
    };
    wrapped.__damarProviderBudget = true; httpClient.stream = wrapped;
  }
  // External dispatch (DAMAR gateway, provider tests): same meter, ledger and caps with an explicit target p
  // ({ kind:'live', id, baseUrl, model, executable, limits, injectedTokens }) and attribution `extra`.
  const run = ({ p, url, options, stream = false, send, extra = {} }) => (stream ? meteredStream : meteredPost)({ ...p, kind: 'live' }, url, options, send, extra);
  return Object.freeze({ ledger, run, view: () => ({ attempts, totalTokens: total, inFlight: open, reservedTokens: inFlight, uncertain, estimated, boundExceeded, recentUncertain: [...recentUncertain],
    usageReporting: Object.fromEntries(usageReporting), blocked, limits: { completions: maxCompletions, maxTokens: maxOutput, totalTokens: maxTotal } }) });
}
// Generated text of a chat/completions response or stream chunk (content, reasoning, tool-call arguments).
function outputOf(value, delta = false) {
  const choices = Array.isArray(value?.choices) ? value.choices : [];
  return choices.map(c => { const m = delta ? c?.delta : c?.message; const parts = [m?.content, m?.reasoning_content, m?.reasoning, c?.text];
    for (const t of Array.isArray(m?.tool_calls) ? m.tool_calls : []) parts.push(t?.function?.name, t?.function?.arguments);
    return parts.filter(x => typeof x === 'string').join(''); }).join('');
}
function lastUser(messages) {
  const row = Array.isArray(messages) ? [...messages].reverse().find(m => m?.role === 'user') : null;
  const content = typeof row?.content === 'string' ? row.content : Array.isArray(row?.content) ? row.content.filter(x => x?.type === 'text').map(x => x.text).join(' ') : '';
  return String(content).slice(0, 2000);
}

module.exports = { createProviderBudget, readUsage, byteInputBound, MAX_COMPLETIONS, MAX_OUTPUT, MAX_TOTAL };
