"use strict";

/**
 * W7-L1 SELF-MODEL — perakitan SelfModelSnapshot (spec §4 + §9 "Snapshot
 * over budget"). Truncation berurutan deterministik dari domain paling
 * murah untuk dikorbankan ke paling mahal, dan SELALU menandai
 * `snapshotTruncated: true` — tidak pernah diam-diam memotong.
 */

const { SCHEMA_VERSION } = require("./bounds");

function byteSize(value) {
    // Bug review independen (audit putaran-51, W7R51-ADV-1): `JSON.stringify`
    // melempar mentah untuk BigInt (dan struktur siklik) -- sebuah soft
    // port (mis. providerPort.activeProviders()) yang menyisipkan BigInt
    // di dalam hasilnya meledakkan seluruh snapshot(), dipanggil setiap
    // siklus L7 shadow/governed. `Infinity` dikembalikan untuk apa pun
    // yang tidak bisa diserialisasi -- memaksa loop pemotongan di bawah
    // berjalan (gagal aman ke snapshot terpotong bertanda
    // `snapshotTruncated:true`, bukan crash).
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
        return Infinity;
    }
}

// Bug review independen (audit putaran-34, AUD34-ADV-5): `runtimeLocation`/
// `resourcePressure`/`activeProviders` hanya dibekukan SATU level (atau,
// untuk resourcePressure, tidak dibekukan sama sekali) -- objek bersarang
// yang dikembalikan port (capabilityRegistry/health) tetap mutable lewat
// snapshot yang dikembalikan. Port tepercaya (bukan pemanggil luar), jadi
// advisory (bukan P2); deepFreeze menutup lapis-dalam tanpa menyaring tipe.
// Bug review independen (audit putaran-51, W7R51-ADV-1): `Reflect.ownKeys`/
// `value[key]`/`Object.freeze` di sini semuanya [[Get]]/[[OwnKeys]] mentah
// terhadap hasil PORT (mesh/provider/governor/presence) -- soft port yang
// mengembalikan Proxy yang di-revoke meledakkan snapshot() secara mentah.
// Fungsi ini TIDAK PERNAH punya kontrak melempar (dipanggil di sini
// khusus untuk EFEK SAMPING pembekuan, bukan disalin/dikembalikan) --
// kegagalan APA PUN pada satu properti/subtree diperlakukan sebagai
// "tidak bisa dibekukan dengan aman", dilewati (bukan crash), sisanya
// tetap dibekukan sebisa mungkin.
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    try {
        if (seen.has(value)) return value;
        seen.add(value);
        for (const key of Reflect.ownKeys(value)) {
            let nested;
            try {
                nested = value[key];
            } catch {
                continue;
            }
            deepFreeze(nested, seen);
        }
        return Object.freeze(value);
    } catch {
        return value;
    }
}

function buildSnapshot({
    identity, runtimeLocation, capabilityAssessments, unknowns,
    activeLimitations, healthState, degradedSubsystems, resourcePressure,
    activeProviders, knownNodes, reachableNodes, activeGoalRefs,
    activeMissionRefs, generatedAtMs, maxSnapshotBytes
}) {

    let truncated = false;

    const domainsInSacrificeOrder = [
        "activeMissionRefs", "activeGoalRefs", "knownNodes", "reachableNodes",
        "degradedSubsystems", "activeLimitations", "unknowns", "capabilityAssessments"
    ];

    const live = {
        activeMissionRefs, activeGoalRefs, knownNodes, reachableNodes,
        degradedSubsystems, activeLimitations, unknowns, capabilityAssessments
    };

    function assemble() {
        return Object.freeze({
            schemaVersion: SCHEMA_VERSION,
            generatedAtMs,
            identity: Object.freeze({ ...identity }),
            runtimeLocation: deepFreeze({ ...runtimeLocation }),
            capabilityAssessments: Object.freeze([...live.capabilityAssessments]),
            unknowns: Object.freeze([...live.unknowns]),
            activeLimitations: Object.freeze([...live.activeLimitations]),
            healthState,
            degradedSubsystems: Object.freeze([...live.degradedSubsystems]),
            resourcePressure: deepFreeze(resourcePressure),
            activeProviders: deepFreeze([...activeProviders]),
            knownNodes: Object.freeze([...live.knownNodes]),
            reachableNodes: Object.freeze([...live.reachableNodes]),
            activeGoalRefs: Object.freeze([...live.activeGoalRefs]),
            activeMissionRefs: Object.freeze([...live.activeMissionRefs]),
            snapshotTruncated: truncated
        });
    }

    let snapshot = assemble();
    let cursor = 0;
    while (byteSize(snapshot) > maxSnapshotBytes && cursor < domainsInSacrificeOrder.length) {
        const key = domainsInSacrificeOrder[cursor];
        const arr = live[key];
        if (Array.isArray(arr) && arr.length > 0) {
            live[key] = arr.slice(0, Math.max(0, Math.floor(arr.length / 2)));
            truncated = true;
        } else {
            cursor += 1;
        }
        snapshot = assemble();
    }

    return snapshot;
}

module.exports = { byteSize, buildSnapshot };
