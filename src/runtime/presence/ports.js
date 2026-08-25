/**
 * Presence Runtime V0 — port integrasi inersia (P14, P17, P24, P25).
 *
 * Port adalah KONTRAK saja untuk integrasi masa depan. V0 tidak
 * mengimpor cabang kandidat mana pun, tidak mengakses mikrofon/audio,
 * tidak menjalankan TTS, tidak memanggil Windows API, dan tidak punya
 * efek samping. Port hanya menormalkan fakta lalu meneruskannya ke
 * PresenceRuntime lewat ingestFact(). Identitas produsen datang dari
 * registrasi runtime saat attach — bukan dari payload pemanggil.
 */

const { FACT_TYPE, HOST_EVENT } = require("./states");

class PresencePort {
    constructor(name) {
        if (!name) throw new TypeError("PRESENCE_PORT_NAME_REQUIRED");
        this.name = name;
        this._runtime = null;
        this._producer = null;
    }

    /** Hubungkan port ke runtime. Mengembalikan identitas produsen baru. */
    attach(runtime) {
        if (!runtime || typeof runtime.ingestFact !== "function") {
            throw new TypeError("PRESENCE_PORT_RUNTIME_INVALID");
        }
        if (this._runtime) {
            throw new Error(`PRESENCE_PORT_ALREADY_ATTACHED:${this.name}`);
        }
        this._runtime = runtime;
        this._producer = runtime.registerProducer(this.kind, this.name);
        return this._producer;
    }

    get kind() {
        throw new Error("PRESENCE_PORT_KIND_ABSTRACT");
    }

    get producer() {
        if (!this._producer) {
            throw new Error(`PRESENCE_PORT_NOT_ATTACHED:${this.name}`);
        }
        return this._producer;
    }

    _emit(id, type, content) {
        if (!this._runtime) {
            throw new Error(`PRESENCE_PORT_NOT_ATTACHED:${this.name}`);
        }
        return this._runtime.ingestFact({ id, type, content, producer: this.producer });
    }
}

/** Fakta interaksi masa depan (InteractionBus). Teks pengguna tidak
 * pernah diparsing di sini sebagai perintah lifecycle (P17). */
class InteractionPort extends PresencePort {
    constructor() { super("interaction-port"); }
    get kind() { return "INTERACTION"; }
    emitInteractionReceived(id, content = {}) {
        return this._emit(id, FACT_TYPE.INTERACTION_RECEIVED, content);
    }
}

/** Fakta tekanan resource masa depan (Resource Governor). */
class ResourcePort extends PresencePort {
    constructor() { super("resource-port"); }
    get kind() { return "RESOURCE_GOVERNOR"; }
    emitResourcePressure(id, level, content = {}) {
        return this._emit(id, FACT_TYPE.RESOURCE_PRESSURE_REPORTED, { level, ...content });
    }
}

/** Peristiwa Recovery Capsule masa depan (P16). */
class RecoveryPort extends PresencePort {
    constructor() { super("recovery-port"); }
    get kind() { return "RECOVERY"; }
    emitRecoveryEvent(id, outcome, content = {}) {
        return this._emit(id, FACT_TYPE.RECOVERY_EVENT, { outcome, ...content });
    }
}

/**
 * Port otoritas: SATU ARAH. Authority boleh MENGIRIM fakta notifikasi
 * ke presence; presence tidak pernah memberi, mencabut, atau memutasi
 * otoritas. WAITING_FOR_OWNER hanyalah status presentasi.
 */
class AuthorityPort extends PresencePort {
    constructor() { super("authority-port"); }
    get kind() { return "AUTHORITY"; }
    emitAuthorityNotice(id, content = {}) {
        return this._emit(id, FACT_TYPE.AUTHORITY_NOTICE, content);
    }
}

/** Fakta sensorium masa depan. Tidak ada penangkapan apa pun di sini. */
class SensoriumPort extends PresencePort {
    constructor() { super("sensorium-port"); }
    get kind() { return "SENSORIUM"; }
    emitSensoriumEvent(id, content = {}) {
        return this._emit(id, FACT_TYPE.SENSORIUM_EVENT, content);
    }
}

/**
 * Port suara masa depan (P24): presence hanya memodelkan semantik
 * LISTENING/THINKING/SPEAKING + interupsi. Mikrofon, ASR, sintesis,
 * dan pemutaran audio berada DI LUAR presence.
 */
class VoicePort extends PresencePort {
    constructor() { super("voice-port"); }
    get kind() { return "VOICE"; }
    emitVoiceEvent(id, content = {}) {
        return this._emit(id, FACT_TYPE.VOICE_EVENT, content);
    }
}

/** Konsumen state presentasi untuk bahasa visual masa depan (P23). */
class VisualPresencePort extends PresencePort {
    constructor() { super("visual-presence-port"); }
    get kind() { return "VISUAL"; }
    emitVisualPresenceEvent(id, content = {}) {
        return this._emit(id, FACT_TYPE.VISUAL_PRESENCE_EVENT, content);
    }
}

/**
 * Port host runtime masa depan (P25): fakta siklus Windows. V0 TIDAK
 * mendaftarkan service dan TIDAK memanggil API Windows. Alur yang
 * dimaksudkan kelak: login Windows -> Runtime Aether menyala ->
 * BOOTING -> INITIALIZING -> DORMANT.
 */
class RuntimeHostPort extends PresencePort {
    constructor() { super("runtime-host-port"); }
    get kind() { return "HOST"; }
    static get EVENTS() { return HOST_EVENT; }
    emitHostEvent(id, event, content = {}) {
        if (!Object.prototype.hasOwnProperty.call(HOST_EVENT, event)) {
            throw new TypeError(`PRESENCE_HOST_EVENT_INVALID:${String(event)}`);
        }
        return this._emit(id, FACT_TYPE.HOST_EVENT, { event, ...content });
    }
}

module.exports = {
    PresencePort,
    InteractionPort,
    ResourcePort,
    RecoveryPort,
    AuthorityPort,
    SensoriumPort,
    VoicePort,
    VisualPresencePort,
    RuntimeHostPort
};
