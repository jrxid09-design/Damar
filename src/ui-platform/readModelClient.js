'use strict';
const { normalizeReadModel } = require('./contracts');

class ReadModelClient {
  constructor(api) { this.api = api; }
  async snapshot(path, options = {}) { const result = await this.api.request(path, options); return normalizeReadModel({ data: result.data, status: Array.isArray(result.data) && result.data.length === 0 ? 'empty' : 'ready', freshness: result.data?.freshness ?? 'LIVE', asOf: result.data?.as_of ?? new Date().toISOString(), revision: result.data?.revision ?? null, provenance: result.data?.provenance ?? null, requestId: result.requestId }); }
}

module.exports = { ReadModelClient };
