'use strict';
const { normalizeReadModel } = require('./contracts');

class ReadModelClient {
  constructor(api) { this.api = api; }
  async snapshot(path, options = {}) { try { const result = await this.api.request(path, options); const data = result.data; const freshness = data?.freshness ?? 'UNKNOWN'; const status = Array.isArray(data) && data.length === 0 ? 'empty' : data?.degraded ? 'degraded' : freshness === 'STALE' || freshness === 'EVENTUAL' ? 'stale' : freshness === 'UNKNOWN' ? 'unknown' : 'ready'; return normalizeReadModel({ data, status, freshness, asOf: data?.as_of ?? new Date().toISOString(), revision: data?.revision ?? null, provenance: data?.provenance ?? null, requestId: result.requestId }); } catch (error) { return normalizeReadModel({ status: error.kind === 'network' ? 'degraded' : 'failed', freshness: 'UNKNOWN', error: { message: error.message, kind: error.kind } }); } }
}

module.exports = { ReadModelClient };
