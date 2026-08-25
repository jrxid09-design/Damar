/**
 * BodySchema — skema tubuh komputasi kanonik (B§6).
 *
 * ATURAN TULIS TUNGGAL: satu-satunya cara mengubah state adalah
 * ingest(event). Event hanya diterima dari produsen TERDAFTAR
 * (discovery adapter / sensorium.core). Model bahasa, teks pengguna,
 * maupun referensi objek dari luar TIDAK punya jalur tulis — snapshot
 * dibekukan dan rekaman internal diganti-ganti utuh (immutable swap).
 *
 * Event cacat / produsen asing tidak pernah bermutasi state diam-diam;
 * semuanya dicatat ke deadLetters untuk diagnosis.
 *
 * Lapisan ini TANPA LLM, TANPA Console, TANPA otoritas: ia bisa hidup
 * sendirian di proses mana pun (invariant G).
 */

const {
    deepFreeze, structuredCopy, digestOf, fail,
    realClock, clamp01
} = require("../core/util");
const { validateDeviceId } = require("../core/identity");
const {
    DEVICE_CLASSES, DEVICE_STATES, HEALTH_STATES, RELATIONSHIP_TYPES,
    PREFERENCE_TYPES, isValidCapability, classifyCapability
} = require("../domain/types");
const { assertCapability, normalizeDescriptor, normalizeCapabilityClaim }
    = require("../domain/descriptor");
const {
    EVENT_TYPES, CORE_SOURCE, makeEvent, validateEventShape
} = require("../sensorium/events");

const DEFAULTS = Object.freeze({
    observationCapacity: 32,     // observasi = EPHEMERAL, cincin terbatas
    deadLetterCapacity: 100,
    journalCapacity: 4096
});

const STRUCTURAL_RELATIONSHIP_TYPES = Object.freeze([
    "attached_to", "connected_via", "provides", "depends_on",
    "located_on", "network_peer", "logical_child"
]);

const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;

/** Urutan total antar-observasi deskriptor — bebas arah kedatangan. */
function newerWins(a, b) {
    // 1) confidence lebih tinggi menang
    if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
    // 2) sumber leksikografis lebih kecil menang (tie deterministik)
    if (a.source !== b.source) return a.source < b.source ? a : b;
    // 3) pengamatan lebih baru menang
    if (a.timestampMs !== b.timestampMs) return a.timestampMs > b.timestampMs ? a : b;
    // 4) digest kanonik lebih kecil menang — tie sempurna pun total
    return a.digest <= b.digest ? a : b;
}

class BodySchema {

    constructor({ clock = realClock(), store = null, config = {} } = {}) {
        this.clock = clock;
        this.store = store;                       // opsional (B§8)
        this.config = deepFreeze({ ...DEFAULTS, ...config });

        this._devices = new Map();       // deviceId -> record
        this._rels = new Map();          // key -> relationship
        this._observations = new Map();  // channelId -> ring[]
        this._producers = new Set([CORE_SOURCE]);
        this._analysisRequested = new Set();
        this._lastDefaults = new Map();  // purpose -> resolved deviceId|null
        this._journal = [];
        this._deadLetters = [];
        this._subscribers = new Set();
        this._deriving = false;
    }

    /* ----------------------- jalur tulis tunggal ---------------------- */

    /** Daftarkan produsen observasi tepercaya (id adapter discovery). */
    registerProducer(source) {
        if (!/^[a-z][a-z0-9._-]{2,63}$/.test(String(source ?? ""))) {
            throw fail("EMB_INVALID_PRODUCER_ID", `id produsen tidak sah: '${source}'`);
        }
        this._producers.add(source);
        return this;
    }

    /**
     * Satu-satunya pintu mutasi state. Tidak pernah melempar untuk input
     * kotor — penolakan tercatat diagnostik (gagal-tutup tanpa drama).
     */
    ingest(event) {

        const shape = validateEventShape(event);
        if (!shape.ok) return this._reject(shape.reason, event);

        const producerClass = EVENT_TYPES[event.type].producerClass;

        if (producerClass === "core" && event.source !== CORE_SOURCE) {
            return this._reject("event-inti-dari-sumber-asing", event);
        }
        if (producerClass === "adapter" && !this._producers.has(event.source)) {
            // INVARIANT B/C: teks/referensi dari pihak tak-tepercaya
            // tidak pernah sampai ke reducer.
            return this._reject("produsen-tidak-terdaftar", event);
        }

        try {
            const result = this._apply(event);

            if (this._journal.length >= this.config.journalCapacity) {
                this._journal.shift();
            }
            this._journal.push(event);

            if (!event.payload?.derived) {
                this._deriveDefaultChanges(event);
            }

            for (const fn of this._subscribers) {
                fn(event, result);
            }
            return { accepted: true, ...result };
        } catch (err) {
            return this._reject(err.code || "applier-gagal", event);
        }
    }

    _apply(event) {
        switch (event.type) {
            case "DEVICE_DISCOVERED": return this._applyDiscovered(event, { allowNew: true });
            case "DEVICE_CHANGED": return this._applyDiscovered(event, { allowNew: false });
            case "DEVICE_ONLINE": return this._applyState(event, DEVICE_STATES.ONLINE);
            case "DEVICE_OFFLINE": return this._applyState(event, DEVICE_STATES.OFFLINE);
            case "DEVICE_REMOVED": return this._applyState(event, DEVICE_STATES.REMOVED);
            case "DEVICE_HEALTH_CHANGED": return this._applyHealth(event);
            case "CAPABILITY_DISCOVERED": return this._applyCapability(event);
            case "SENSOR_OBSERVATION": return this._applyObservation(event);
            case "DEVICE_DEFAULT_CHANGED": return this._applyPreference(event);
            case "UNKNOWN_DEVICE_REQUIRES_ANALYSIS":
                return this._applyAnalysisRequested(event);
            default:
                throw fail("EMB_UNKNOWN_EVENT_TYPE", `tipe tak tertangani: ${event.type}`);
        }
    }

    /* ----------------------------- applier ---------------------------- */

    _applyDiscovered(event, { allowNew }) {

        const raw = event.payload.descriptor;
        if (!raw || typeof raw !== "object") {
            throw fail("EMB_INVALID_PAYLOAD", "payload.descriptor hilang");
        }
        const descriptor = normalizeDescriptor(raw, { nowMs: event.timestampMs });

        const existing = this._devices.get(descriptor.deviceId);
        let record = existing;

        if (!existing) {
            if (!allowNew) {
                throw fail("EMB_DEVICE_UNKNOWN",
                    `perangkat belum terdaftar: ${descriptor.deviceId}`);
            }
            record = {
                descriptor,
                meta: {
                    confidence: event.confidence,
                    source: event.source,
                    timestampMs: event.timestampMs,
                    digest: digestOf(descriptor)
                },
                capabilities: new Map(),
                firstSeenAtMs: event.timestampMs,
                lastSeenAtMs: event.timestampMs
            };
            this._devices.set(descriptor.deviceId, record);
        } else {
            // Pengamatan ulang menyiratkan kehadiran — state ikut laporan
            // terbaru yang MENANG menurut urutan total.
            const candidate = {
                confidence: event.confidence,
                source: event.source,
                timestampMs: event.timestampMs,
                digest: digestOf(descriptor)
            };
            if (newerWins(candidate, record.meta) === candidate) {
                record.descriptor = descriptor;
                record.meta = candidate;
            } else if (record.descriptor.state !== descriptor.state) {
                // Kehadiran itu temporal: pengamatan "terlihat lagi" SELALU
                // menang untuk state (rediscovery memulihkan yang hilang),
                // meski konten deskriptornya kalah urutan total.
                record.descriptor = deepFreeze({
                    ...record.descriptor, state: descriptor.state
                });
                record.meta = {
                    ...record.meta, digest: digestOf(record.descriptor)
                };
            }
            record.lastSeenAtMs = Math.max(record.lastSeenAtMs, event.timestampMs);
        }

        for (const claim of descriptor.capabilities) {
            this._mergeClaim(record, claim);
        }

        for (const rel of event.payload.relationships ?? []) {
            this._applyStructuralRelationship(rel, event);
        }

        if (record.descriptor.deviceClass === DEVICE_CLASSES.UNKNOWN
            && !this._analysisRequested.has(descriptor.deviceId)) {
            this._emitAnalysisRequested(descriptor, event);
        }

        return { deviceId: descriptor.deviceId, isNew: !existing };
    }

    _applyState(event, state) {
        const record = this._devices.get(event.subject);
        if (!record) throw fail("EMB_DEVICE_UNKNOWN", `perangkat tidak dikenal: ${event.subject}`);
        if (record.descriptor.state !== state) {
            record.descriptor = deepFreeze({
                ...record.descriptor, state
            });
            record.meta = { ...record.meta, digest: digestOf(record.descriptor) };
        }
        return { deviceId: event.subject, state };
    }

    _applyHealth(event) {
        const record = this._devices.get(event.subject);
        if (!record) throw fail("EMB_DEVICE_UNKNOWN", `perangkat tidak dikenal: ${event.subject}`);
        const status = event.payload.health?.status;
        if (!HEALTH_STATES[status]) {
            throw fail("EMB_UNKNOWN_HEALTH_STATE", `kesehatan tidak dikenal: '${status}'`);
        }
        const health = deepFreeze({
            status,
            detail: event.payload.health.detail != null
                ? String(event.payload.health.detail).slice(0, 200) : null,
            checkedAt: new Date(event.timestampMs).toISOString()
        });
        record.descriptor = deepFreeze({ ...record.descriptor, health });
        record.meta = { ...record.meta, digest: digestOf(record.descriptor) };
        return { deviceId: event.subject, health };
    }

    _applyCapability(event) {
        const record = this._devices.get(event.subject);
        if (!record) throw fail("EMB_DEVICE_UNKNOWN", `perangkat tidak dikenal: ${event.subject}`);
        const claim = normalizeCapabilityClaim(event.payload.capability);
        this._mergeClaim(record, claim);
        return { deviceId: event.subject, capability: claim.name };
    }

    _mergeClaim(record, incoming) {
        const current = record.capabilities.get(incoming.name);
        if (current) {
            const better =
                incoming.confidence > current.confidence ||
                (incoming.confidence === current.confidence &&
                    incoming.source <= current.source);
            if (!better) return;
        }
        record.capabilities.set(incoming.name, incoming);
        record.descriptor = deepFreeze({
            ...record.descriptor,
            capabilities: [...record.capabilities.values()]
        });
        record.meta = { ...record.meta, digest: digestOf(record.descriptor) };
    }

    _applyObservation(event) {
        const record = this._devices.get(event.subject);
        if (!record) throw fail("EMB_DEVICE_UNKNOWN", `observasi untuk perangkat tak dikenal`);
        const channel = event.payload.channel;
        if (!channel || !CHANNEL_ID_PATTERN.test(String(channel.id ?? ""))) {
            throw fail("EMB_INVALID_CHANNEL", "kanal observasi tidak sah");
        }
        const classification = classifyCapability(String(channel.id));
        if (!classification) {
            throw fail("EMB_INVALID_CHANNEL",
                `kanal bukan kemampuan sensor/aktuator: '${channel.id}'`);
        }
        const sample = JSON.stringify(event.payload.sample ?? null);
        if (sample.length > 2048) {
            throw fail("EMB_OBSERVATION_TOO_LARGE", "sampel observasi > 2KB");
        }

        if (!this._observations.has(channel.id)) {
            this._observations.set(channel.id, []);
        }
        const ring = this._observations.get(channel.id);
        if (ring.length >= this.config.observationCapacity) ring.shift();
        ring.push(Object.freeze({
            channelId: channel.id,
            modality: classification.modality,
            deviceId: event.subject,
            sample: event.payload.sample ?? null,
            confidence: event.confidence,
            source: event.source,
            atMs: event.timestampMs
        }));
        return { deviceId: event.subject, channelId: channel.id };
    }

    _applyStructuralRelationship(raw, event) {
        if (!raw || typeof raw !== "object") {
            throw fail("EMB_INVALID_RELATIONSHIP", "relasi bukan objek");
        }
        const { type, fromId, toId } = raw;
        if (!STRUCTURAL_RELATIONSHIP_TYPES.includes(type)) {
            throw fail("EMB_UNKNOWN_RELATIONSHIP_TYPE",
                `tipe relasi struktural tidak dikenal: '${type}'`);
        }
        // Ujung 'from' wajib entitas yang sudah dikenal — tidak ada titik hantu.
        if (!validateDeviceId(fromId) || !this._devices.has(fromId)) {
            throw fail("EMB_RELATIONSHIP_DANGLING_FROM",
                `ujung 'from' tidak dikenal: '${fromId}'`);
        }
        let target = null;
        if (type === "provides") {
            assertCapability(toId);           // target kemampuan, bukan entitas
            target = `cap:${toId}`;
        } else {
            if (!validateDeviceId(toId) || !this._devices.has(toId)) {
                throw fail("EMB_RELATIONSHIP_DANGLING_TO",
                    `ujung 'to' tidak dikenal: '${toId}'`);
            }
            target = toId;
        }
        this._setRel(deepFreeze({
            type, fromId, toId: target,
            rank: Number.isFinite(raw.rank) ? raw.rank : null,
            source: event.source,
            observedAtMs: event.timestampMs
        }));
    }

    _applyPreference(event) {
        const p = event.payload;
        if (!p.explicit) return { passthrough: true };   // turunan: hanya jurnal

        const kind = p.kind;
        if (!["default", "preferred", "fallback", "clear"].includes(kind)) {
            throw fail("EMB_INVALID_PREFERENCE_KIND", `jenis preferensi tidak sah: '${kind}'`);
        }
        assertCapability(p.purpose);

        if (kind === "clear") {
            for (const [key, rel] of [...this._rels]) {
                if ([...PREFERENCE_TYPES].includes(rel.type)
                    && rel.toId === `cap:${p.purpose}`
                    && (p.deviceId == null || rel.fromId === p.deviceId)) {
                    this._rels.delete(key);
                }
            }
            return { cleared: true };
        }

        const relType = { default: "default_for", preferred: "preferred_for", fallback: "fallback_for" }[kind];

        if (!validateDeviceId(p.deviceId) || !this._devices.has(p.deviceId)) {
            throw fail("EMB_DEVICE_UNKNOWN", `preferensi untuk perangkat tak dikenal: '${p.deviceId}'`);
        }
        if (!this._devices.get(p.deviceId).capabilities.has(p.purpose)) {
            throw fail("EMB_CAPABILITY_MISMATCH",
                `${p.deviceId} tidak menyediakan ${p.purpose}`);
        }

        if (kind === "default") {
            for (const [key, rel] of [...this._rels]) {
                if (rel.type === "default_for" && rel.toId === `cap:${p.purpose}`) {
                    this._rels.delete(key);      // satu default per tujuan
                }
            }
        }
        this._setRel(deepFreeze({
            type: relType,
            fromId: p.deviceId,
            toId: `cap:${p.purpose}`,
            rank: Number.isFinite(p.rank) ? p.rank : 0,
            source: event.source,
            observedAtMs: event.timestampMs
        }));
        return { deviceId: p.deviceId, purpose: p.purpose, kind };
    }

    _applyAnalysisRequested(event) {
        this._analysisRequested.add(event.subject);
        return { analysisRequested: event.subject };
    }

    /* ------------------- derivasi default (tanpa LLM) ------------------ */

    _deriveDefaultChanges(triggerEvent) {
        if (this._deriving) return;
        this._deriving = true;
        try {
            const purposes = new Set(this._lastDefaults.keys());
            for (const rel of this._rels.values()) {
                if ([...PREFERENCE_TYPES].includes(rel.type)) {
                    purposes.add(rel.toId.slice(4));   // buang prefix "cap:"
                }
            }
            for (const purpose of purposes) {
                const now = this.resolvePreferred(purpose)[0]?.descriptor.deviceId ?? null;
                const prev = this._lastDefaults.get(purpose) ?? null;
                if (now === prev) continue;      // null→null bukan perubahan
                this._lastDefaults.set(purpose, now);
                const derived = makeEvent({
                    type: "DEVICE_DEFAULT_CHANGED",
                    source: CORE_SOURCE,
                    provenance: "SYSTEM_EVENT",
                    subject: now ?? prev,
                    payload: {
                        derived: true,
                        purpose,
                        previousDeviceId: prev,
                        nextDeviceId: now
                    },
                    clock: this.clock
                });
                this._journal.push(derived);
                for (const fn of this._subscribers) fn(derived, {});
            }
        } finally {
            this._deriving = false;
        }
    }

    _emitAnalysisRequested(descriptor, triggerEvent) {
        const deviceId = descriptor.deviceId;
        this._analysisRequested.add(deviceId);
        const derived = makeEvent({
            type: "UNKNOWN_DEVICE_REQUIRES_ANALYSIS",
            source: CORE_SOURCE,
            provenance: "SYSTEM_EVENT",
            subject: deviceId,
            payload: {
                evidence: {
                    descriptorDigest: digestOf(descriptor),
                    deviceClass: descriptor.deviceClass,
                    capabilities: descriptor.capabilities.map(c => c.name),
                    provenance: {
                        source: triggerEvent.source,
                        confidence: triggerEvent.confidence,
                        observedAt: triggerEvent.timestamp
                    },
                    identity: descriptor.identity,
                    metadata: descriptor.metadata
                }
            },
            clock: this.clock
        });
        this._journal.push(derived);
        for (const fn of this._subscribers) fn(derived, {});
    }

    /* ------------------------- preferensi publik ----------------------- */

    /**
     * Preferensi default/preferred/fallback adalah KEBIJAKAN operator,
     * bukan fakta penemuan — karena itu masuk lewat event inti eksplisit,
     * bukan lewat adapter. Tetap satu jalur tulis: ingest().
     */
    setPreference({ purpose, kind = "preferred", deviceId, rank }) {
        const event = makeEvent({
            type: "DEVICE_DEFAULT_CHANGED",
            source: CORE_SOURCE,
            provenance: "SYSTEM_EVENT",
            subject: deviceId ?? `policy.operator:clear-${this.clock.nowMs() % 1e9}`,
            payload: { explicit: true, kind, purpose, deviceId: deviceId ?? null, rank },
            clock: this.clock
        });
        return this.ingest(event);
    }

    /* ------------------------------ kueri ------------------------------ */

    /**
     * Potret keadaan beku — imutabel penuh. Perubahan skema SETELAH
     * potret tidak pernah menyentuh potret lama (dan sebaliknya):
     * rekaman internal selalu diganti utuh, tak pernah diubah di tempat.
     */
    snapshot() {
        return freezeView({
            takenAtMs: this.clock.nowMs(),
            digestDurable: this.digestDurable(),
            counts: this.counts(),
            devices: this.listDevices(),
            relationships: this.getRelationships()
        });
    }

    getDevice(deviceId) {
        const record = this._devices.get(deviceId);
        return record ? freezeView(this._viewOf(record)) : null;
    }

    listDevices(filter = {}) {
        let views = [...this._devices.values()].map(r => this._viewOf(r));
        if (filter.deviceClass != null) {
            views = views.filter(v => v.descriptor.deviceClass === filter.deviceClass);
        }
        if (filter.state != null) views = views.filter(v => v.descriptor.state === filter.state);
        if (filter.capability != null) {
            const cap = assertCapability(filter.capability);
            views = views.filter(v => v.descriptor.capabilities.some(c => c.name === cap));
        }
        views.sort((a, b) => a.descriptor.deviceId.localeCompare(b.descriptor.deviceId));
        return deepFreeze(views.map(freezeView));
    }

    devicesWithCapability(capabilityName) {
        return this.listDevices({ capability: capabilityName });
    }

    devicesByClass(deviceClass) {
        if (!DEVICE_CLASSES[deviceClass]) {
            throw fail("EMB_UNKNOWN_DEVICE_CLASS", `kelas tak dikenal: '${deviceClass}'`);
        }
        return this.listDevices({ deviceClass });
    }

    /**
     * Urutan preferensi deterministik utk sebuah tujuan (token kemampuan):
     *   default → preferred(rank) → fallback(rank) → penyedia lain (id asc).
     */
    resolvePreferred(purpose) {
        assertCapability(purpose);
        const providers = this.listDevices({ capability: purpose })
            .filter(v => v.descriptor.state === DEVICE_STATES.ONLINE);
        const ids = new Set(providers.map(v => v.descriptor.deviceId));

        const pick = (type) => [...this._rels.values()]
            .filter(r => r.type === type && r.toId === `cap:${purpose}` && ids.has(r.fromId))
            .sort((a, b) =>
                ((a.rank ?? 0) - (b.rank ?? 0))
                || a.fromId.localeCompare(b.fromId))
            .map(r => r.fromId);

        const ordered = [
            ...pick("default_for"),
            ...pick("preferred_for"),
            ...pick("fallback_for"),
            ...providers.map(v => v.descriptor.deviceId)
        ];
        const seen = new Set();
        const result = [];
        for (const id of ordered) {
            if (!seen.has(id)) { seen.add(id); result.push(this.getDevice(id)); }
        }
        return deepFreeze(result.filter(Boolean));
    }

    getRelationships(filter = {}) {
        let rels = [...this._rels.values()];
        if (filter.type != null) rels = rels.filter(r => r.type === filter.type);
        if (filter.fromId != null) rels = rels.filter(r => r.fromId === filter.fromId);
        if (filter.toId != null) rels = rels.filter(r => r.toId === filter.toId);
        rels.sort((a, b) =>
            `${a.type}|${a.fromId}`.localeCompare(`${b.type}|${b.fromId}`));
        return deepFreeze(structuredCopy(rels));
    }

    _channels(direction) {
        const channels = new Map();
        for (const record of this._devices.values()) {
            if (record.descriptor.state !== DEVICE_STATES.ONLINE) continue;
            for (const claim of record.capabilities.values()) {
                const cls = classifyCapability(claim.name);
                if (!cls || cls.direction !== direction) continue;
                if (!channels.has(claim.name)) {
                    channels.set(claim.name, {
                        channelId: claim.name,
                        direction,
                        modality: cls.modality,
                        deviceIds: []
                    });
                }
                channels.get(claim.name).deviceIds.push(record.descriptor.deviceId);
            }
        }
        const list = [...channels.values()]
            .sort((a, b) => a.channelId.localeCompare(b.channelId));
        for (const ch of list) ch.deviceIds.sort();
        return deepFreeze(structuredCopy(list));
    }

    /** Kanal indrawi yang tersedia saat ini (dari perangkat online). */
    sensorChannels() { return this._channels("sensor"); }

    /** Kanal aktuasi teknis yang ADA — bukan izin untuk memakainya. */
    actuatorChannels() { return this._channels("actuator"); }

    getChannelObservations(channelId) {
        return deepFreeze(structuredCopy(this._observations.get(channelId) ?? []));
    }

    deadLetters(limit = 50) {
        return this._deadLetters.slice(-limit);
    }

    journal() { return deepFreeze(structuredCopy(this._journal)); }

    counts() {
        const byState = { online: 0, offline: 0, removed: 0 };
        let unknown = 0;
        for (const r of this._devices.values()) {
            byState[r.descriptor.state]++;
            if (r.descriptor.deviceClass === DEVICE_CLASSES.UNKNOWN) unknown++;
        }
        return deepFreeze({
            devices: this._devices.size,
            byState, unknownDevices: unknown,
            relationships: this._rels.size,
            deadLetters: this._deadLetters.length
        });
    }

    /* --------------------- hook otonomik (non-executing) ---------------- */

    /**
     * Titik kait sistem saraf otonomik masa depan: pelanggan MENERIMA
     * event beku dan HANYA bisa membaca. Tidak ada API aksi di sini —
     * refleks produksi (mis. pindah ke mikrofon cadangan) adalah ranah
     * kebijakan berikutnya yang tetap wajib lewat Authority.
     */
    subscribe(fn) {
        this._subscribers.add(fn);
        return () => this._subscribers.delete(fn);
    }

    /* --------------------------- persistensi --------------------------- */

    /** Serialisasi DURABLE saja — identitas/riwayat, bukan observasi. */
    serialize() {
        return {
            version: 1,
            producers: [...this._producers].sort(),
            devices: [...this._devices.values()]
                .sort((a, b) => a.descriptor.deviceId.localeCompare(b.descriptor.deviceId))
                .map(r => ({
                    descriptor: r.descriptor,
                    meta: r.meta,
                    capabilities: [...r.capabilities.values()],
                    firstSeenAtMs: r.firstSeenAtMs,
                    lastSeenAtMs: r.lastSeenAtMs
                })),
            relationships: structuredCopy([...this._rels.values()])
                .sort((a, b) => `${a.type}|${a.fromId}|${a.toId}`
                    .localeCompare(`${b.type}|${b.fromId}|${b.toId}`)),
            preferencesResolved: Object.fromEntries(
                [...this._lastDefaults.entries()].sort())
        };
    }

    digestDurable() { return digestOf(this.serialize()); }

    async persist() {
        if (!this.store) throw fail("EMB_NO_STORE", "tidak ada store terpasang");
        await this.store.save(this.serialize());
    }

    /** Hidupkan kembali skema dari serialisasi (jalur tepercaya internal). */
    static restore(data, { clock = realClock(), store = null } = {}) {
        if (!data || data.version !== 1) {
            throw fail("EMB_INVALID_SERIALIZATION", "serialisasi tidak dikenal");
        }
        const schema = new BodySchema({ clock, store });
        for (const producer of data.producers ?? []) schema.registerProducer(producer);
        for (const row of data.devices ?? []) {
            schema._devices.set(row.descriptor.deviceId, {
                descriptor: deepFreeze(row.descriptor),
                meta: row.meta,
                capabilities: new Map((row.capabilities ?? []).map(c => [c.name, c])),
                firstSeenAtMs: row.firstSeenAtMs,
                lastSeenAtMs: row.lastSeenAtMs
            });
        }
        for (const rel of data.relationships ?? []) schema._setRel(deepFreeze(rel));
        for (const [k, v] of Object.entries(data.preferencesResolved ?? {})) {
            schema._lastDefaults.set(k, v);
        }
        return schema;
    }

    /* ------------------------------ intern ----------------------------- */

    _setRel(rel) {
        this._rels.set(`${rel.type}|${rel.fromId}|${rel.toId}`, rel);
    }

    _viewOf(record) {
        return {
            descriptor: record.descriptor,
            provenance: {
                source: record.meta.source,
                confidence: record.meta.confidence,
                observedAtMs: record.meta.timestampMs
            },
            capabilities: [...record.capabilities.values()],
            firstSeenAtMs: record.firstSeenAtMs,
            lastSeenAtMs: record.lastSeenAtMs
        };
    }

    _reject(reason, event) {
        if (this._deadLetters.length >= this.config.deadLetterCapacity) {
            this._deadLetters.shift();
        }
        this._deadLetters.push(Object.freeze({
            atMs: this.clock.nowMs(),
            reason,
            eventId: event && typeof event === "object" ? event.eventId ?? null : null,
            type: event && typeof event === "object" ? event.type ?? null : null
        }));
        return { accepted: false, reason };
    }
}

function freezeView(view) {
    return deepFreeze(structuredCopy(view));
}

module.exports = { BodySchema, newerWins };
