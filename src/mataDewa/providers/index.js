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

/**
 * Daftarkan provider baseline tanpa kunci. Aman dipanggil berulang —
 * melewati provider yang sudah terdaftar (idempoten).
 */
function registerKeylessProviders(service) {
    const factories = [
        createUsgsProvider,
        createCelestrakProvider,
        createOpenMeteoProvider,
        createAdsbLolProvider
    ];
    const registered = [];
    for (const factory of factories) {
        const descriptor = factory();
        if (service.registry.getProvider(descriptor.id)) continue;
        registered.push(service.registerProvider(descriptor));
    }
    return registered;
}

module.exports = {
    registerKeylessProviders,
    createUsgsProvider,
    createCelestrakProvider,
    createOpenMeteoProvider,
    createAdsbLolProvider
};
