'use strict';
const start = () => {
  const offlineDemo = new URLSearchParams(window.location.search).has('r9r2-demo');
  const options = offlineDemo ? {
    snapshot: async () => ({ status: 'unknown', freshness: 'UNKNOWN' }),
    stream: null
  } : {};
  window.DamarPresence = window.DamarPresenceRuntime.boot(document, window, options);
  if (offlineDemo) window.DamarPresence.detachRuntimeStatusFeed = window.DamarPresence.attachRuntimeStatusFeed({ url: '/__r9r2/runtime-status' });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
