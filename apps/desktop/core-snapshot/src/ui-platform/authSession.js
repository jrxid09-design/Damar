'use strict';

class SessionBoundary {
  constructor({ storage = null } = {}) { this.storage = storage; this.session = null; this.listeners = new Set(); }
  setSession(session) { this.session = session ? Object.freeze({ sessionId: session.sessionId ?? null, subject: session.subject ?? null, expiresAt: session.expiresAt ?? null, authorization: session.authorization ?? null }) : null; this.listeners.forEach((listener) => listener(this.session)); return this.session; }
  clear() { return this.setSession(null); }
  authorizationHeader() { return this.session?.authorization ? { authorization: this.session.authorization } : {}; }
  isAuthenticated(now = Date.now()) { return Boolean(this.session && (!this.session.expiresAt || new Date(this.session.expiresAt).getTime() > now)); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

module.exports = { SessionBoundary };
