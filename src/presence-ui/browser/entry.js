'use strict';
const start = () => { window.DamarPresence = window.DamarPresenceRuntime.boot(document, window); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
