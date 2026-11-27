'use strict';
// Sandboxed preload (prototype preload.js shape). Only fixed channels; no Node, no Core URL, no credential.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['play-outro-before-close', 'window-restored', 'toggle-standby-orb']);
contextBridge.exposeInMainWorld('damarDesktop', Object.freeze({
  setIgnoreMouse: ignore => ipcRenderer.send('set-ignore-mouse', Boolean(ignore)),
  setStandbyMode: standby => ipcRenderer.send('set-standby-mode', Boolean(standby)),
  windowControl: action => ipcRenderer.send('window-control', String(action)),
  navigateSurface: surface => ipcRenderer.invoke('damar-navigate-surface', String(surface)),
  launchCli: () => ipcRenderer.invoke('launch-damar-cli'),
  runtimeRequest: request => ipcRenderer.invoke('damar-runtime-request', { path: String(request?.path || ''), method: String(request?.method || 'GET') }),
  getPresence: () => ipcRenderer.invoke('damar-presence-get'),
  // The Notch 3D stage's model bytes: one fixed asset read in main; the renderer cannot fetch (by design).
  getNotchModel: () => ipcRenderer.invoke('damar-notch-model'),
  // Names the currently pending permission + a decision; main validates it and authenticates as Owner.
  decidePermission: request => ipcRenderer.invoke('permission-decision', { permissionId: String(request?.permissionId || ''), decision: String(request?.decision || '') }),
  // Now-playing controls from the notch media pill; main validates the action against the SMTC allowlist.
  mediaControl: action => ipcRenderer.invoke('damar-media-control', { action: String(action || '') }),
  // First-run onboarding: only the allowlisted answer fields cross the bridge (the completion flag never does).
  saveOnboarding: values => {
    const out = {};
    if (typeof values?.displayName === 'string') out.displayName = values.displayName;
    if (typeof values?.salutation === 'string') out.salutation = values.salutation;
    if (typeof values?.voiceEnabled === 'boolean') out.voiceEnabled = values.voiceEnabled;
    if (['id', 'en'].includes(values?.language)) out.language = values.language;
    return ipcRenderer.invoke('damar-onboarding-save', out);
  },
  // Step 0 provider connect: endpoint + key go to main (and on to Core's secret store); nothing comes back but status.
  connectProvider: request => ipcRenderer.invoke('damar-onboarding-connect', { baseUrl: String(request?.baseUrl || ''), apiKey: String(request?.apiKey || '') }),
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
