/**
 * HostDiscoveryAdapter — satu-satunya adapter NYATA di V0 (B§5c).
 *
 * Sengaja kecil dan tanpa dependensi: node:os saja. Ia melaporkan
 * tubuh minimal host — HOST/CPU/MEMORY/NETWORK_INTERFACE — dengan
 * kejujuran identitas:
 *   - hostname  → "stable"   (berubah hanya saat operator mengganti)
 *   - cpu/mem   → "session"  (model/ukuran bisa berarti mesin lain)
 *   - interface → "stable" bila MAC nyata, "session" bila tak ada MAC
 *
 * Adapter Windows/audio/kamera/display penuh BUKAN bagian milestone ini;
 * mereka tinggal mengikuti kontrak yang sama (B§5a).
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

            const hostId = canonicalDeviceId({
                namespace: "host.os", stableKey: slug(sys.hostname())
            });
            const cpuId = canonicalDeviceId({
                namespace: "host.os",
                stableKey: `cpu-${sha256Hex(
                    `${cpus[0]?.model ?? "unknown"}|${cpus.length}`).slice(0, 12)}`
            });

            const descriptors = [
                {
                    deviceId: hostId,
                    deviceClass: DEVICE_CLASSES.HOST,
                    displayName: sys.hostname(),
                    identity: {
                        namespace: "host.os",
                        stableKey: slug(sys.hostname()),
                        stability: IDENTITY_STABILITY.stable
                    },
                    capabilities: ["device.health.read"],
                    metadata: { platform: sys.platform(), arch: sys.arch() }
                },
                {
                    deviceId: cpuId,
                    deviceClass: DEVICE_CLASSES.CPU,
                    displayName: cpus[0]?.model?.slice(0, 80) ?? "CPU",
                    identity: {
                        namespace: "host.os",
                        stableKey: fallbackStableKey({
                            model: cpus[0]?.model ?? "?", count: cpus.length
                        }),
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
                ...Object.entries(sys.networkInterfaces()).flatMap(([name, addrs]) => {
                    const mac = addrs?.find(a => a.mac && a.mac !== "00:00:00:00:00:00")?.mac;
                    // Antarmuka internal loopback tidak dilaporkan — bukan
                    // tepi tubuh yang sesungguhnya.
                    if (!addrs?.some(a => !a.internal)) return [];
                    const key = mac ? slug(mac)
                        : fallbackStableKey({ name, kind: "no-mac" });
                    return [{
                        deviceId: `net.os:${key}`,
                        deviceClass: DEVICE_CLASSES.NETWORK_INTERFACE,
                        displayName: name,
                        identity: {
                            namespace: "net.os", stableKey: key,
                            stability: mac
                                ? IDENTITY_STABILITY.stable
                                : IDENTITY_STABILITY.session
                        },
                        capabilities: ["network.observe"],
                        relationships: [{ type: "attached_to", fromId: `net.os:${key}`, toId: hostId }],
                        metadata: { name, hasMac: Boolean(mac) }
                    }];
                })
            ];

            // relasi host → anak ditempelkan dari sisi anak (attached_to),
            // CPU/memori juga dilampirkan ke host:
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

module.exports = { createHostSelfDiscoveryAdapter };
