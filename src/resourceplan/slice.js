"use strict";

const { BOUNDS } = require("./bounds");

// ponytail: 80% hoard ceiling; tune per deployment
const HOARD_FRACTION = 0.8;

function makeSlice(store, kinds) {
    async function reserve(kindName, amount, { owner, planId } = {}) {
        const kind = await kinds.getKind(kindName);
        if (!kind) throw new Error(`Kind '${kindName}' not registered`);
        if (typeof amount !== "number" || amount <= 0) throw new Error("amount must be positive");
        const limit = kind.limit === Infinity ? Infinity : kind.limit;
        if (limit !== Infinity && amount >= limit * HOARD_FRACTION) {
            throw new Error(
                `Reservation of ${amount} exceeded hoard limit (${HOARD_FRACTION * 100}% of ${limit}) for kind '${kindName}'`
            );
        }
        const id = `${kindName}:${owner || "anon"}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const record = {
            id,
            kind: kindName,
            amount,
            owner: owner || null,
            planId: planId || null,
            reservedAt: Date.now(),
            expiresAt: Date.now() + BOUNDS.RESERVATION_TTL_MS,
        };
        await store.putKv(`reservation:${id}`, record);
        await store.addToIndex(`reservations:${kindName}`, id);
        return record;
    }

    async function release(reservationId) {
        const record = await store.getKv(`reservation:${reservationId}`);
        if (!record) throw new Error(`Reservation ${reservationId} not found`);
        await store.putKv(`reservation:${reservationId}`, null);
        return { released: true, id: reservationId };
    }

    return { reserve, release };
}

module.exports = { makeSlice };
