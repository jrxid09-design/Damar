'use strict';
// Deterministic OpenAI-compatible OFFLINE provider fixture (loopback only, zero network, zero cost).
// It plays the provider's role so canonical provider code, Pandawa workers and usageService run unmodified.
// Markers in the last user message select behaviour: [fixture:slow:<ms>] [fixture:error] [fixture:nousage]
// [fixture:http:<status>:<ms>] [fixture:think] [fixture:hold:<ms>[:ka]] (agent turns: response headers at once, then
// <ms> of silence, or of SSE keep-alive comments every 15 s with :ka, before the first chunk; gateways that accept the
// request and then think). Delays up to 600 s.
const http = require('node:http'), crypto = require('node:crypto');

function createOfflineProvider({ id, model, models = [model] }) {
  const ledger = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    const chunks = []; let bytes = 0;
    req.on('data', d => { bytes += d.length; if (bytes > 1 << 20) req.destroy(); else chunks.push(d); });
    req.on('end', () => {
      const send = (status, body) => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
      if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: models.map(m => ({ id: m, object: 'model', owned_by: id })) });
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: { message: 'not found' } });
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: { message: 'invalid json' } }); }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = String(messages.filter(m => m?.role === 'user').pop()?.content ?? '');
      const promptChars = messages.reduce((n, m) => n + String(m?.content ?? '').length, 0);
      const responseId = `${id}-${++seq}`;
      const turnId = /^turn-[a-f0-9-]{36}$/.test(req.headers['x-damar-turn'] || '') ? req.headers['x-damar-turn'] : null;
      const entry = { responseId, turnId, provider: id, model: body.model || model, promptTokens: null, completionTokens: null, usageReported: false, status: 'PENDING', tools: Array.isArray(body.tools) ? body.tools.length : 0, lastUser: last.slice(-4000) };
      ledger.push(entry);
      const slow = /\[fixture:slow:(\d{1,6})\]/.exec(last);
      let closed = false; res.on('close', () => { closed = true; if (entry.status === 'PENDING') entry.status = 'CLIENT_ABORTED'; });
      // Deterministic provider failure after a delay: [fixture:http:<status>:<delayMs>] answers with the OpenAI-style
      // error body real gateways send (quota 402, auth 401, rate limit 429, unavailable 503, ...). No usage is reported.
      const httpFail = /\[fixture:http:(4\d\d|5\d\d):(\d{1,6})\]/.exec(last);
      if (httpFail) return setTimeout(() => {
        if (closed) return;
        const status = Number(httpFail[1]);
        const kinds = { 401: ['authentication_error', 'invalid_api_key', 'Missing API key'], 402: ['billing_error', 'payment_required', 'Provider quota exceeded.'],
          429: ['rate_limit_error', 'rate_limited', 'Rate limit reached, retry later.'], 503: ['service_unavailable', 'overloaded', 'Service temporarily unavailable.'] };
        const [type, code, message] = kinds[status] || ['api_error', 'http_' + status, 'Provider error ' + status];
        entry.status = 'PROVIDER_HTTP_' + status;
        send(status, { error: { message, type, code } });
      }, Math.min(Number(httpFail[2]), 600000));
      // Agent turns (tools offered or streaming requested) are answered by the deterministic agent fixture, in the exact
      // OpenAI wire format (SSE chunks with content deltas and tool_call fragments). Errors are 4xx so the canonical
      // runtime never falls back to a local model.
      const agentTurn = (Array.isArray(body.tools) && body.tools.length > 0) || body.stream === true;
      const hold = body.stream === true && /\[fixture:hold:(\d{1,6})(:ka)?\]/.exec(last);
      let keepAlive = null;
      if (hold) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.flushHeaders();
        if (hold[2]) keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15000); }
      if (agentTurn) return setTimeout(() => {
        clearInterval(keepAlive);
        if (closed) return;
        const offered = new Set((body.tools || []).map(t => t?.function?.name).filter(Boolean));
        let step;
        try { step = require('./agent-fixture.cjs').nextStep(messages, offered); }
        catch (error) { entry.status = 'FIXTURE_ERROR'; return send(422, { error: { message: 'agent fixture failed: ' + String(error.message).slice(0, 120) } }); }
        const toolCalls = step.toolCalls || [];
        // [fixture:think]: the model inlines its reasoning as <think>...</think> (MiniMax / R1 style); the 14-char
        // chunks below split both tags across chunks.
        const content = (/\[fixture:think\]/.test(last) && step.content ? '<think>The user wants a short reply; check the request first.</think>' : '') + (step.content || '');
        const completion = Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4);
        const usage = { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: completion, total_tokens: Math.ceil(promptChars / 4) + completion };
        Object.assign(entry, { status: 'COMPLETED', usageReported: true, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, toolCalls: toolCalls.map(c => c.name) });
        const finish = toolCalls.length ? 'tool_calls' : 'stop';
        if (!body.stream) return send(200, { id: responseId, object: 'chat.completion', created: 0, model: entry.model, usage,
          choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) } }] });
        if (!hold) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const chunk = (delta, finish_reason = null) => ({ id: responseId, object: 'chat.completion.chunk', created: 0, model: entry.model, choices: [{ index: 0, delta, finish_reason }] });
        const events = [];
        for (let i = 0; i < content.length; i += 14) events.push(chunk({ content: content.slice(i, i + 14) }));
        toolCalls.forEach((c, index) => {
          events.push(chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }));
          const half = Math.ceil(c.arguments.length / 2);
          events.push(chunk({ tool_calls: [{ index, function: { arguments: c.arguments.slice(0, half) } }] }));
          events.push(chunk({ tool_calls: [{ index, function: { arguments: c.arguments.slice(half) } }] }));
        });
        events.push(chunk({}, finish));
        events.push({ id: responseId, object: 'chat.completion.chunk', created: 0, model: entry.model, choices: [], usage });
        let i = 0;
        const pump = () => {
          if (closed) return;
          if (i < events.length) { res.write('data: ' + JSON.stringify(events[i++]) + '\n\n'); setTimeout(pump, 22); }
          else res.end('data: [DONE]\n\n');
        };
        pump();
      }, hold ? Math.min(Number(hold[1]), 600000) : slow ? Math.min(Number(slow[1]), 600000) : 5);
      setTimeout(() => {
        if (closed) return;
        if (/\[fixture:error\]/.test(last)) { entry.status = 'PROVIDER_ERROR'; return send(500, { error: { message: 'offline fixture provider error' } }); }
        const content = `Pandawa offline fixture reply (${id}): ${crypto.createHash('sha256').update(last).digest('hex').slice(0, 12)}`;
        const usage = { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: Math.ceil(content.length / 4) };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        const omit = /\[fixture:nousage\]/.test(last);
        Object.assign(entry, { status: 'COMPLETED', usageReported: !omit, promptTokens: omit ? null : usage.prompt_tokens, completionTokens: omit ? null : usage.completion_tokens });
        send(200, { id: responseId, object: 'chat.completion', created: 0, model: entry.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], ...(omit ? {} : { usage }) });
      }, slow ? Math.min(Number(slow[1]), 600000) : 5);
    });
  });
  return {
    id, model, models, ledger,
    start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); }),
    baseUrl: () => `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
module.exports = { createOfflineProvider };
