/**
 * Kontrak DiscoveryAdapter (B§5a).
 *
 * Adapter = produsen observasi tepercaya. Ia MENGAMATI perangkat keras
 * dan melaporkannya sebagai event — TIDAK PERNAH memberi otoritas.
 * Pendaftaran adapter ke BodySchema (registerProducer) adalah tindakan
 * operator/tepercaya, bukan sesuatu yang bisa dilakukan model.
 *
 * Kontrak minimal:
 *   {
 *     id:          "windows.audio" | "fake.discovery" | ...  (id produsen)
 *     namespaces:  ["windows.audio", ...]   // domain identitas yang dilaporkan
 *     next():      langkah observasi berikutnya → daftar operasi:
 *                    { discover: [rawDescriptor...] }
 *                    { remove: [deviceId...] } / offline / online
 *                    { health: {deviceId, status, detail} }
 *                    { capability: {deviceId, name} }
 *                  [] berarti tenang (tidak ada perubahan).
 *   }
 *
 * V0 menyediakan: fake deterministik + satu adapter host nyata kecil.
 * Adapter Windows/HomeAssistant lain tinggal mengikuti kontrak ini.
 */

const { fail } = require("../core/util");
const { makeEvent } = require("../sensorium/events");

function validateAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") {
        throw fail("EMB_INVALID_ADAPTER", "adapter bukan objek");
    }
    if (!/^[a-z][a-z0-9._-]{2,63}$/.test(String(adapter.id ?? ""))) {
        throw fail("EMB_INVALID_PRODUCER_ID", `id adapter tidak sah: '${adapter.id}'`);
    }
    if (!Array.isArray(adapter.namespaces) || adapter.namespaces.length === 0) {
        throw fail("EMB_INVALID_ADAPTER", "adapter wajib mendeklarasikan namespace");
    }
    if (typeof adapter.next !== "function") {
        throw fail("EMB_INVALID_ADAPTER", "adapter wajib punya next()");
    }
    return adapter;
}

/**
 * Jalankan satu siklus discovery secara deterministik: ambil langkah
 * dari adapter, terjemahkan menjadi event sah, serahkan ke BodySchema.
 */
function runDiscoveryCycle(schema, adapter) {

    validateAdapter(adapter);
    schema.registerProducer(adapter.id);
    const step = adapter.next() ?? [];

    const results = [];
    for (const op of step) {

        if (op?.discover) {
            for (const raw of op.discover) {
                // Relasi topologi dibawa terpisah dari deskriptor —
                // whitelist deskriptor tidak mengenal field tersebut.
                const { relationships, ...descriptor } = raw;
                results.push(schema.ingest(makeEvent({
                    type: "DEVICE_DISCOVERED",
                    source: adapter.id,
                    provenance: "SYSTEM_SENSOR",
                    subject: descriptor.deviceId,
                    payload: {
                        descriptor,
                        relationships: relationships ?? []
                    },
                    confidence: op.confidence ?? 1,
                    clock: schema.clock
                })));
            }

        } else if (op?.remove || op?.offline || op?.online) {
            const type = op.remove ? "DEVICE_REMOVED"
                : op.offline ? "DEVICE_OFFLINE" : "DEVICE_ONLINE";
            for (const deviceId of op.remove ?? op.offline ?? op.online) {
                results.push(schema.ingest(makeEvent({
                    type, source: adapter.id, provenance: "OBSERVATION",
                    subject: deviceId, clock: schema.clock
                })));
            }

        } else if (op?.health) {
            results.push(schema.ingest(makeEvent({
                type: "DEVICE_HEALTH_CHANGED",
                source: adapter.id, provenance: "SYSTEM_SENSOR",
                subject: op.health.deviceId,
                payload: { health: op.health },
                clock: schema.clock
            })));

        } else if (op?.capability) {
            results.push(schema.ingest(makeEvent({
                type: "CAPABILITY_DISCOVERED",
                source: adapter.id, provenance: "SYSTEM_SENSOR",
                subject: op.capability.deviceId,
                payload: { capability: op.capability.claim },
                confidence: op.capability.confidence ?? 1,
                clock: schema.clock
            })));

        } else if (Object.keys(op ?? {}).length > 0) {
            throw fail("EMB_INVALID_ADAPTER_STEP",
                `operasi discovery tidak dikenal: '${JSON.stringify(op).slice(0, 60)}'`);
        }
    }
    return results;
}

module.exports = { validateAdapter, runDiscoveryCycle };
