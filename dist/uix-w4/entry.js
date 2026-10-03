'use strict';
const start = () => window.DamarUI = window.DamarUIRuntime.boot(document, window);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
