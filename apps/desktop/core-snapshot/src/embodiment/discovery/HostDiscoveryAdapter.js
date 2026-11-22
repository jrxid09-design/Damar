/**
 * HostDiscoveryAdapter — satu-satunya adapter NYATA di V0 (B§5c).
 *
 * Sengaja kecil dan tanpa dependensi: node:os saja. Ia melaporkan
 * tubuh minimal host — HOST/CPU/MEMORY/NETWORK_INTERFACE — dengan
 * kejujuran identitas:
 *   - hostname   → "stable"  (berubah hanya saat operator mengganti)
 *   - cpu/mem    → "session" (model/ukuran bisa berarti mesin lain)
 *   - interface  → "stable" hanya bila MAC nyata DAN unik dalam siklus;
 *                  MAC ganda → kunci deterministik per-nama + klaim
 *                  "session" yang jujur. Identitas akhir SELALU lewat
 *                  canonicalDeviceId().
 */

const os = require("node:os");
const { sha256Hex } = require("../core/util");
const { canonicalDeviceId, fallbackStableKey } = require("../core/identity");
const { DEVICE_CLASSES, IDENTITY_STABILITY } = require("../domain/types");
const { validateAdapter } = require("./adapter");

function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "").slice(0, 60) || "tanpa-nama";
}

/**
 * @param {object} [deps] injeksi modul os untuk pengujian deterministik.
 */
function createHostSelfDiscoveryAdapter(deps = {}) {
    const sys = deps.os ?? os;

    return validateAdapter({
        id: "host.os",
        namespaces: ["host.os", "net.os"],
        next() {

            const cpus = sys.cpus();
            const totalMem = sys.totalmem();
            const hostKey = slug(sys.hostname());
            const hostId = canonicalDeviceId({
                namespace: "host.os", stableKey: hostKey
            });

            // Kunci CPU konsisten antara deviceId dan identity.stableKey:
            const cpuKey =
                `cpu-${sha256Hex(
                    `${cpus[0]?.model ?? "unknown"}|${cpus.length}`).slice(0, 12)}`;

            const descriptors = [
                {
                    deviceId: hostId,
                    deviceClass: DEVICE_CLASSES.HOST,
                    displayName: sys.hostname(),
                    identity: {
                        namespace: "host.os",
                        stableKey: hostKey,
                        stability: IDENTITY_STABILITY.stable
                    },
                    capabilities: ["device.health.read"],
                    metadata: { platform: sys.platform(), arch: sys.arch() }
                },
                {
                    deviceId: canonicalDeviceId({
                        namespace: "host.os", stableKey: cpuKey
                    }),
                    deviceClass: DEVICE_CLASSES.CPU,
                    displayName: cpus[0]?.model?.slice(0, 80) ?? "CPU",
                    identity: {
                        namespace: "host.os",
                        stableKey: cpuKey,
                        stability: IDENTITY_STABILITY.session
                    },
                    capabilities: [],
                    metadata: { cores: cpus.length }
                },
                {
                    deviceId: canonicalDeviceId({
                        namespace: "host.os", stableKey: `mem-${totalMem}`
                    }),
                    deviceClass: DEVICE_CLASSES.MEMORY,
                    displayName: `Memori ${(totalMem / 2 ** 30).toFixed(1)} GiB`,
                    identity: {
                        namespace: "host.os",
                        stableKey: `mem-${totalMem}`,
                        stability: IDENTITY_STABILITY.session
                    },
                    capabilities: [],
                    metadata: { totalBytes: String(totalMem) }
                },
                ...nicDescriptors(sys, hostId)
            ];

            // Relasi host → anak ditempel dari sisi anak (attached_to):
            for (const d of descriptors) {
                if (d.deviceId !== hostId && !d.relationships) {
                    d.relationships =
                        [{ type: "attached_to", fromId: d.deviceId, toId: hostId }];
                }
            }

            return [{ discover: descriptors }];
        }
    });
}

/**
 * Deskriptor antarmuka jaringan. Dua NIC dengan MAC sama TETAP dua
 * perangkat: kunci memuat nama kanonik + MAC; bila MAC terduplikasi
 * dalam satu siklus, kestabilan diturunkan jujur ke "session".
 */
function nicDescriptors(sys, hostId) {
    const ifaces = Object.entries(sys.networkInterfaces())
        .filter(([, addrs]) => addrs?.some(a => !a.internal));

    // Hitung kemunculan tiap MAC non-kosong dalam siklus ini:
    const macCounts = new Map();
    for (const [, addrs] of ifaces) {
        const mac = addrs.find(a => a.mac && a.mac !== "00:00:00:00:00:00")?.mac;
        if (mac) macCounts.set(mac, (macCounts.get(mac) ?? 0) + 1);
    }

    return ifaces.map(([name, addrs]) => {
        const mac = addrs.find(a => a.mac && a.mac !== "00:00:00:00:00:00")?.mac;
        const macUnique = Boolean(mac) && macCounts.get(mac) === 1;

        const stableKey = macUnique
            ? `${slug(name)}-${slug(mac)}`
            : fallbackStableKey({ name, mac: mac ?? null, kind: "ambiguous-nic" });

        return {
            deviceId: canonicalDeviceId({
                namespace: "net.os", stableKey
            }),
            deviceClass: DEVICE_CLASSES.NETWORK_INTERFACE,
            displayName: name,
            identity: {
                namespace: "net.os",
                stableKey,
                // Klaim jujur: "stable" hanya bila kombinasi nama+MAC
                // benar-benar unik; selain itu sesi.
                stability: macUnique
                    ? IDENTITY_STABILITY.stable
                    : IDENTITY_STABILITY.session
            },
            capabilities: ["network.observe"],
            relationships: [{ type: "attached_to", fromId: null, toId: hostId }],
            metadata: { name, hasMac: Boolean(mac), macShared: !macUnique }
        };
    }).map(d => ({
        ...d,
        relationships: d.relationships.map(r => ({ ...r, fromId: d.deviceId }))
    }));
}

module.exports = { createHostSelfDiscoveryAdapter };
