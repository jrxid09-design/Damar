/**
 * Presence Runtime V0 — identitas produsen tepercaya (P18) dan
 * PresenceGenerationId (P6).
 *
 * Fakta lifecycle inti hanya boleh berasal dari identitas produsen yang
 * terdaftar. Payload pemanggil tidak bisa mengaku "system", "owner",
 * "resource-governor", dst. lalu menjadi tepercaya: identitas kanon
 * datang dari registrasi, bukan dari data. Klaim di dalam payload, bila
 * disimpan, tetap tidak tepercaya.
 */

const PRODUCER_KIND = Object.freeze({
    CORE: "CORE",
    INTERACTION: "INTERACTION",
    RESOURCE_GOVERNOR: "RESOURCE_GOVERNOR",
    RECOVERY: "RECOVERY",
    AUTHORITY: "AUTHORITY",
    SENSORIUM: "SENSORIUM",
    VOICE: "VOICE",
    VISUAL: "VISUAL",
    HOST: "HOST"
});

const BRAND = Symbol("damar.presence.producer");

let producerCounter = 0;

/** Registrasi produsen baru. Mengembalikan identitas frozen ber-brand. */
function registerProducer(kind, label = "") {
    if (!Object.prototype.hasOwnProperty.call(PRODUCER_KIND, kind)) {
        throw new TypeError(`PRESENCE_PRODUCER_KIND_INVALID: ${String(kind)}`);
    }
    producerCounter += 1;
    return Object.freeze({
        [BRAND]: true,
        id: `producer:${kind.toLowerCase()}:${producerCounter}`,
        kind,
        label: String(label).slice(0, 120)
    });
}

/** Identitas asli (bukan tiruan plain object) dan terdaftar? */
function isGenuineProducer(value) {
    return Boolean(
        value &&
        typeof value === "object" &&
        value[BRAND] === true &&
        typeof value.id === "string"
    );
}

/** PresenceGenerationId kanon: monoton per proses, deterministik. */
function createPresenceGenerationId(counter) {
    return `presence-gen-${String(counter).padStart(6, "0")}`;
}

module.exports = {
    PRODUCER_KIND,
    registerProducer,
    isGenuineProducer,
    createPresenceGenerationId
};
