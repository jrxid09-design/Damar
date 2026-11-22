/**
 * Titik masuk subsistem Companion (device tertaut).
 *
 * Device di jaringan yang sama / Bluetooth PAN bisa memakai tools & skill
 * Damar lewat jalur yang sudah ada (REST + MCP + chat). Lihat:
 *   - deviceRegistry.js   daftar device + kredensial per device
 *   - pairing.js          kode 6 digit + TTL (approval pemilik)
 *   - companionGateway.js jembatan chat kognitif → aiRuntime (channel "device")
 */
const { DeviceRegistry } = require("./deviceRegistry");
const { Pairing } = require("./pairing");
const { CompanionGateway } = require("./companionGateway");

const deviceRegistry = new DeviceRegistry();
const pairing = new Pairing();
const gateway = new CompanionGateway({ registry: deviceRegistry });

/**
 * Middleware auth device: baca token device (Bearer) → set req.device.
 * Berbeda dari tokenGuard (DAMAR_TOKEN): ini token per-device.
 */
function deviceAuth(req, res, next) {

    const header = req.headers?.authorization ?? "";

    const token = header.startsWith("Bearer ")
        ? header.slice(7).trim()
        : (req.query?.token ?? null);

    const device = deviceRegistry.authenticate(token);

    if (!device) {
        return require("../utils/response").error(
            res,
            "Device tidak dikenal atau telah dicabut. Sertakan token device.",
            401
        );
    }

    req.device = device;

    deviceRegistry.touch(device.id);

    next();

}

module.exports = {
    deviceRegistry,
    pairing,
    gateway,
    deviceAuth,
    DeviceRegistry,
    Pairing,
    CompanionGateway
};
