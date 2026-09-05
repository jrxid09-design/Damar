"use strict";

/**
 * MATA DEWA RF CONTROL WIRING (Lane 5 Integrasi 4) — modul sempit internal.
 *
 * OWNS: descriptor + trusted scope resolver + actuator binding untuk
 * operasi RF TERISTIMEWA (enable/disable listener, enroll/revoke perangkat,
 * reset kalibrasi). MIRROR pola tersertifikasi visualModeWiring (MD-011):
 *
 * HUKUM:
 *   - CAPABILITY AVAILABILITY != AUTHORITY. Modul ini mendaftarkan METADATA
 *     capability + BINDING actuator. TIDAK PERNAH membuat, upsert, atau
 *     men-seed grant otoritas apa pun — otoritas tetap milik komposisi
 *     Wave 4 kanonik (ratifikasi Owner lewat bridge tersertifikasi).
 *   - Tanpa grant, Lane 2 evaluate DENY (fail closed). Tidak ada jalur
 *     alternatif ke mutasi RF di modul ini.
 *   - Scope resolver sempit: token scope = sensorId yang ditarget (bounded,
 *     di-sanitasi); scope kosong untuk operasi tanpa target resource.
 *   - Wiring gagal = KESALAHAN KOMPOSISI (typed error, tidak diam-diam).
 *   - TIDAK ada control plane RF kedua: actuator HANYA memanggil permukaan
 *     kontrol RF yang hidup di closure komposisi trust kanonik (MD-019,
 *     resolusi leksikal — bukan properti service), dan permukaan itu hanya
 *     bisa dijangkau lewat Lane 3 execute.
 */

const { CAPABILITY_FAMILIES } = require("./index");
const { resolveMataDewaRfControlSurface } = require("../trust/composition");

const RF_CONTROL_CAPABILITIES = Object.freeze([
    Object.freeze({
        schemaVersion: 1,
        id: CAPABILITY_FAMILIES.RF_LISTENER_ENABLE,
        kind: "system",
        provider: "core",
        operations: Object.freeze(["enable"]),
        requirements: Object.freeze([]),
        effects: Object.freeze(["rf_listener", "rf_sources"]),
        description: "Aktifkan listener RF live lokal (loopback saja; butuh perangkat terdaftar; butuh grant Owner ter-ratifikasi)."
    }),
    Object.freeze({
        schemaVersion: 1,
        id: CAPABILITY_FAMILIES.RF_LISTENER_DISABLE,
        kind: "system",
        provider: "core",
        operations: Object.freeze(["disable"]),
        requirements: Object.freeze([]),
        effects: Object.freeze(["rf_listener"]),
        description: "Matikan listener RF live lokal."
    }),
    Object.freeze({
        schemaVersion: 1,
        id: CAPABILITY_FAMILIES.RF_DEVICE_ENROLL,
        kind: "system",
        provider: "core",
        operations: Object.freeze(["enroll"]),
        requirements: Object.freeze([]),
        effects: Object.freeze(["rf_device_trust"]),
        description: "Daftarkan perangkat RF ke trust domain (butuh binding perangkat OwnerTrust kanonik aktif)."
    }),
    Object.freeze({
        schemaVersion: 1,
        id: CAPABILITY_FAMILIES.RF_DEVICE_REVOKE,
        kind: "system",
        provider: "core",
        operations: Object.freeze(["revoke"]),
        requirements: Object.freeze([]),
        effects: Object.freeze(["rf_device_trust"]),
        description: "Cabut trust perangkat RF (segera mencegah eskalasi produksi-live)."
    }),
    Object.freeze({
        schemaVersion: 1,
        id: CAPABILITY_FAMILIES.RF_CALIBRATION_RESET,
        kind: "system",
        provider: "core",
        operations: Object.freeze(["reset"]),
        requirements: Object.freeze([]),
        effects: Object.freeze(["rf_calibration"]),
        description: "Reset/invalidasi baseline kalibrasi sumber RF (butuh grant ter-ratifikasi)."
    })
]);

function safeScopeToken(value, max = 96) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().slice(0, max);
    if (!trimmed.length || !/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return null;
    return trimmed;
}

/** Resolver scope sempit: token = sensorId target (tanpa data lain). */
function sensorScopeResolver(args) {
    const token = args && safeScopeToken(args.sensorId);
    return token ? [token] : [];
}

const RF_CONTROL_SCOPE_BINDINGS = Object.freeze({
    [CAPABILITY_FAMILIES.RF_LISTENER_ENABLE]: Object.freeze({
        enable: sensorScopeResolver
    }),
    [CAPABILITY_FAMILIES.RF_LISTENER_DISABLE]: Object.freeze({
        disable: sensorScopeResolver
    }),
    [CAPABILITY_FAMILIES.RF_DEVICE_ENROLL]: Object.freeze({
        enroll: sensorScopeResolver
    }),
    [CAPABILITY_FAMILIES.RF_DEVICE_REVOKE]: Object.freeze({
        revoke: sensorScopeResolver
    }),
    [CAPABILITY_FAMILIES.RF_CALIBRATION_RESET]: Object.freeze({
        reset: sensorScopeResolver
    })
});

const MATA_DEWA_SERVICE_UNAVAILABLE = "MATA_DEWA_SERVICE_UNAVAILABLE";

function failWiring(what, error) {
    throw Object.assign(
        new Error(`MATA_DEWA_WIRING_FAILED: gagal wire RF control (${what}): ${error?.message ?? error}`),
        { code: "MATA_DEWA_WIRING_FAILED", cause: error });
}

/** Operasi → argumen actuator yang sah (allowlist; sisanya ditolak). */
const OPERATION_ARGUMENT_KEYS = Object.freeze({
    enable: Object.freeze(["sensorId", "deviceId", "bindPort", "location", "label"]),
    disable: Object.freeze(["sensorId"]),
    enroll: Object.freeze(["sensorId", "deviceId"]),
    revoke: Object.freeze(["sensorId", "reason"]),
    reset: Object.freeze(["sensorId", "reason"])
});

/**
 * Daftarkan capability RF control ke registrar kanonik (Lane 2 komposisi).
 * @returns wiring record beku { capabilities, scopeBindings }
 */
function registerRfControlCapabilities({ registrar } = {}) {
    if (!registrar || typeof registrar.register !== "function") {
        failWiring("registrar", new TypeError("registrar.register wajib ada"));
    }
    const capabilities = {};
    try {
        for (const descriptor of RF_CONTROL_CAPABILITIES) {
            const res = registrar.register(JSON.stringify(descriptor));
            if (!res || res.registered === false) {
                throw new Error(`registrasi capability ${descriptor.id} ditolak`);
            }
            capabilities[descriptor.id] = Object.freeze({
                id: descriptor.id,
                incarnationId: res.incarnationId
            });
        }
    }
    catch (error) {
        failWiring("capability registration", error);
    }
    return Object.freeze({ capabilities: Object.freeze(capabilities), scopeBindings: RF_CONTROL_SCOPE_BINDINGS });
}

/**
 * Wire actuator RF control ke registry actuator kanonik (Lane 3 komposisi).
 * Setiap invoke: service diselesaikan LAZY; permukaan kontrol RF hidup di
 * closure komposisi trust kanonik (MD-019) — service TIDAK pernah
 * memegangnya, dan tidak ada jalur pembuatan on-demand dari pemanggil.
 * Actuator menjangkaunya lewat resolusi LEXICAL modul jembatan satu-satunya.
 * Argumen dijepit ke allowlist per operasi (fail-closed).
 */
function wireMataDewaRfControlActuators({ actuatorRegistry, wiring, resolveService } = {}) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function") {
        failWiring("actuatorRegistry", new TypeError("actuatorRegistry.register wajib ada"));
    }
    if (!wiring || typeof wiring !== "object" || !wiring.capabilities) {
        failWiring("wiring", new TypeError("wiring record RF control wajib ada (dari registerRfControlCapabilities)"));
    }
    if (typeof resolveService !== "function") {
        failWiring("resolveService", new TypeError("resolveService leksikal produksi wajib ada"));
    }

    const bindings = [];
    for (const descriptor of RF_CONTROL_CAPABILITIES) {
        const [operation] = descriptor.operations;
        const entry = wiring.capabilities[descriptor.id];
        if (!entry || entry.id !== descriptor.id || typeof entry.incarnationId !== "string") {
            failWiring(descriptor.id, new Error("inkarnasi capability tidak cocok"));
        }
        const allowedKeys = OPERATION_ARGUMENT_KEYS[operation];
        bindings.push(actuatorRegistry.register({
            capabilityId: descriptor.id,
            operations: [operation],
            capabilityIncarnationId: entry.incarnationId,
            actuatorId: `act-matadewa-rf-${operation}`,
            invoke: async ({ parameters } = {}) => {
                let resolved = null;
                try {
                    resolved = resolveService();
                }
                catch {
                    return { ok: false, reason: MATA_DEWA_SERVICE_UNAVAILABLE };
                }
                if (!resolved || typeof resolved !== "object") {
                    return { ok: false, reason: MATA_DEWA_SERVICE_UNAVAILABLE };
                }
                // Allowlist argumen: kunci asing (terutama token otoritas)
                // ditolak fail-closed — sebelum resolusi permukaan.
                const clean = {};
                if (parameters && typeof parameters === "object") {
                    for (const key of Object.keys(parameters)) {
                        if (!allowedKeys.includes(key)) {
                            return { ok: false, reason: `argument '${key}' tidak sah untuk ${operation}` };
                        }
                        clean[key] = parameters[key];
                    }
                }
                // MD-019: permukaan kontrol tidak pernah properti service —
                // hanya jembatan trust kanonik yang memegangnya (lexical).
                const rfControl = resolveMataDewaRfControlSurface(resolved);
                if (!rfControl || typeof rfControl[operation] !== "function") {
                    return { ok: false, reason: MATA_DEWA_SERVICE_UNAVAILABLE };
                }
                return rfControl[operation](clean);
            }
        }));
    }
    return Object.freeze(bindings);
}

module.exports = Object.freeze({
    RF_CONTROL_CAPABILITIES,
    RF_CONTROL_SCOPE_BINDINGS,
    registerRfControlCapabilities,
    wireMataDewaRfControlActuators,
    MATA_DEWA_SERVICE_UNAVAILABLE
});
