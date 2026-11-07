const os = require("node:os");

/**
 * Alamat akses companion — di mana device bisa mencapai Damar.
 *
 * Klasifikasi interface jaringan:
 *   - tailscale : IP di rentang CGNAT 100.64.0.0/10 (100.64–100.127)
 *                 atau nama interface mengandung "tailscale"
 *   - lan       : IP privat biasa (10.x / 172.16–31.x / 192.168.x)
 *   - lainnya   (loopback, link-local) diabaikan
 *
 * Murni & testable: interfaces bisa di-inject (default os.networkInterfaces).
 */

const TAILSCALE_IFACE_RE = /tailscale/i;

function isPrivateLan(ip) {
    return (
        /^10\./.test(ip) ||
        /^192\.168\./.test(ip) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    );
}

/** CGNAT 100.64/10 — rentang yang dipakai Tailscale. */
function isTailscaleRange(ip) {

    const m = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);

    if (!m) return false;

    const second = Number(m[1]);

    return second >= 64 && second <= 127;

}

/**
 * Deteksi alamat akses.
 *
 * @param {object} opsi { port, hostname, interfaces }
 * @returns {object} { host, port, lan: [{address, iface}], tailscale: [{address, iface}] }
 */
function detectAddresses({ port = 3000, hostname = null, interfaces = null } = {}) {

    const ifaces = interfaces ?? os.networkInterfaces();
    const host = hostname ?? os.hostname();

    const lan = [];
    const tailscale = [];

    for (const [iface, addrs] of Object.entries(ifaces)) {

        for (const addr of addrs ?? []) {

            // Hanya IPv4 non-internal.
            if (addr.internal || addr.family !== "IPv4") continue;

            const ip = addr.address;
            const entry = { address: ip, iface };

            if (isTailscaleRange(ip) || TAILSCALE_IFACE_RE.test(iface)) {
                tailscale.push(entry);
            }
            else if (isPrivateLan(ip)) {
                lan.push(entry);
            }
            // loopback/link-local/publik: diabaikan (jangan iklankan IP publik).

        }

    }

    return { host, port, lan, tailscale };

}

/**
 * Susun daftar URL halaman companion, urut prioritas:
 * Tailscale dulu (stabil lintas jaringan), lalu LAN.
 *
 * @returns {Array<{kind, label, url}>}
 */
function companionUrls(access) {

    if (!access) return [];

    const out = [];

    for (const t of access.tailscale ?? []) {
        out.push({
            kind: "tailscale",
            label: `Tailscale (${t.address})`,
            url: `http://${t.address}:${access.port}/companion`
        });
    }

    for (const l of access.lan ?? []) {
        out.push({
            kind: "lan",
            label: `LAN (${l.address})`,
            url: `http://${l.address}:${access.port}/companion`
        });
    }

    return out;

}

module.exports = { detectAddresses, companionUrls, isTailscaleRange, isPrivateLan };
