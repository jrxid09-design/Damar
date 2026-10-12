"use strict";

const CONSENT_SCHEMA_VERSION = "collab.consent.v1";
const TOKEN_TTL_MS = 15 * 60 * 1000;
const REFUSAL_COOLDOWN_MS = 60 * 1000;

function makeConsentManager(store) {
    async function selfMint(purpose) {
        throw new Error("Damar cannot self-mint consent — internal mint path refused (W9-L3/ADR-13)");
    }

    async function mint(purpose, signal = {}) {
        if (!signal.affirmative) {
            throw new Error("Consent not affirmative: timeout or absent signal treated as refusal (W9-L3/ADR-13)");
        }
        if (signal.preselected) {
            throw new Error("Preselected default button is not consent — schema-level rejection (W9-L3/I-35)");
        }
        if (signal.channelVerified === false) {
            throw new Error("Channel not trusted — no consent token minted for unverified channel (W9-L3)");
        }
        if (signal.deviceTrust && signal.deviceTrust !== "verified") {
            throw new Error("Device not trusted — impersonation refused (W9-L3/RT-W9-27)");
        }
        const id = `ct:${purpose}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const token = {
            schemaVersion: CONSENT_SCHEMA_VERSION,
            id,
            purpose,
            state: "ACTIVE",
            mintedAt: Date.now(),
            expiresAt: Date.now() + TOKEN_TTL_MS,
        };
        await store.putKv(`token:${id}`, token);
        return token;
    }

    async function consume(id, purpose) {
        const token = await store.getKv(`token:${id}`);
        if (!token) throw new Error(`Consent token ${id} not found`);
        if (token.state === "CONSUMED") {
            throw new Error(`Consent token ${id} already used — reuse refused (W9-L3/RT-W9-22)`);
        }
        if (token.purpose !== purpose) {
            throw new Error(`Consent scope mismatch: token is for '${token.purpose}', not '${purpose}' (W9-L3/RT-W9-23)`);
        }
        if (Date.now() > token.expiresAt) {
            throw new Error(`Consent token ${id} expired`);
        }
        const updated = Object.assign({}, token, { state: "CONSUMED", consumedAt: Date.now() });
        await store.putKv(`token:${id}`, updated);
        return updated;
    }

    async function recordRefusal(purpose, owner) {
        await store.putKv(`refusal:${purpose}:${owner}`, { purpose, owner, refusedAt: Date.now() });
    }

    async function requestAllowed(purpose, owner) {
        const r = await store.getKv(`refusal:${purpose}:${owner}`);
        if (r && (Date.now() - r.refusedAt) < REFUSAL_COOLDOWN_MS) {
            throw new Error(`Consent request blocked by cooldown — too soon after refusal (W9-L3/RT-W9-26)`);
        }
        return true;
    }

    return { mint, consume, recordRefusal, requestAllowed, selfMint };
}

module.exports = { makeConsentManager };
