'use strict';

// Bind the Core provider selection to its canonical runtime without ever writing an API key
// into configs/providers.json. The secret overlay exists only in this process; DPAPI is the
// only persistence path. Selection is the Owner-authorized dispatch boundary.
function createProviderRuntime({ providerConfig, aiRuntime, initialKey = null, canDispatch = () => false, testFixtures = false }) {
  if (!providerConfig || !aiRuntime) throw new TypeError('PROVIDER_RUNTIME_DEPENDENCY_INVALID');
  const originalRead = providerConfig.read.bind(providerConfig);
  const originalSetProvider = providerConfig.setProvider.bind(providerConfig);
  const originalSetActive = providerConfig.setActive.bind(providerConfig);
  const originalResolveActive = providerConfig.resolveActive.bind(providerConfig);
  const originalReconfigure = aiRuntime.reconfigure.bind(aiRuntime);
  let secret = initialKey;
  // No connection is active until the Owner selects one (there is no built-in provider).
  let live = { id: null, baseUrl: null, model: null };

  providerConfig.read = function () {
    const stored = originalRead();
    const providers = { ...(stored.providers || {}) };
    providers.custom = { ...(providers.custom || {}), apiKey: secret, baseUrl: live.baseUrl, model: live.model };
    return { ...stored, active: 'custom', providers };
  };
  providerConfig.resolveActive = function () {
    const stored = providerConfig.read();
    const selected = stored.providers.custom;
    return { id: live.id || 'custom', kind: 'openai', label: 'OpenAI-compatible connection', apiKey: selected.apiKey, baseUrl: selected.baseUrl, model: selected.model };
  };
  providerConfig.setProvider = function (id, options = {}) {
    if (id !== 'custom') return originalSetProvider(id, options);
    if (Object.hasOwn(options, 'apiKey')) secret = options.apiKey || null;
    if (Object.hasOwn(options, 'baseUrl')) live.baseUrl = options.baseUrl || null;
    if (Object.hasOwn(options, 'model')) live.model = options.model || null;
    // Persist only nonsecret routing metadata. JsonStore receives apiKey:null, never the credential.
    return originalSetProvider(id, { apiKey: null, baseUrl: live.baseUrl, model: live.model });
  };
  providerConfig.setActive = function (id) {
    if (id === 'custom') return originalSetActive('custom');
    return originalSetActive(id);
  };

  if (!testFixtures) {
    aiRuntime.reconfigure = function (...args) {
      const result = originalReconfigure(...args);
      aiRuntime.clearModelFederation?.();
      return result;
    };
    aiRuntime.clearModelFederation?.();
    const originalFailure = aiRuntime.handleModelFailure;
    const originalFallback = aiRuntime.chatLocalFallback;
    if (typeof originalFailure === 'function') aiRuntime.handleModelFailure = function (...args) {
       return null;
    };
    if (typeof originalFallback === 'function') aiRuntime.chatLocalFallback = function (request, platform, error) {
       return null;
    };
    const originalChat = aiRuntime.chat.bind(aiRuntime);
    aiRuntime.chat = function (request) {
      if (!canDispatch()) throw Object.assign(Error('LIVE_INFERENCE_NOT_AUTHORIZED'), { code: 'LIVE_INFERENCE_NOT_AUTHORIZED' });
      return originalChat(request);
    };
    const originalStream = aiRuntime.stream.bind(aiRuntime);
    aiRuntime.stream = async function* (request) {
      if (!canDispatch()) throw Object.assign(Error('LIVE_INFERENCE_NOT_AUTHORIZED'), { code: 'LIVE_INFERENCE_NOT_AUTHORIZED' });
      yield* originalStream(request);
    };
  }

  return Object.freeze({
    activate: async ({ id, baseUrl, apiKey, model }) => {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || id.startsWith('offline-fixture-')) throw Object.assign(Error('LIVE_PROVIDER_NOT_ALLOWED'), { status: 400 });
      live = { id, baseUrl, model };
      if (apiKey !== undefined) secret = apiKey || null;
      providerConfig.setProvider('custom', { baseUrl, model });
      providerConfig.setActive('custom');
      aiRuntime.reconfigure();
      return { id, model, dispatchedBy: 'canonical-aiRuntimeService' };
    },
    revoke: async id => {
      if (id !== live.id) return false;
      secret = null;
      providerConfig.setProvider('custom', { apiKey: null, baseUrl: live.baseUrl, model: live.model });
      aiRuntime.reconfigure();
      return true;
    },
    resolveActive: () => ({ ...live, hasKey: Boolean(secret) }),
    originalResolveActive,
  });
}

module.exports = { createProviderRuntime };
