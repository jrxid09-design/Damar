/**
 * BodySchema — skema tubuh komputasi kepercayaan-keras (B§6, revisi v1).
 *
 * ATURAN TULIS TUNGGAL + ATOMIK: satu-satunya cara mengubah state adalah
 * ingest(event). Setiap event melalui dua fase:
 *   1) PLAN  — seluruh validasi (bentuk, produsen, deskriptor, subjek,
 *              relasi, klaim, keberadaan entitas) berjalan TANPA mutasi.
 *   2) COMMIT— hanya bila plan lolos seluruhnya, state diubah.
 * Jadi `accepted:false` SELALU berarti nol mutasi (byte-identik), dan
 * `accepted:true` tidak pernah dibatalkan oleh kesalahan pelanggan hook.
 *
 * PRODUSEN INTI TIDAK-DAPAT-DIPALSUKAN: event kelas "core" hanya sah bila
 * membawa token simbol privat modul ini (CORE_TOKEN). Objek event buatan
 * pihak luar tidak mungkin memilikinya — penyamaan string "sensorium.core"
 * saja tidak pernah cukup.
 *
 * KONVERGENSI BEBAS URUTAN KEDATANGAN: konten deskriptor dan kehadiran
 * (presence) masing-masing memakai urutan totalnya sendiri; himpunan
 * observasi yang sama selalu berkonvergen ke state yang sama.
 *
 * Event cacat / produsen asing dicarta ke deadLetters — tidak pernah ada
 * mutasi diam-diam.
 */

const {
    deepFreeze, structuredCopy, digestOf, canonicalJson, fail,
    realClock
} = require("../core/util");
const { validateDeviceId } = require("../core/identity");
const {
    DEVICE_CLASSES, DEVICE_STATES, HEALTH_STATES,
    PREFERENCE_TYPES, RELATIONSHIP_TYPES, isValidCapability, classifyCapability
} = require("../domain/types");
const { assertCapability, normalizeDescriptor, normalizeCapabilityClaim }
    = require("../domain/descriptor");
const {
    EVENT_TYPES, CORE_SOURCE, CORE_TOKEN, makeCoreEvent, validateEventShape
} = require("../sensorium/events");

const DEFAULTS = Object.freeze({
    observationCapacity: 32,     // observasi = EPHEMERAL, cincin terbatas
    deadLetterCapacity: 100,
    journalCapacity: 4096,
    analysisRequestCapacity: 10_000,
    subscriberErrorCapacity: 50
});

const STRUCTURAL_RELATIONSHIP_TYPES = Object.freeze([
    "attached_to", "connected_via", "provides", "depends_on",
    "located_on", "network_peer", "logical_child"
]);

const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;

/** Urutan total KONTEN antar-pengamatan deskriptor. */
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

/**
 * Urutan total KEHADIRAN (presence) — independen dari urutan kedatangan.
 * Terbaru menang; seri → confidence tinggi; seri → sumber kecil; tie
 * sempurna → nama state kanonik terkecil ("offline" < "online" < "removed").
 */
function presenceWins(a, b) {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs > b.timestampMs ? a : b;
    if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
    if (a.source !== b.source) return a.source < b.source ? a : b;
    return a.state <= b.state ? a : b;
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
        this._subscriberErrors = [];
        this._subscribers = new Set();
        this._deriving = false;
    }

    /* -------------------- batas kepercayaan produsen ------------------- */

    /** Daftarkan produsen observasi tepercaya — TINDAKAN OPERATOR. */
    registerProducer(source) {
        if (!/^[a-z][a-z0-9._-]{2,63}$/.test(String(source ?? ""))) {
            throw fail("EMB_INVALID_PRODUCER_ID", `id produsen tidak sah: '${source}'`);
        }
        this._producers.add(source);
        return this;
    }

    isProducerRegistered(source) {
        return this._producers.has(source);
    }

    /**
     * Satu-satunya pintu mutasi state. Atomik per event: penolakan
     * tidak pernah meninggalkan state setengah jadi.
     */
    ingest(event) {

        const shape = validateEventShape(event);
        if (!shape.ok) return this._reject(shape.reason, event);

        const producerClass = EVENT_TYPES[event.type].producerClass;

        if (producerClass === "core") {
            // Event inti hanya sah dari jalur internal bertoken.
            if (event.source !== CORE_SOURCE) {
                return this._reject("event-inti-dari-sumber-asing", event);
            }
            if (event[CORE_TOKEN] !== CORE_TOKEN) {
                return this._reject("event-inti-tanpa-token", event);
            }
        } else {
            // INVARIANT B/C: pihak tak-tepercaya tidak pernah sampai reducer;
            // provenance sistem juga cadangan jalur inti.
            if (!this._producers.has(event.source)) {
                return this._reject("produsen-tidak-terdaftar", event);
            }
            if (event.provenance === "SYSTEM_EVENT") {
                return this._reject("provenance-inti-dipalsukan", event);
            }
        }

        try {
            const plan = this._plan(event);          // fase 1: validasi penuh
            const result = this._commit(plan, event);// fase 2: mutasi sekali

            this._pushJournal(event);

            if (!event.payload?.derived) {
                this._deriveDefaultChanges();
            }

            // Notifikasi SETELAH komit; kegagalan callback terisolasi
            // per pelanggan dan tidak pernah mengubah status event.
            this._notify(event, result);
            return { accepted: true, ...result };
        } catch (err) {
            return this._reject(err.code || "applier-gagal", event);
        }
    }

    /* ----------------------- fase 1: RENCANA --------------------------- */

    /**
     * Validasi menyeluruh TANPA menyentuh state hidup. Melempar (kode
     * EMB_*) berarti event ditolak sebelum satu byte pun berubah.
     */
    _plan(event) {
        switch (event.type) {
            case "DEVICE_DISCOVERED":
                return this._planDiscovered(event, { allowNew: true });
            case "DEVICE_CHANGED":
                return this._planDiscovered(event, { allowNew: false });
            case "DEVICE_ONLINE":
                return this._planPresence(event, DEVICE_STATES.ONLINE);
            case "DEVICE_OFFLINE":
                return this._planPresence(event, DEVICE_STATES.OFFLINE);
            case "DEVICE_REMOVED":
                return this._planPresence(event, DEVICE_STATES.REMOVED);
            case "DEVICE_HEALTH_CHANGED": return this._planHealth(event);
            case "CAPABILITY_DISCOVERED": return this._planCapability(event);
            case "SENSOR_OBSERVATION": return this._planObservation(event);
            case "DEVICE_DEFAULT_CHANGED": return this._planPreference(event);
            case "UNKNOWN_DEVICE_REQUIRES_ANALYSIS":
                return { kind: "analysis-requested" };
            default:
                throw fail("EMB_UNKNOWN_EVENT_TYPE", `tipe tak tertangani: ${event.type}`);
        }
    }

    _planDiscovered(event, { allowNew }) {

        const raw = event.payload.descriptor;
        if (!raw || typeof raw !== "object") {
            throw fail("EMB_INVALID_PAYLOAD", "payload.descriptor hilang");
        }
        const descriptor = normalizeDescriptor(raw);

        // Subjek event WAJIB identitas yang benar-benar dimutasi — jurnal
        // forensik tidak boleh menunjuk A sambil mengubah B.
        if (event.subject !== descriptor.deviceId) {
            throw fail("EMB_SUBJECT_MISMATCH",
                `subjek '${event.subject}' != deskriptor '${descriptor.deviceId}'`);
        }

        const existing = this._devices.get(descriptor.deviceId);
        if (!existing && !allowNew) {
            throw fail("EMB_DEVICE_UNKNOWN",
                `perangkat belum terdaftar: ${descriptor.deviceId}`);
        }

        // Klaim kemampuan divalidasi ulang di sini (normalizeDescriptor
        // sudah melakukannya; eksplisit demi kejelasan batas validasi).
        const claims = descriptor.capabilities.map(c =>
            normalizeCapabilityClaim(c));

        // Seluruh relasi tervalidasi SEBELUM komit — ujung hantu ditolak.
        const knownIds = new Set(this._devices.keys());
        knownIds.add(descriptor.deviceId);   // perangkat baru ikut sah sebagai ujung 'from'
        const relationships = (event.payload.relationships ?? []).map(rel =>
            this._validateStructuralRelationship(rel, knownIds));

        const candidate = deepFreeze({
            confidence: event.confidence,
            source: event.source,
            timestampMs: event.timestampMs,
            digest: digestOf(descriptor)
        });

        const presence = deepFreeze({
            state: descriptor.state,
            timestampMs: event.timestampMs,
            confidence: event.confidence,
            source: event.source
        });

        return {
            kind: "device-content",
            deviceId: descriptor.deviceId,
            isNew: !existing,
            descriptor, claims, candidate, presence, relationships
        };
    }

    _planPresence(event, state) {
        const record = this._devices.get(event.subject);
        if (!record) {
            throw fail("EMB_DEVICE_UNKNOWN",
                `perangkat tidak dikenal: ${event.subject}`);
        }
        return {
            kind: "presence",
            deviceId: event.subject,
            state,
            proposal: deepFreeze({
                state, timestampMs: event.timestampMs,
                confidence: event.confidence, source: event.source
            })
        };
    }

    _planHealth(event) {
        const record = this._devices.get(event.subject);
        if (!record) {
            throw fail("EMB_DEVICE_UNKNOWN",
                `perangkat tidak dikenal: ${event.subject}`);
        }
        const status = event.payload.health?.status;
        if (!HEALTH_STATES[status]) {
            throw fail("EMB_UNKNOWN_HEALTH_STATE",
                `kesehatan tidak dikenal: '${status}'`);
        }
        return {
            kind: "health", deviceId: event.subject, status,
            detail: event.payload.health.detail != null
                ? String(event.payload.health.detail).slice(0, 200) : null
        };
    }

    _planCapability(event) {
        const record = this._devices.get(event.subject);
        if (!record) {
            throw fail("EMB_DEVICE_UNKNOWN",
                `perangkat tidak dikenal: ${event.subject}`);
        }
        const claim = normalizeCapabilityClaim(event.payload.capability);
        return { kind: "claim", deviceId: event.subject, claim };
    }

    _planObservation(event) {
        const record = this._devices.get(event.subject);
        if (!record) {
            throw fail("EMB_DEVICE_UNKNOWN", "observasi untuk perangkat tak dikenal");
        }
        const channel = event.payload.channel;
        if (!channel || !CHANNEL_ID_PATTERN.test(String(channel.id ?? ""))) {
            throw fail("EMB_INVALID_CHANNEL", "kanal observasi tidak sah");
        }
        const classification = classifyCapability(String(channel.id));
        // Sensor mengamati; ia tidak menyentuh kanal aktuasi (invariant F).
        if (!classification || classification.direction !== "sensor") {
            throw fail("EMB_INVALID_CHANNEL",
                `kanal observasi bukan sensor: '${channel.id}'`);
        }
        const sample = JSON.stringify(event.payload.sample ?? null);
        if (sample.length > 2048) {
            throw fail("EMB_OBSERVATION_TOO_LARGE", "sampel observasi > 2KB");
        }
        return {
            kind: "observation", deviceId: event.subject,
            channelId: channel.id, modality: classification.modality,
            sample: event.payload.sample ?? null
        };
    }

    _planPreference(event) {
        const p = event.payload;
        if (!p.explicit) return { kind: "passthrough" };   // turunan: hanya jurnal

        const kind = p.kind;
        if (!["default", "preferred", "fallback", "clear"].includes(kind)) {
            throw fail("EMB_INVALID_PREFERENCE_KIND", `jenis preferensi tidak sah: '${kind}'`);
        }
        assertCapability(p.purpose);

        if (kind === "clear") {
            return { kind: "preference-clear", purpose: p.purpose, deviceId: p.deviceId ?? null };
        }

        if (!validateDeviceId(p.deviceId) || !this._devices.has(p.deviceId)) {
            throw fail("EMB_DEVICE_UNKNOWN",
                `preferensi untuk perangkat tak dikenal: '${p.deviceId}'`);
        }
        if (!this._devices.get(p.deviceId).capabilities.has(p.purpose)) {
            throw fail("EMB_CAPABILITY_MISMATCH",
                `${p.deviceId} tidak menyediakan ${p.purpose}`);
        }
        return {
            kind: "preference-set", purpose: p.purpose, deviceId: p.deviceId,
            relType: { default: "default_for", preferred: "preferred_for", fallback: "fallback_for" }[kind],
            rank: Number.isFinite(p.rank) ? p.rank : 0
        };
    }

    /** Validasi relasi struktural — murni, tanpa mutasi. */
    _validateStructuralRelationship(raw, knownIds) {
        if (!raw || typeof raw !== "object") {
            throw fail("EMB_INVALID_RELATIONSHIP", "relasi bukan objek");
        }
        const { type, fromId, toId } = raw;
        if (!STRUCTURAL_RELATIONSHIP_TYPES.includes(type)) {
            throw fail("EMB_UNKNOWN_RELATIONSHIP_TYPE",
                `tipe relasi struktural tidak dikenal: '${type}'`);
        }
        if (!validateDeviceId(fromId) || !knownIds.has(fromId)) {
            throw fail("EMB_RELATIONSHIP_DANGLING_FROM",
                `ujung 'from' tidak dikenal: '${fromId}'`);
        }
        let target = null;
        if (type === "provides") {
            assertCapability(toId);           // target kemampuan, bukan entitas
            target = `cap:${toId}`;
        } else {
            if (!validateDeviceId(toId) || !knownIds.has(toId)) {
                throw fail("EMB_RELATIONSHIP_DANGLING_TO",
                    `ujung 'to' tidak dikenal: '${toId}'`);
            }
            target = toId;
        }
        return deepFreeze({
            type, fromId, toId: target,
            rank: Number.isFinite(raw.rank) ? raw.rank : null,
            observedAtMs: null   // diisi saat komit dari event
        });
    }

    /* ------------------------ fase 2: KOMIT ---------------------------- */

    _commit(plan, event) {
        switch (plan.kind) {
            case "device-content": return this._commitContent(plan, event);
            case "presence": return this._commitPresence(plan);
            case "health": return this._commitHealth(plan, event);
            case "claim": return this._commitClaim(plan);
            case "observation": return this._commitObservation(plan, event);
            case "preference-set": return this._commitPreferenceSet(plan, event);
            case "preference-clear": return this._commitPreferenceClear(plan);
            case "analysis-requested":
                this._analysisRequested.add(event.subject);
                this._capAnalysisRequested();
                return { analysisRequested: event.subject };
            case "passthrough":
                return { passthrough: true };
            default:
                throw fail("EMB_INTERNAL", `rencana tak dikenal: ${plan.kind}`);
        }
    }

    _commitContent(plan, event) {

        let record = this._devices.get(plan.deviceId);

        if (!record) {
            record = {
                descriptor: plan.descriptor,
                meta: plan.candidate,
                presence: plan.presence,
                capabilities: new Map(),
                firstSeenAtMs: event.timestampMs,
                lastSeenAtMs: event.timestampMs
            };
            this._devices.set(plan.deviceId, record);
        } else {
            // Konten: urutan total newerWins (bebas arah kedatangan).
            if (newerWins(plan.candidate, record.meta) === plan.candidate) {
                record.meta = plan.candidate;
                record.descriptor = plan.descriptor;
            }
            // Kehadiran: urutan total presenceWins — pengamatan usang
            // yang datang belakangan TIDAK bisa menimpa state segar.
            record.presence = presenceWins(plan.presence, record.presence);
            record.lastSeenAtMs =
                Math.max(record.lastSeenAtMs, event.timestampMs);
        }

        for (const claim of plan.claims) this._installClaim(record, claim);
        this._syncRecord(record);

        // Hook RE untuk perangkat UNKNOWN baru — event turunan internal.
        if (plan.isNew
            && record.descriptor.deviceClass === DEVICE_CLASSES.UNKNOWN
            && !this._analysisRequested.has(plan.deviceId)) {
            this._emitAnalysisRequested(record.descriptor, event);
        }

        for (const rel of plan.relationships) {
            this._setRel(deepFreeze({
                ...rel, observedAtMs: event.timestampMs, source: event.source
            }));
        }

        return { deviceId: plan.deviceId, isNew: plan.isNew };
    }

    _commitPresence(plan) {
        const record = this._devices.get(plan.deviceId);
        record.presence = presenceWins(plan.proposal, record.presence);
        this._syncRecord(record);
        return { deviceId: plan.deviceId, state: record.descriptor.state };
    }

    _commitHealth(plan, event) {
        const record = this._devices.get(plan.deviceId);
        const health = deepFreeze({
            status: plan.status,
            detail: plan.detail,
            checkedAt: new Date(event.timestampMs).toISOString()
        });
        record.descriptor = deepFreeze({ ...record.descriptor, health });
        record.meta = deepFreeze({
            ...record.meta, digest: digestOf(record.descriptor)
        });
        return { deviceId: plan.deviceId, health };
    }

    _commitClaim(plan) {
        const record = this._devices.get(plan.deviceId);
        this._installClaim(record, plan.claim);
        this._syncRecord(record);
        return { deviceId: plan.deviceId, capability: plan.claim.name };
    }

    /**
     * Gabungkan klaim secara deterministik: persis-sama = NO-OP; prioritas
     * sama (confidence+sumber) diselesaikan lewat JSON kanonik terkecil —
     * bukan urutan kedatangan.
     */
    _installClaim(record, incoming) {
        const current = record.capabilities.get(incoming.name);
        if (current) {
            if (canonicalJson(current) === canonicalJson(incoming)) return;
            const better =
                incoming.confidence > current.confidence ||
                (incoming.confidence === current.confidence &&
                    incoming.source < current.source) ||
                (incoming.confidence === current.confidence &&
                    incoming.source === current.source &&
                    canonicalJson(incoming) < canonicalJson(current));
            if (!better) return;
        }
        record.capabilities.set(incoming.name, incoming);
    }

    /** Materialisasi kanonik: capabilities TERURUT nama (+tie kanonik). */
    _syncRecord(record) {
        const capabilities = [...record.capabilities.values()]
            .sort((a, b) =>
                a.name.localeCompare(b.name) ||
                canonicalJson(a).localeCompare(canonicalJson(b)));

        record.descriptor = deepFreeze({
            ...record.descriptor,
            state: record.presence.state,
            capabilities
        });
        record.meta = deepFreeze({
            ...record.meta, digest: digestOf(record.descriptor)
        });
    }

    _commitObservation(plan, event) {
        if (!this._observations.has(plan.channelId)) {
            this._observations.set(plan.channelId, []);
        }
        const ring = this._observations.get(plan.channelId);
        if (ring.length >= this.config.observationCapacity) ring.shift();
        ring.push(Object.freeze({
            channelId: plan.channelId,
            modality: plan.modality,
            deviceId: plan.deviceId,
            sample: plan.sample,
            confidence: event.confidence,
            source: event.source,
            atMs: event.timestampMs
        }));
        return { deviceId: plan.deviceId, channelId: plan.channelId };
    }

    _commitPreferenceSet(plan, event) {
        if (plan.relType === "default_for") {
            for (const [key, rel] of [...this._rels]) {
                if (rel.type === "default_for" && rel.toId === `cap:${plan.purpose}`) {
                    this._rels.delete(key);      // satu default per tujuan
                }
            }
        }
        this._setRel(deepFreeze({
            type: plan.relType,
            fromId: plan.deviceId,
            toId: `cap:${plan.purpose}`,
            rank: plan.rank,
            source: event.source,
            observedAtMs: event.timestampMs
        }));
        return { deviceId: plan.deviceId, purpose: plan.purpose };
    }

    _commitPreferenceClear(plan) {
        for (const [key, rel] of [...this._rels]) {
            if ([...PREFERENCE_TYPES].includes(rel.type)
                && rel.toId === `cap:${plan.purpose}`
                && (plan.deviceId == null || rel.fromId === plan.deviceId)) {
                this._rels.delete(key);
            }
        }
        return { cleared: true };
    }

    /* ------------------ event inti (bertoken, internal) ---------------- */

    /**
     * Pabrik event inti — meneruskan ke makeCoreEvent() internal modul,
     * satu-satunya sumber CORE_TOKEN di semesta.
     */
    _makeCoreEvent(type, subject, payload) {
        return makeCoreEvent({ type, subject, payload, clock: this.clock });
    }

    _emitAnalysisRequested(descriptor, triggerEvent) {
        const deviceId = descriptor.deviceId;
        this._analysisRequested.add(deviceId);
        this._capAnalysisRequested();

        const derived = this._makeCoreEvent(
            "UNKNOWN_DEVICE_REQUIRES_ANALYSIS", deviceId,
            {
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
            });

        this._pushJournal(derived);
        this._notify(derived, {});
    }

    _capAnalysisRequested() {
        if (this._analysisRequested.size > this.config.analysisRequestCapacity) {
            const oldest = this._analysisRequested.values().next().value;
            this._analysisRequested.delete(oldest);
        }
    }

    _pushJournal(event) {
        if (this._journal.length >= this.config.journalCapacity) {
            this._journal.shift();
        }
        this._journal.push(event);
    }

    /* ------------------- derivasi default (tanpa LLM) ------------------ */

    _deriveDefaultChanges() {
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
                const derived = this._makeCoreEvent(
                    "DEVICE_DEFAULT_CHANGED",
                    now ?? prev,
                    {
                        derived: true,
                        purpose,
                        previousDeviceId: prev,
                        nextDeviceId: now
                    });
                this._pushJournal(derived);
                this._notify(derived, {});
            }
        } finally {
            this._deriving = false;
        }
    }

    /* ------------------------- preferensi publik ----------------------- */

    /**
     * Preferensi adalah KEBIJAKAN operator — masuk lewat event inti
     * eksplisit (bertoken internal), bukan lewat adapter.
     */
    setPreference({ purpose, kind = "preferred", deviceId, rank }) {
        const event = this._makeCoreEvent(
            "DEVICE_DEFAULT_CHANGED",
            deviceId ?? `policy.operator:clear-${this.clock.nowMs() % 1e9}`,
            { explicit: true, kind, purpose, deviceId: deviceId ?? null, rank });
        return this.ingest(event);
    }

    /* ------------------------------ kueri ------------------------------ */

    /**
     * Potret keadaan beku — imutabel dan TERLEPAS (tidak beralias dengan
     * state hidup maupun potret lain).
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
        return deepFreeze(structuredCopy(this._deadLetters.slice(-limit)));
    }

    subscriberErrors(limit = 20) {
        return deepFreeze(structuredCopy(this._subscriberErrors.slice(-limit)));
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
     * event beku dan HANYA bisa membaca. Kegagalan callback dicatat
     * terpisah (subscriberErrors) dan TIDAK pernah menggugurkan event
     * yang telah dikomit.
     */
    subscribe(fn) {
        this._subscribers.add(fn);
        return () => this._subscribers.delete(fn);
    }

    _notify(event, result) {
        for (const fn of [...this._subscribers]) {
            try {
                fn(event, result);
            } catch (err) {
                if (this._subscriberErrors.length >= this.config.subscriberErrorCapacity) {
                    this._subscriberErrors.shift();
                }
                this._subscriberErrors.push(Object.freeze({
                    atMs: this.clock.nowMs(),
                    eventId: event.eventId,
                    message: String(err?.message ?? err).slice(0, 200)
                }));
            }
        }
    }

    /* --------------------------- persistensi --------------------------- */

    /**
     * Serialisasi DURABLE, TERLEPAS PENUH (deep-detached): tidak ada satu
     * pun objek hidup yang bocor ke hasil — pemanggil bebas memutasi
     * hasilnya tanpa pernah menyentuh skema.
     */
    serialize() {
        const detached = structuredCopy({
            version: 1,
            producers: [...this._producers]
                .filter(p => p !== CORE_SOURCE).sort(),
            devices: [...this._devices.values()]
                .sort((a, b) => a.descriptor.deviceId.localeCompare(b.descriptor.deviceId))
                .map(r => ({
                    descriptor: r.descriptor,
                    meta: r.meta,
                    capabilities: [...r.capabilities.values()]
                        .sort((a, b) =>
                            a.name.localeCompare(b.name) ||
                            canonicalJson(a).localeCompare(canonicalJson(b))),
                    firstSeenAtMs: r.firstSeenAtMs,
                    lastSeenAtMs: r.lastSeenAtMs
                })),
            relationships: [...this._rels.values()]
                .sort((a, b) => `${a.type}|${a.fromId}|${a.toId}`
                    .localeCompare(`${b.type}|${b.fromId}|${b.toId}`)),
            preferencesResolved: Object.fromEntries(
                [...this._lastDefaults.entries()].sort())
        });
        return deepFreeze(detached);
    }

    digestDurable() { return digestOf(this.serialize()); }

    async persist() {
        if (!this.store) throw fail("EMB_NO_STORE", "tidak ada store terpasang");
        await this.store.save(this.serialize());
    }

    /**
     * Hidupkan kembali dari serialisasi — BATAS INPUT TIDAK TERPERCAYA.
     *
     * Kebijakan gagal-tutup (A): SATU SAJA baris cacat menolak SELURUH
     * snapshot. Tidak ada karantina parsial — state tubuh yang setengah
     * dipulihkan lebih berbahaya daripada mulai dari nol. Semua baris
     * melewati validator yang SAMA dengan jalur ingest:
     *   - normalizeDescriptor (whitelist, enum, deviceId kanonik)
     *   - verifikasi digest per deskriptor (anti-tamper)
     *   - klaim kemampuan dinormalisasi ulang
     *   - relasi: tipe struktural + kedua ujung harus ada (tanpa hantu)
     * Diagnostik lengkap dilampirkan pada error.details.
     */
    static restore(data, { clock = realClock(), store = null } = {}) {

        const errors = [];
        const rejectRow = (where, err) => {
            errors.push(`${where}: ${err.code ?? "ERR"} — ${err.message}`);
        };

        if (!data || typeof data !== "object" || data.version !== 1) {
            throw fail("EMB_INVALID_SERIALIZATION",
                "serialisasi tidak dikenal (version !== 1)");
        }

        // --- produsen -------------------------------------------------
        const producers = [];
        for (const p of Array.isArray(data.producers) ? data.producers : []) {
            if (/^[a-z][a-z0-9._-]{2,63}$/.test(String(p))) producers.push(p);
            else errors.push(`producers: id tidak sah '${p}'`);
        }

        // --- perangkat (divalidasi dulu ke panggung, belum dipasang) ---
        const staged = new Map();
        for (const [i, row] of (data.devices ?? []).entries()) {
            try {
                if (!row || typeof row !== "object") {
                    throw fail("EMB_INVALID_DESCRIPTOR", `baris#${i} bukan objek`);
                }
                const descriptor = normalizeDescriptor(row.descriptor, {});
                for (const c of descriptor.capabilities) {
                    normalizeCapabilityClaim(c);
                }
                const meta = row.meta ?? {};
                if (!Number.isFinite(Number(meta.confidence))
                    || typeof meta.source !== "string"
                    || meta.source.length === 0 || meta.source.length > 120
                    || !Number.isInteger(meta.timestampMs)) {
                    throw fail("EMB_INVALID_META", `baris#${i}: meta tidak sah`);
                }
                const recomputed = digestOf(descriptor);
                if (meta.digest !== recomputed) {
                    throw fail("EMB_DIGEST_MISMATCH",
                        `baris#${i} (${descriptor.deviceId}): digest tidak cocok`);
                }
                if (!Number.isInteger(row.firstSeenAtMs)
                    || !Number.isInteger(row.lastSeenAtMs)) {
                    throw fail("EMB_INVALID_TIMESTAMPS",
                        `baris#${i}: stempel waktu tidak sah`);
                }
                staged.set(descriptor.deviceId, {
                    descriptor,
                    meta: deepFreeze({
                        confidence: Number(meta.confidence),
                        source: meta.source,
                        timestampMs: meta.timestampMs,
                        digest: recomputed
                    }),
                    capabilities: new Map(descriptor.capabilities.map(c => [c.name, c])),
                    firstSeenAtMs: row.firstSeenAtMs,
                    lastSeenAtMs: row.lastSeenAtMs
                });
            } catch (err) {
                rejectRow(`devices[${i}]`, err);
            }
        }

        // --- relasi (kedua ujung wajib dikenal di panggung) ------------
        const relationships = [];
        for (const [i, rel] of (data.relationships ?? []).entries()) {
            try {
                if (!rel || typeof rel !== "object") {
                    throw fail("EMB_INVALID_RELATIONSHIP", `relasi#${i} bukan objek`);
                }
                const type = rel.type;
                if (!RELATIONSHIP_TYPES[type]) {
                    throw fail("EMB_UNKNOWN_RELATIONSHIP_TYPE", `tipe '${type}'`);
                }
                if (!staged.has(rel.fromId)) {
                    throw fail("EMB_RELATIONSHIP_DANGLING_FROM", `'${rel.fromId}'`);
                }
                let toId;
                if (type === "provides") {
                    assertCapability(rel.toId);
                    toId = `cap:${rel.toId}`;
                } else if ([...PREFERENCE_TYPES].includes(type)) {
                    // Relasi preferensi juga durable (kebijakan operator);
                    // bentuk tersimpan sudah berprefix "cap:".
                    const rawTo = String(rel.toId ?? "").startsWith("cap:")
                        ? rel.toId.slice(4) : rel.toId;
                    assertCapability(rawTo);
                    toId = `cap:${rawTo}`;
                } else {
                    if (!staged.has(rel.toId)) {
                        throw fail("EMB_RELATIONSHIP_DANGLING_TO", `'${rel.toId}'`);
                    }
                    toId = rel.toId;
                }
                relationships.push(deepFreeze({
                    type, fromId: rel.fromId, toId,
                    rank: Number.isFinite(rel.rank) ? rel.rank : null,
                    source: String(rel.source ?? "restored").slice(0, 120),
                    observedAtMs: Number.isInteger(rel.observedAtMs)
                        ? rel.observedAtMs : null
                }));
            } catch (err) {
                rejectRow(`relationships[${i}]`, err);
            }
        }

        // --- resolusi preferensi ---------------------------------------
        const preferencesResolved = {};
        for (const [purpose, deviceId] of Object.entries(data.preferencesResolved ?? {})) {
            if (!isValidCapability(purpose)) {
                errors.push(`preferencesResolved: tujuan tidak sah '${purpose}'`);
            } else if (deviceId !== null && !staged.has(deviceId)) {
                errors.push(`preferencesResolved: perangkat hilang '${deviceId}'`);
            } else {
                preferencesResolved[purpose] = deviceId;
            }
        }

        // KEBIJAKAN A — satu saja cacat menolak seluruh snapshot.
        if (errors.length > 0) {
            const err = fail("EMB_INVALID_SERIALIZATION",
                `snapshot ditolak gagal-tutup (${errors.length} temuan)`);
            err.details = Object.freeze(errors);
            throw err;
        }

        // Baru sekarang instalasi — semua tervalidasi, tanpa referensi
        // objek milik pemanggil.
        const schema = new BodySchema({ clock, store });
        for (const p of producers) schema.registerProducer(p);
        for (const [id, rec] of staged) {
            schema._devices.set(id, rec);
        }
        for (const rel of relationships) schema._setRel(rel);
        for (const [k, v] of Object.entries(preferencesResolved)) {
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

/** Salinan beku yang TERLEPAS — tidak pernah beralias dengan state hidup. */
function freezeView(view) {
    return deepFreeze(structuredCopy(view));
}

module.exports = { BodySchema, newerWins, presenceWins };
