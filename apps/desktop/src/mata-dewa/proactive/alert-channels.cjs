'use strict';
// DAMAR's OWN external alert channels (Fase 6): Telegram + WhatsApp.
// These are first-party implementations against the platforms' official
// APIs, configured exclusively from DAMAR's own centralized settings:
//   - non-secret targets live in the settings (alerts.channelTargets
//     .telegram.chatId / .whatsapp.{phoneNumberId,to}); the boolean
//     alerts.channels.<name> flags remain the engine's enable switches;
//   - secret tokens live in DAMAR's own vault and are resolved by NAME
//     through the injected resolveSecret() - never stored in settings,
//     never borrowed from any other system's credentials.
// Posture (fail-closed, honest): without BOTH a target and a token the
// channel reports configured=false and the engine records deliveries as
// "ready" (siap diaktifkan); send() itself also refuses to transmit in
// that state. Nothing here ever sends to a test address on its own -
// sends happen only for real alerts the engine composed.

const TELEGRAM_API = 'https://api.telegram.org';
const WHATSAPP_API = 'https://graph.facebook.com/v21.0';

function createExternalChannels({ getChannelsConfig, resolveSecret, http } = {}) {
  if (typeof getChannelsConfig !== 'function') throw Error('CHANNELS_CONFIG_REQUIRED');
  const post = typeof http === 'function' ? http : async (url, { method, headers, body }) => {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status };
  };
  const cfg = () => { try { return (getChannelsConfig() || {}).channelTargets || {}; } catch { return {}; } };
  const secret = (name) => { try { const v = typeof resolveSecret === 'function' ? resolveSecret(name) : null; return typeof v === 'string' && v ? v : null; } catch { return null; } };

  const telegramConfig = () => {
    const t = cfg().telegram || {};
    const token = secret('damar-telegram-bot-token');
    return { chatId: typeof t.chatId === 'string' && t.chatId ? t.chatId : null, token };
  };
  const whatsappConfig = () => {
    const w = cfg().whatsapp || {};
    const token = secret('damar-whatsapp-token');
    return {
      phoneNumberId: typeof w.phoneNumberId === 'string' && w.phoneNumberId ? w.phoneNumberId : null,
      to: typeof w.to === 'string' && w.to ? w.to : null, token,
    };
  };

  const telegram = {
    get configured() { const c = telegramConfig(); return !!(c.chatId && c.token); },
    async send(message) {
      const c = telegramConfig();
      if (!c.chatId || !c.token) return { delivered: false, status: 'ready' };
      const r = await post(TELEGRAM_API + '/bot' + c.token + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: c.chatId, text: String(message) }),
      });
      return r.ok ? { delivered: true, status: 'sent' } : { delivered: false, status: 'error', httpStatus: r.status };
    },
  };
  const whatsapp = {
    get configured() { const c = whatsappConfig(); return !!(c.phoneNumberId && c.to && c.token); },
    async send(message) {
      const c = whatsappConfig();
      if (!c.phoneNumberId || !c.to || !c.token) return { delivered: false, status: 'ready' };
      const r = await post(WHATSAPP_API + '/' + c.phoneNumberId + '/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.token },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: c.to, type: 'text', text: { body: String(message) } }),
      });
      return r.ok ? { delivered: true, status: 'sent' } : { delivered: false, status: 'error', httpStatus: r.status };
    },
  };
  return Object.freeze({ telegram, whatsapp });
}

module.exports = { createExternalChannels };
