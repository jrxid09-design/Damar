/**
 * CONTEXT REFS — port tipis untuk Colony/Lab/Initiative (fase depan).
 *
 * Kontrak: pemanggil boleh mengirim
 *
 *   contextRefs: ["project:aether", "decision:xyz", "artifact:abc"]
 *
 * dan pipeline mengubahnya menjadi ContextItems berbatas. Sumber
 * project/artifact BELUM ada di repo — jadi modul ini hanyalah
 * REGISTRY RESOLVER: sistem masa depan mendaftarkan handler
 * `kind` → async (id) => [{content, priority, ...}]. Tanpa handler,
 * ref diabaikan dengan catatan telemetri (bukan error).
 */

const resolvers = new Map();   // kind → async fn(id) => array of raw

function registerResolver(kind, fn) {
    resolvers.set(String(kind), fn);
    return this;
}

function knownKinds() {
    return [...resolvers.keys()];
}

/** Resolve seluruh refs; kegagalan satu ref tidak menjatuhkan lainnya. */
async function resolve(refs = []) {

    const items = [];
    const unresolved = [];

    for (const ref of Array.isArray(refs) ? refs : []) {

        const [kind, ...rest] = String(ref).split(":");

        const id = rest.join(":");

        const fn = resolvers.get(kind);

        if (!fn) {
            unresolved.push(ref);
            continue;
        }

        try {
            const raw = await fn(id);
            for (const r of Array.isArray(raw) ? raw : []) {
                items.push({
                    source: `ref:${kind}`,
                    kindRaw: kind,
                    content: String(r.content ?? ""),
                    priority: Number.isFinite(r.priority) ? r.priority : 55,
                    provenance: `${ref}`,
                    mandatory: Boolean(r.mandatory)
                });
            }
        }
        catch {
            unresolved.push(ref);
        }

    }

    return { items, unresolved };

}

module.exports = { registerResolver, resolve, knownKinds };

