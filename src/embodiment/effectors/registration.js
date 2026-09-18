"use strict";

const { types } = require("node:util");
const { MAX_EFFECTORS } = require("./laws");
const { validateEffectorDescriptor } = require("./descriptor");
const isProxy = types.isProxy.bind(types);

// Registration is deliberately a pure validator here. The mutable registrar
// remains private to the canonical action bootstrap and is wired by W8-IW1.
function validateRegistrationBatch(inputs) {
    if (!Array.isArray(inputs) || isProxy(inputs) || inputs.length > MAX_EFFECTORS) throw new TypeError("effector registration batch exceeds bound");
    for (const key of Reflect.ownKeys(inputs)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= inputs.length) throw new TypeError("invalid effector registration batch");
    }
    const descriptors = [];
    for (let i = 0; i < inputs.length; i++) {
        const d = Object.getOwnPropertyDescriptor(inputs, String(i));
        if (!d || !Object.prototype.hasOwnProperty.call(d, "value")) throw new TypeError("registration batch entries must be data properties");
        descriptors.push(validateEffectorDescriptor(d.value));
    }
    const ids = new Set();
    for (const descriptor of descriptors) {
        if (ids.has(descriptor.effectorId)) throw new TypeError("duplicate effectorId");
        ids.add(descriptor.effectorId);
    }
    return Object.freeze(descriptors);
}

module.exports = Object.freeze({ validateRegistrationBatch });
