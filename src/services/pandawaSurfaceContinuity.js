"use strict";

const identity = require("./pandawaIdentity");
const SURFACES = Object.freeze(["damar", "voice", "mata-dewa", "pandawa", "device-remote"]);
class PandawaSurfaceContinuity {
    constructor({ sessions } = {}) { if (!sessions) throw new TypeError("SESSION_REGISTRY_REQUIRED"); this.sessions = sessions; this.links = new Map(); }
    bind({ sessionId, target, surface, channel = surface } = {}) { if (!SURFACES.includes(surface)) throw new TypeError("SURFACE_INVALID"); if (String(target ?? "").toLowerCase().startsWith("pandawa:") && !identity.resolve(target)) throw new TypeError("PANDAWA_TARGET_INVALID"); const resolved = identity.resolveTarget(target); if (resolved.id === "damar") return { sessionId, targetEntity: "damar", surface, channel, authorityContextRef: null }; const key = `${sessionId}:${resolved.id}`; const link = Object.freeze({ sessionId, targetEntity: resolved.id, surface, channel, memoryNamespace: resolved.id, authorityContextRef: null }); this.links.set(key, link); return link; }
    switch({ sessionId, target, surface, channel = surface } = {}) { const link = this.bind({ sessionId, target, surface, channel }); return Object.freeze({ ...link, resumed: true, authorityContextRef: null }); }
    resolve(text, { sessionId, surface, channel = surface } = {}) { const target = identity.resolveTarget(text); return this.bind({ sessionId, target, surface, channel }); }
}
module.exports = Object.freeze({ SURFACES, PandawaSurfaceContinuity });
