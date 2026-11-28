'use strict';
// Sandboxed preload (prototype preload.js shape). Only fixed channels; no Node, no Core URL, no credential.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['play-outro-before-close', 'window-restored', 'toggle-standby-orb']);
contextBridge.exposeInMainWorld('damarDesktop', Object.freeze({
  setIgnoreMouse: ignore => ipcRenderer.send('set-ignore-mouse', Boolean(ignore)),
  setStandbyMode: standby => ipcRenderer.send('set-standby-mode', Boolean(standby)),
  windowControl: action => ipcRenderer.send('window-control', String(action)),
  navigateSurface: surface => ipcRenderer.invoke('damar-navigate-surface', String(surface)),
  launchCli: () => ipcRenderer.invoke('launch-damar-cli'),
  // The body is allowlisted like every other channel: only the conversation
  // fields the main broker accepts may cross (the read-only era forwarded no
  // body at all, which silently starved Presence chat of its text).
  runtimeRequest: request => ipcRenderer.invoke('damar-runtime-request', {
    path: String(request?.path || ''), method: String(request?.method || 'GET'),
    body: request?.body && typeof request.body === 'object' ? {
      text: typeof request.body.text === 'string' ? request.body.text.slice(0, 8000) : undefined,
      channel: typeof request.body.channel === 'string' ? request.body.channel.slice(0, 40) : undefined,
    } : undefined,
  }),
  getPresence: () => ipcRenderer.invoke('damar-presence-get'),
  // The Notch 3D stage's model bytes: one fixed asset read in main; the renderer cannot fetch (by design).
  getNotchModel: () => ipcRenderer.invoke('damar-notch-model'),
  // Names the currently pending permission + a decision; main validates it and authenticates as Owner.
  decidePermission: request => ipcRenderer.invoke('permission-decision', { permissionId: String(request?.permissionId || ''), decision: String(request?.decision || '') }),
  // Now-playing controls from the notch media pill; main validates the action against the SMTC allowlist.
  mediaControl: action => ipcRenderer.invoke('damar-media-control', { action: String(action || '') }),
  // Notch file drop: resolves the page's File objects to real paths here
  // (the documented Electron pattern); main validates and reads them.
  dropFiles: files => {
    const out = [];
    for (const f of Array.from(files || []).slice(0, 5)) {
      try { const p = webUtils.getPathForFile(f); if (p) out.push({ path: p, name: String(f.name || ''), size: Number(f.size) || 0 }); } catch {}
    }
    return ipcRenderer.invoke('damar-drop-files', out);
  },
  // First-run onboarding: only the allowlisted answer fields cross the bridge (the completion flag never does).
  saveOnboarding: values => {
    const out = {};
    if (typeof values?.displayName === 'string') out.displayName = values.displayName;
    if (typeof values?.salutation === 'string') out.salutation = values.salutation;
    if (typeof values?.voiceEnabled === 'boolean') out.voiceEnabled = values.voiceEnabled;
    if (['id', 'en'].includes(values?.language)) out.language = values.language;
    return ipcRenderer.invoke('damar-onboarding-save', out);
  },
  // Step 0 provider connect: provider id + endpoint + key go to main (and on to Core's secret store); nothing comes back but status.
  connectProvider: request => ipcRenderer.invoke('damar-onboarding-connect', { provider: String(request?.provider || 'custom'), baseUrl: String(request?.baseUrl || ''), apiKey: String(request?.apiKey || '') }),
  // Step 0 provider picker: Core's preset list, live connections and OAuth status (no secrets cross).
  providerPicker: () => ipcRenderer.invoke('damar-onboarding-picker'),
  // Step 0 OAuth (OpenRouter PKCE): main opens the authorize URL in the Owner's browser, then waits for Core to report the login.
  oauthStart: () => ipcRenderer.invoke('damar-onboarding-oauth-start'),
  oauthWait: () => ipcRenderer.invoke('damar-onboarding-oauth-wait'),
  // Branch A interview: only user/assistant turns cross; Core owns the system prompt and the model.
  onboardingChat: messages => ipcRenderer.invoke('damar-onboarding-chat', { messages: (Array.isArray(messages) ? messages : []).slice(-16).map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content ?? '').slice(0, 2000) })) }),
  onPresence: listener => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on('damar-presence', wrapped);
    return () => ipcRenderer.removeListener('damar-presence', wrapped);
  },
  on: (event, listener) => {
    if (!EVENTS.has(event) || typeof listener !== 'function') return () => {};
    const wrapped = () => listener();
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },
}));
