/**
 * Memory Core — taksonomi tipe memori Aether.
 *
 * 11 tipe arsitektur dipetakan ke tipe penyimpanan yang SUDAH ADA di
 * MemoryStore (semantic/episodic/preference/procedural) + metadata scope,
 * jadi Core ini ADITIF & tidak mengubah skema/DB yang berjalan.
 *
 * Field:
 *   storeType  — baris tipe di MemoryStore yang dipakai.
 *   ltm        — kandidat memori jangka panjang (false = fana/workspace).
 *   tier       — kini selalu "auto": Aether diberi keleluasaan penuh
 *                mengatur memorinya sendiri — tulis langsung commit,
 *                tanpa persetujuan/verifikasi pengguna (kebijakan
 *                pemilik, lihat Governor).
 *   sensitive  — data pribadi sensitif (identitas/relasi).
 */

const STORE_TYPES = ["semantic", "episodic", "preference", "procedural"];

const MEMORY_TYPES = {
    identity:     { storeType: "semantic",   ltm: true,  tier: "auto", sensitive: true,  description: "Siapa pengguna, hubungan, peran." },
    preferences:  { storeType: "preference", ltm: true,  tier: "auto", sensitive: false, description: "Kebiasaan & pilihan pengguna." },
    semantic:     { storeType: "semantic",   ltm: true,  tier: "auto", sensitive: false, description: "Fakta dunia/pengguna yang tahan lama." },
    procedural:   { storeType: "procedural", ltm: true,  tier: "auto", sensitive: false, description: "Cara/alur kerja/runbook." },
    project:      { storeType: "semantic",   ltm: true,  tier: "auto", sensitive: false, description: "Tujuan, keputusan, status proyek." },
    goals:        { storeType: "semantic",   ltm: true,  tier: "auto", sensitive: false, description: "Sasaran aktif pengguna." },
    runtime:      { storeType: "episodic",   ltm: true,  tier: "auto", sensitive: false, description: "Fakta runtime (start cmd, port, health)." },
    skills:       { storeType: "episodic",   ltm: true,  tier: "auto", sensitive: false, description: "Pemakaian & hasil skill." },
    conversation: { storeType: "episodic",   ltm: true,  tier: "auto", sensitive: false, description: "Ringkasan percakapan." },
    episodic:     { storeType: "episodic",   ltm: true,  tier: "auto", sensitive: false, description: "Peristiwa berstempel waktu." },
    workspace:    { storeType: "episodic",   ltm: false, tier: "auto", sensitive: false, description: "cwd, terminal, file aktif (fana)." }
};

const DEFAULT_TYPE = "semantic";

// Alias tipe penyimpanan lama → kunci taksonomi (mis. tool AI kirim "preference").
const ALIASES = { preference: "preferences" };

function resolve(type) {
    let key = String(type || "").toLowerCase();
    if (ALIASES[key]) key = ALIASES[key];
    return MEMORY_TYPES[key] ? key : DEFAULT_TYPE;
}

function spec(type) {
    return MEMORY_TYPES[resolve(type)];
}

function storeTypeOf(type) { return spec(type).storeType; }
function tierOf(type) { return spec(type).tier; }
function isSensitive(type) { return spec(type).sensitive; }
function isLtm(type) { return spec(type).ltm; }

function list() {
    return Object.entries(MEMORY_TYPES).map(([key, v]) => ({ key, ...v }));
}

module.exports = {
    MEMORY_TYPES, STORE_TYPES, DEFAULT_TYPE,
    resolve, spec, storeTypeOf, tierOf, isSensitive, isLtm, list
};
