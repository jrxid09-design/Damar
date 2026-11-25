'use strict';
// Pure (Electron-free) host policy for DAMAR Presence, so the security flags and the IPC allowlist are testable.
const path = require('node:path');

// Window: Owner prototype main.js:85-105 (transparent, frameless, always-on-top, isolated renderer).
function windowOptions({ bounds, icon, show = true }) {
  return {
    ...bounds, show, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: true, minimizable: true, maximizable: true, alwaysOnTop: true, skipTaskbar: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
      navigateOnDragDrop: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      // The hidden self-test window must not get Chromium's background timer throttling (it would stretch the
      // 620 ms morph to seconds); the shown product window is never throttled while visible anyway.
      ...(show ? {} : { backgroundThrottling: false }),
    },
  };
}

// Renderer -> main IPC channels (everything else is ignored). Preload exposes exactly these.
const CHANNELS = Object.freeze({
  invoke: ['damar-runtime-request', 'damar-navigate-surface', 'launch-damar-cli', 'damar-presence-get', 'permission-decision', 'damar-onboarding-save', 'damar-onboarding-connect', 'damar-onboarding-chat'],
  send: ['set-ignore-mouse', 'set-standby-mode', 'window-control'],
  // main -> renderer
  events: ['play-outro-before-close', 'window-restored', 'toggle-standby-orb', 'damar-presence'],
});

// The Owner page's read models (prototype main.js:39-43 allowlist), now answered from the cached Core projection.
// Every mutation the page could ask for is refused: conversation runs in the CLI, notifications have no Core dismiss
// route, and permission decisions need Owner auth in CLI/Control. Presence never approves anything.
const UI_READS = Object.freeze({ '/api/ui/presence/state': 'presence', '/api/ui/approvals': 'approvals', '/api/ui/missions': 'missions', '/api/ui/notifications': 'notifications' });
function uiResponse(request, projection) {
  const method = String(request?.method || 'GET').toUpperCase(), route = String(request?.path || '');
  const fail = (kind, status, message) => ({ ok: false, error: { kind, status, message } });
  if (method !== 'GET' || !Object.hasOwn(UI_READS, route)) {
    if (method === 'POST' && route === '/api/ui/conversations/messages') return fail('NOT_AVAILABLE', 409, 'Conversation runs in DAMAR CLI.');
    if (method === 'POST' && /^\/api\/ui\/notifications\/[A-Za-z0-9_-]+\/dismiss$/.test(route)) return fail('NOT_AVAILABLE', 409, 'Dismiss notifications in DAMAR Control.');
    if (method === 'GET' && /^\/api\/ui\/conversations\/dsc_[A-Za-z0-9_-]+$/.test(route)) return fail('NOT_AVAILABLE', 404, 'Conversation history is in DAMAR CLI.');
    return fail('NOT_ALLOWED', 403, 'Runtime operation is not allowed.');
  }
  if (!projection || projection.status !== 'CONNECTED') return fail('UNAVAILABLE', 503, projection?.reason || 'DAMAR Core is not reachable.');
  return { ok: true, status: 200, data: { success: true, data: projection[UI_READS[route]] } };
}

// Microphone gate: only the presence window, only 'media' with audio-only types, only when the Owner opted in via
// Core (presence.voiceEnabled === true). Everything else (camera, screen, notifications, geolocation...) is denied.
function micAllowed({ voiceEnabled, permission, mediaTypes, ownWindow }) {
  return voiceEnabled === true && ownWindow === true && permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every(t => t === 'audio');
}

module.exports = { windowOptions, CHANNELS, UI_READS, uiResponse, micAllowed };
