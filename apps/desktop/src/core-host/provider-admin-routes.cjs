'use strict';
// Owner-only admin routes for router-grade providers and the DAMAR gateway (mounted by r9-routes.cjs):
//   GET  /api/r9/provider-admin/state                      connections (masked keys + health), combos, routing, gateway
//   POST /api/r9/provider-admin/keys      { provider, action: 'add', text } | { provider, action: 'set', kid, enabled } | { provider, action: 'delete', kid }
//   POST /api/r9/provider-admin/strategy  { provider, strategy: 'round-robin' | 'fill-first' | 'lru' }
//   POST /api/r9/provider-admin/routing   { cooldownMs?, maxCooldownMs?, maxConcurrency?, maxPerKey? }
//   POST /api/r9/provider-admin/limits    { provider, maxConcurrency | null }
//   POST /api/r9/provider-admin/test      { provider, kind: 'key', kid, model? } | { provider, kind: 'keys' } | { provider, kind: 'model', model }   (model tests spend tokens)
//   POST /api/r9/provider-admin/catalog   { provider, addModel? , removeModel?, alias?: { name, model }, removeAlias? }
//   POST /api/r9/provider-admin/combos    { action: 'set', combo: { id, label?, strategy?, targets: [{ connection, model }] } } | { action: 'delete', id }
//   GET  /api/r9/gateway                                   settings, listener, keys (metadata + usage), config snippets
//   POST /api/r9/gateway  { action: 'settings', enabled?, bind?, port? } | { action: 'create-key', label, models?, limits? } (key shown once)
//                         | { action: 'update-key', id, label?, models?, limits? } | { action: 'revoke-key', id }
// Secrets are write-only: no response ever carries a provider key; a gateway key appears once, in create-key's answer.
const only = (input, allowed) => { if (Object.keys(input).some(k => !allowed.includes(k))) throw Object.assign(Error('PROVIDER_ADMIN_REQUEST_INVALID'), { status: 400 }); };

function createProviderAdminRoutes({ registry, router, gateway, budget = null }) {
  const state = () => { const l = registry.list();
    return { connections: l.providers.filter(p => p.kind === 'live' && !p.virtual).map(p => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, injectedTokens: p.injectedTokens, strategy: p.strategy, maxConcurrency: p.maxConcurrency, keys: p.keys, extraModels: p.extraModels, aliases: p.aliases, grantStatus: p.grantStatus })),
      combos: l.combos, routing: l.routing, strategies: registry.pool.STRATEGIES, gateway: gateway?.admin.view() || null,
      concurrency: router.concurrency?.() || {}, meter: budget?.view() || null }; };
  return {
    async handle(req, res, url, { who, json, body, enqueue }) {
      if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
      if (url.search) return json(400, { success: false, error: 'PROVIDER_ADMIN_REQUEST_INVALID' });
      const p = url.pathname;
      if (req.method === 'GET') {
        if (p === '/api/r9/provider-admin/state') return json(200, { success: true, data: state() });
        if (p === '/api/r9/gateway' && gateway) return json(200, { success: true, data: gateway.admin.view() });
        return json(404, { success: false, error: 'NOT_FOUND' });
      }
      if (req.method !== 'POST') return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
      const input = await body(req, p.endsWith('/keys') ? 256 * 1024 : 16384);
      const data = await enqueue(async () => {
        switch (p) {
          case '/api/r9/provider-admin/keys':
            only(input, ['provider', 'action', 'text', 'kid', 'enabled']);
            if (input.action === 'add') return registry.addKeys(input.provider, input.text);
            if (input.action === 'set') return registry.setKey(input.provider, input.kid, { enabled: input.enabled });
            if (input.action === 'delete') return registry.deleteKey(input.provider, input.kid);
            break;
          case '/api/r9/provider-admin/strategy': only(input, ['provider', 'strategy']); return registry.setStrategy(input.provider, input.strategy);
          case '/api/r9/provider-admin/routing': only(input, ['cooldownMs', 'maxCooldownMs', 'maxConcurrency', 'maxPerKey']); return registry.setRouting(input);
          case '/api/r9/provider-admin/limits': only(input, ['provider', 'maxConcurrency']); return registry.setLimits(input.provider, { maxConcurrency: input.maxConcurrency });
          case '/api/r9/provider-admin/test':
            only(input, ['provider', 'kind', 'kid', 'model']);
            if (input.kind === 'key') return router.testKey(input.provider, input.kid, { model: input.model });
            if (input.kind === 'keys') return router.testKeys(input.provider);
            if (input.kind === 'model' && typeof input.model === 'string') return router.testModel(input.provider, input.model);
            break;
          case '/api/r9/provider-admin/catalog': only(input, ['provider', 'addModel', 'removeModel', 'alias', 'removeAlias']); return registry.editCatalog(input.provider, input);
          case '/api/r9/provider-admin/combos':
            only(input, ['action', 'combo', 'id']);
            if (input.action === 'set') return registry.setCombo(input.combo);
            if (input.action === 'delete') return registry.deleteCombo(input.id);
            break;
          case '/api/r9/gateway':
            if (!gateway) throw Object.assign(Error('GATEWAY_UNAVAILABLE'), { status: 503 });
            only(input, ['action', 'enabled', 'bind', 'port', 'label', 'models', 'limits', 'id']);
            if (input.action === 'settings') { const { action, ...v } = input; return gateway.admin.setSettings(v); }
            if (input.action === 'create-key') return gateway.admin.createKey(input);
            if (input.action === 'update-key') { const { action, id, ...v } = input; return gateway.admin.updateKey(id, v); }
            if (input.action === 'revoke-key') return gateway.admin.revokeKey(input.id);
            break;
        }
        throw Object.assign(Error('PROVIDER_ADMIN_REQUEST_INVALID'), { status: 400 });
      });
      return json(200, { success: true, data });
    },
  };
}
module.exports = { createProviderAdminRoutes };
