'use strict';
const start = () => {
  const offlineDemo = new URLSearchParams(window.location.search).has('r9r2-demo');
  window.DamarUI = window.DamarUIRuntime.boot(document, window);
  if (offlineDemo) {
    window.DamarUI.detachRuntimeStatusFeed = window.DamarUI.attachRuntimeStatusFeed({ url: '/__r9r2/runtime-status' });
  }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
