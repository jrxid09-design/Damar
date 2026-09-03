/**
 * Provider Mata Dewa — keyless baseline + jahitan opsional berkunci.
 *
 * `registerKeylessProviders` memasang baseline NOL-kunci yang diverifikasi
 * live saat adopsi. Provider berkunci (PLUS/PRO) dipasang terpisah
 * (credentials.js, commit 8) dan melaporkan "credentials absent" secara
 * jujur bila kuncinya belum ada — tidak pernah ditembus.
 */

const { createUsgsProvider } = require("./usgs");
const { createCelestrakProvider } = require("./celestrak");
const { createOpenMeteoProvider } = require("./openMeteo");
const { createAdsbLolProvider } = require("./adsbLol");
const { createOsmProvider } = require("./osm");
const { createOsrmProvider } = require("./osrm");

/**
 * Daftarkan provider baseline tanpa kunci. Aman dipanggil berulang —
 * melewati provider yang sudah terdaftar (idempoten).
 */
function registerKeylessProviders(service) {
    const factories = [
        createUsgsProvider,
        createCelestrakProvider,
        createOpenMeteoProvider,
        createAdsbLolProvider,
        createOsmProvider,
        createOsrmProvider
    ];
    const registered = [];
    for (const factory of factories) {
        const descriptor = factory();
        if (service.registry.getProvider(descriptor.id)) continue;
        try {
            registered.push(service.registerProvider(descriptor));
        }
        catch {
            // Provider tanpa handler poll tetap sah (mis. routing) — abaikan
            // kegagalan registrasi individual agar tak mengganggu baseline.
        }
    }
    return registered;
}

module.exports = {
    registerKeylessProviders,
    createUsgsProvider,
    createCelestrakProvider,
    createOpenMeteoProvider,
    createAdsbLolProvider,
    createOsmProvider,
    createOsrmProvider
};
