'use strict';

class ApiError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ApiError'; Object.assign(this, details); }
}

class ApiClient {
  constructor({ baseUrl = 'http://127.0.0.1:3000', fetchImpl = globalThis.fetch, timeoutMs = 10000, session = null, correlationId = () => `ui-${Date.now()}-${Math.random().toString(16).slice(2)}` } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.session = session; this.correlationId = correlationId;
  }
  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new ApiError('fetch unavailable', { kind: 'configuration' });
    const requestId = this.correlationId();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const auth = this.session?.authorizationHeader?.() ?? {};
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json', 'x-request-id': requestId, ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!response.ok) throw new ApiError(data?.message ?? `HTTP ${response.status}`, { status: response.status, kind: response.status === 401 ? 'authentication' : response.status === 403 ? 'authority_denial' : 'network', requestId, data });
      return { data, status: response.status, requestId, headers: response.headers };
    } catch (error) {
      if (error.name === 'AbortError') throw new ApiError('request cancelled or timed out', { kind: 'network', requestId, cause: error });
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.message, { kind: 'network', requestId, cause: error });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort); }
  }
}

module.exports = { ApiClient, ApiError };
