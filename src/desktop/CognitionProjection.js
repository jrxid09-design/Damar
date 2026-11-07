/**
 * COGNITION PROJECTION — jembatan baca-saja menuju kognisi.
 *
 * Presence/ACC/Reasoner/Vision kelak menerima proyeksi ini, bukan
 * core-nya. Kontrak:
 *
 * 1. HANYA metode query. Tidak ada set/apply/ingest apa pun — output
 *    model tidak bisa memproduksi atau mengubah observasi OS.
 * 2. Interpretasi model bersifat lokal: `interpret(text)` hanya
 *    melampirkan penafsiran pada jawaban; keadaan kanonik dijamin
 *    byte-per-byte sama sebelum/sesudah.
 * 3. Konteks memberi NOL otoritas actuation. Ada teks terpilih tidak
 *    berarti boleh menimpanya — keputusan materi adalah ranah
 *    subsistem otoritas masa depan (tidak diduplikasi di sini).
 */

const Resolver = require("./ContextReferenceResolver");
const { REASON_CODE } = require("./types");

/** Kata kerja yang dilarang muncul sebagai metode proyeksi. */
const FORBIDDEN_VERBS = /set|apply|ingest|mutate|inject|define|observe|execute|actuat|command|control|write|type|click/i;

function createProjection(source) {

    const isSnapshot = source?.isContextSnapshot === true;
    const view = isSnapshot ? source : source.getView();

    const projection = {

        /** "aplikasi apa yang aktif?" → hasil resolusi deterministik. */
        getActiveApplication: () => Resolver.resolve(view, { kind: Resolver.RESOLUTION_KIND.ACTIVE_APPLICATION }),
        getActiveWindow: () => Resolver.resolve(view, { kind: Resolver.RESOLUTION_KIND.ACTIVE_WINDOW }),
        getActiveDocument: () => Resolver.resolve(view, { kind: Resolver.RESOLUTION_KIND.ACTIVE_DOCUMENT }),
        getCurrentSelection: () => Resolver.resolve(view, { kind: Resolver.RESOLUTION_KIND.CURRENT_SELECTION }),
        getSelectedFiles: () => Resolver.resolve(view, { kind: Resolver.RESOLUTION_KIND.SELECTED_FILES }),
        getActiveVisualContext: () => Resolver.resolve(view, { kind: Resolver.RESOLUTION_KIND.ACTIVE_VISUAL }),
        getCurrentWorkspace: () => Resolver.resolve(view, { kind: Resolver.RESOLUTION_KIND.CURRENT_WORKSPACE }),
        getRecentContext: (constraints) => Resolver.resolve(view, {
            kind: Resolver.RESOLUTION_KIND.RECENT_CONTEXT,
            constraints
        }),
        resolve: (request) => Resolver.resolve(view, request),

        /**
         * Interpretasi model — READ ONLY. Teks model TIDAK pernah
         * menyentuh keadaan kanonik; hanya dilampirkan sebagai anotasi.
         */
        interpret: (modelText) => Object.freeze({
            interpretation: String(modelText ?? ""),
            contextUnchanged: true,
            grantsAuthority: false,
            reasonCode: REASON_CODE.RESOLVED
        }),

        describe: () => ({
            activeApplication: projection.getActiveApplication().targets[0]?.label ?? null,
            activeWindow: projection.getActiveWindow().targets[0]?.label ?? null,
            activeDocument: projection.getActiveDocument().targets[0]?.label ?? null,
            currentSelection: projection.getCurrentSelection().status,
            selectedFilesCount: projection.getSelectedFiles().targets.length,
            activeVisual: projection.getActiveVisualContext().status,
            workspace: projection.getCurrentWorkspace().targets[0]?.label ?? null,
            recentTransitions: (view.recentTransitions ?? view.history ?? []).length,
            authorityNote: AUTHORITY_NOTE
        })

    };

    return Object.freeze(projection);

}

const AUTHORITY_NOTE =
    "Observation != authority. Proyeksi ini read-only; tindakan material " +
    "OS membutuhkan keputusan eksplisit dari subsistem otoritas.";

module.exports = { createProjection, FORBIDDEN_VERBS, AUTHORITY_NOTE };
