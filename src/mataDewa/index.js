/**
 * Mata Dewa — subsistem kecerdasan spasial tertanam di Damar.
 *
 * Permukaan publik yang sempit. Damar memiliki lifecycle; Mata Dewa tidak
 * memiliki Manager/Authority/Voice/Context/Memory/Session kedua.
 *
 * MD-008: komposisi tersegel — singleton dimiliki composition.js (modul
 * privat). Permukaan publik HANYA getService; TIDAK ADA setService/
 * resetService publik (anti injection / anti double-composition). Entry
 * test-only hidup di composition.js dan TIDAK di-re-export di sini.
 */

const { MataDewaService, SUBSYSTEM_STATE, UI_MODE, OPERATING_MODE, MATA_DEWA_MODE, PROVIDER_ACCESS_MODE } = require("./service");
const { getOrCreateMataDewaService, getMataDewaService } = require("./composition");
const { ProviderRegistry, PROVIDER_STATE } = require("./registry/providerRegistry");
const config = require("./config");
const geo = require("./spatial/geo");
const { GridIndex } = require("./spatial/gridIndex");
const accessClass = require("./spatial/accessClass");
const epistemic = require("./spatial/epistemic");
const lineage = require("./spatial/lineage");
const observationModel = require("./observations/observation");
const eventModel = require("./events/event");
const fusion = require("./events/fusion");
const coverage = require("./coverage/coverage");
const rf = require("./rf/rfManager");
const { SpatialTimeline } = require("./timeline/timeline");

/**
 * Dapatkan (atau buat) instance Mata Dewa milik daemon.
 * @param {object} options diteruskan ke MataDewaService saat pembuatan
 *   pertama SAJA — konflik komposisi setelahnya gagal keras.
 */
function getService(options = {}) {
    return getOrCreateMataDewaService(options);
}

module.exports = Object.freeze({
    // Pabrik & singleton (tersegel)
    MataDewaService,
    getService,
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
    lineage,
    // Model
    observationModel,
    eventModel,
    // Spatial core
    fusion,
    coverage,
    rf,
    SpatialTimeline
});
