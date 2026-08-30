const Authorization = require("../tools/Authorization");

/**
 * IDENTITAS KANONIK PERMINTAAN (CLOSURE H1).
 *
 * SATU-SATUNYA cara sebuah request mendapatkan identitas eksekusi/
 * disklosur. Identitas datang dari `request.exec` yang dirakit runtime
 * tepercaya; bila absen tetapi pembawa otoritas lama (role/capabilitySet/
 * channel/sessionId) ada di level request, SATU identitas kanonik
 * dibangun DI SINI — capabilitySet ikut dinormalisasi & dibekukan,
 * tidak pernah jatuh.
 *
 * Tidak ada lagi identitas "role-only" paralel: setiap jalur
 * (chat, stream, loop tool, deferred disclosure) memakai hasil fungsi
 * ini sehingga restriction tidak bisa hilang karena lupa meneruskan
 * satu per satu field.
 *
 * @param {object} request
 * @returns {object|undefined} identitas ternormalisasi, atau undefined
 *          bila request sama sekali tidak membawa pembawa identitas.
 */
function canonicalRequestExec(request) {

    if (!request || typeof request !== "object") {
        return undefined;
    }

    let exec;

    if (request.exec && typeof request.exec === "object") {
        if (Authorization.isCanonicalInternalGrant(request.exec)) {
            // Preserve identity provenance.  Copying a grant would create a
            // foreign object and must never turn into an execution context.
            return request.exec;
        }
        // M-1 rev4 — CABANG INI DULU BYPASS KANONISASI SEPENUHNYA:
        // capabilitySet mutable dari pemanggil lolos sampai ke tepi
        // provider. Kini jalur exec pun dinormalisasi.
        //
        // Salin dangkal — spread MENYALIN symbol-keyed properties,
        // sehingga provenance/grant kanonik otonom
        // (Authorization.INTERNAL_GRANT_TOKEN) selamat; jangan pernah
        // membangun ulang objek ini field-per-field lewat identity()
        // yang akan mencabut token tersebut (kontrak N2: grant kanonik
        // = batas otonom positif-teridentifikasi ⇒ efektif 'system'
        // di konsumen seperti ToolBus/agentHub.delegatedRoleOf).
        exec = { ...request.exec };
    }
    else {
        const carries =
            request.role != null ||
            request.capabilitySet !== undefined ||
            request.channel != null ||
            request.sessionId != null;

        if (!carries) {
            return undefined;
        }

        exec = Authorization.identity({
            role: request.role ?? null,
            channel: request.channel ?? null,
            sessionId: request.sessionId ?? null,
            capabilitySet: request.capabilitySet
        });
    }

    // RESTRICTION SELALU lewat semantik kanonik Authorization — dari
    // jalur mana pun ia datang:
    //   array sah      → dinormalisasi & DIBEKUKAN (PRESERVE)
    //   string/Set     → dinormalisasi & dibekukan (NARROW)
    //   []             → hadir, terkunci penuh (bukan "tanpa batas")
    //   malformed      → THROW fail-closed (tidak ditafsirkan absen)
    const capabilitySet = Authorization.toCapabilitySet(exec.capabilitySet);
    if (capabilitySet) {
        exec.capabilitySet = capabilitySet;
    }
    else {
        delete exec.capabilitySet;   // absen legitimat — buang bentuk mentah warisan
    }

    // Window konteks: bawa dari bentuk legacy bila identitas tidak
    // sudah membawanya (metadata eksekusi non-otoritas dipertahankan).
    const contextTokens =
        exec.contextTokens ??
        request.execContextTokens ??
        (Number.isFinite(request.contextTokens) ? request.contextTokens : null);

    if (contextTokens != null) {
        exec.contextTokens = contextTokens;
    }

    return exec;

}

module.exports = { canonicalRequestExec };
