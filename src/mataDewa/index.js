/**
 * Mata Dewa — subsistem kecerdasan spasial tertanam di Damar.
 *
 * Permukaan publik yang sempit. Damar memiliki lifecycle; Mata Dewa tidak
 * memiliki Manager/Authority/Voice/Context/Memory/Session kedua.
 *
 * Singleton daemon dipakai oleh server.js (boot) dan controller Console.
 */

const { MataDewaService, SUBSYSTEM_STATE, UI_MODE, OPERATING_MODE, MATA_DEWA_MODE, PROVIDER_ACCESS_MODE } = require("./service");
const { ProviderRegistry, PROVIDER_STATE } = require("./registry/providerRegistry");
const config = require("./config");
const geo = require("./spatial/geo");
const { GridIndex } = require("./spatial/gridIndex");
const accessClass = require("./spatial/accessClass");
const epistemic = require("./spatial/epistemic");
const observationModel = require("./observations/observation");
const eventModel = require("./events/event");
const fusion = require("./events/fusion");
const coverage = require("./coverage/coverage");
const { SpatialTimeline } = require("./timeline/timeline");

let singleton = null;

/**
 * Dapatkan (atau buat) instance Mata Dewa milik daemon.
 * @param {object} options diteruskan ke MataDewaService saat pembuatan pertama.
 */
function getService(options = {}) {
    if (!singleton) {
        singleton = new MataDewaService(options);
    }
    return singleton;
}

/** Untuk tes: ganti/reset singleton secara eksplisit. */
function setService(service) {
    singleton = service;
    return singleton;
}

function resetService() {
    singleton = null;
}

module.exports = {
    // Pabrik & singleton
    MataDewaService,
    getService,
    setService,
    resetService,
    // Registry
    ProviderRegistry,
    PROVIDER_STATE,
    // Kosakata
    SUBSYSTEM_STATE,
    UI_MODE,
    OPERATING_MODE,
    MATA_DEWA_MODE,
    PROVIDER_ACCESS_MODE,
    config,
    // Primitif spasial
    geo,
    GridIndex,
    accessClass,
    epistemic,
    // Model
    observationModel,
    eventModel,
    // Spatial core
    fusion,
    coverage,
    SpatialTimeline
};
