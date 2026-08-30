const telemetry = require("../../services/telemetryService");
const ArgumentValidator = require("./ArgumentValidator");
const { types: utilTypes } = require("node:util");

/**
 * AUTHORIZATION — SATU titik cek otorisasi Tool Intelligence.
 *
 * Mengevolusi roleService (peran) + riskCatalog (klasifikasi risiko)
 * menjadi satu gerbang yang dipakai DI SEMUA permukaan dengan jaminan
 * invariant yang sama:
 *
 *   A  disclosure ≠ execution      — eksekusi selalu dicek ulang
 *   B  komponen security hilang    → DENY (fail-closed)
 *   C  model boleh MEMINTA otoritas, tak pernah MEMBERIKAN
 *   D  metadata kapabilitas eksternal tidak menentukan trust sendiri
 *   E/F discovery & deferred disclosure = universe yang sama
 *   G  identitas eksekusi wajib ada
 *   H  flag bypass tidak pernah melemahkan otorisasi
 *   I  nama/alias/deskripsi bukan identitas keamanan untuk dunia luar
 *   J  retrieval, disclosure, tool_search, deferred disclosure,
 *      execution, substitution — satu policy universe
 *
 * BUKAN engine kedua: kebijakan peran tetap milik roleService,
 * klasifikasi destruktif tetap milik riskCatalog. Modul ini yang
 * menyatukan keduanya + aturan trust boundary eksternal, dan menjadi
 * satu-satunya tempat keputusan izin diambil.
 */

/** Peran berurutan — semakin kecil indeks, semakin besar wewenang. */
const ROLE_RANK = ["system", "superadmin", "admin", "user"];

function rankOf(role) {
    const i = ROLE_RANK.indexOf(String(role ?? "").toLowerCase());
    return i < 0 ? ROLE_RANK.length : i;   // peran asing = paling terbatas
}

/**
 * C-F/CANONICAL — id kapabilitas kanonik.
 *
 * Nama yang dijalankan model ("damarSkills__wa_send",
 * "system__time__currentTime", "mcp__srv__tool") diuraikan ke id
 * registry intinya ("damarSkills.wa_send", dst.). Nama native
 * tetap apa adanya. INILAH bentuk pembanding untuk OTORISASI:
 * pencocokan tail dihapus dari jalur keputusan (temuan tail-
 * collision: 'evil__system_health' tak boleh masuk grant berisi
 * 'system_health' hanya karena ruas akhirnya sama).
 */
function canonicalCapabilityId(name) {
    const { parseName } = require("./CapabilityIndex");
    return parseName(name).id;
}

/**
 * C-F — NORMALISASI + PEMBEKUAN himpunan kapabilitas.
 *
 * Himpunan adalah RESTRIKSI, bukan otoritas:
 *   - hanya array-of-string yang diterima; lainnya → null (tanpa batas)
 *   - diduplikasi, dibekukan (frozen) agar tidak bisa dimutasi di hilir
 *   - array kosong TETAP sah = "tidak boleh apa pun" (bukan tanpa batas)
 * Set berasal dari kebijakan runtime tepercaya (mis. Watchdog);
 * identitas tidak pernah MEMBUAT set — hanya menormalkannya.
 */
function normalizeCapabilitySet(value) {
    if (!Array.isArray(value)) return null;
    const cleaned = [...new Set(
        value.filter(v => typeof v === "string" && v.trim())
             .map(v => v.trim())
    )];
    return Object.freeze(cleaned);
}

/**
 * M-1 CLOSURE — FAIL-CLOSED NORMALISASI RESTRICTION.
 *
 * `normalizeCapabilitySet` menerima HANYA array; bentuk lain → null =
 * "tanpa batas". Itulah cabang fail-open M-1: restriction yang ADA
 * tetapi berbentuk lain (id tunggal, Set hasil konstruksi programatik
 * Capability Lifecycle/ACC, hasil serialisasi yang rusak) LENYAP dan
 * identitas menjadi privileged + unrestricted.
 *
 * `toCapabilitySet` menutupnya dengan tiga semantik yang diizinkan:
 *   - PRESERVE : array sah → frozen array (termasuk [] = terkunci penuh)
 *   - NARROW   : id string tunggal / iterable (Set) → himpunan lebih
 *                kecil dari "tanpa batas" — tidak pernah melebar
 *   - FAIL CLOSED : bentuk benar-benar tak dikenal (object biasa,
 *                angka, boolean, ...) → THROW; restriction tidak boleh
 *                ditafsirkan sebagai ketiadaan restriction.
 * Absen (undefined/null) → null: ketiadaan restriction yang LEGITIMAT
 * (giliran segar ber-role), bukan restriction yang hilang.
 */
function toCapabilitySet(value) {

    if (value === undefined || value === null) return null;

    if (typeof value === "string") {
        const s = value.trim();
        return Object.freeze(s ? [s] : []);
    }

    // Internal-slot classification must precede every property/iterator
    // operation. External identity objects may be hostile Proxies.
    if (utilTypes.isProxy(value)) {
        throw new Error("PELANGGARAN INVARIAN: Proxy capabilitySet ditolak");
    }

    if (Array.isArray(value)) {
        const safe = [];
        for (let i = 0; i < value.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
            if (!descriptor) continue;
            if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
                throw new Error("PELANGGARAN INVARIAN: capabilitySet accessor ditolak");
            }
            if (typeof descriptor.value === "string" && descriptor.value.trim()) {
                safe.push(descriptor.value);
            }
        }
        return normalizeCapabilitySet(safe);
    }

    // Only the built-in Set internal slot is accepted. Never read an
    // attacker-controlled Symbol.iterator or constructor property.
    if (utilTypes.isSet(value)) {
        try {
            const values = [];
            const iterator = Set.prototype.values.call(value);
            for (const item of iterator) values.push(item);
            return normalizeCapabilitySet(values);
        }
        catch {
            /* jatuh ke fail-closed di bawah */
        }
    }

    throw new Error(
        "PELANGGARAN INVARIAN: bentuk capabilitySet tidak dikenal — restriction " +
        "tidak boleh ditafsirkan sebagai tanpa-batas (fail-closed)."
    );
}

/**
 * Apakah nilai ini membawa state restriction? Tidak pernah melempar:
 * bentuk malformed dihitung PRESENT (arah fail-closed) untuk checker
 * pelestarian; gudang normalisasi yang memutuskan lempar atau tidak.
 */
function hasRestriction(value) {
    if (value === undefined || value === null) return false;
    try { return toCapabilitySet(value) !== null; }
    catch { return true; }
}

/**
 * Dua sumber set (delegator ∩ permintaan) SELALU beririsan —
 * tidak pernah union. Salah satu sisi absen → sisi yang ada.
 * Hasil frozen; irisan kosong = array kosong terkunci penuh.
 */
function intersectCapabilitySets(a, b) {
    if (!Array.isArray(a)) return normalizeCapabilitySet(b ?? null);
    if (!Array.isArray(b)) return normalizeCapabilitySet(a);
    return normalizeCapabilitySet(
        a.filter(x => b.includes(x))
    );
}

/**
 * C-F — keanggotaan KANONIK (bukan tail). Grant 'system_health'
 * tidak mengizinkan 'evil__system_health'; ia mengizinkan kapabilitas
 * kanonik 'system_health' (native) atau id registry persisnya.
 * Tail matching tetap boleh untuk RETRIEVAL/pencarian — bukan di sini.
 */
function capSetWithin(name, set) {
    if (!Array.isArray(set)) return true;
    const canon = canonicalCapabilityId(name);
    for (const entry of set) {
        if (entry === name || entry === canon) return true;
        if (canonicalCapabilityId(entry) === canon) return true;
    }
    return false;
}

/**
 * Normalisasi identitas eksekusi. Fail-closed: tanpa identitas →
 * peran terendah ('user'), bukan null yang lolos semua gerbang.
 * Pemanggil internal sistem WAJIB menyatakan role:"system" secara
 * eksplisit (lihat pemanggil visionService/orchestrator/AgentHub).
 *
 * A-FINAL: capabilitySet IKUT dalam identitas — dinormalisasi &
 * dibekukan. RESTRICTION wajib selamat melewati SETIAP hop
 * (normalisasi/serialisasi/delegasi/stream); identitas inilah satu-
 * satunya wadahnya di gerbang eksekusi & disklosur.
 */
function identity(partial = {}) {
    const role = String(partial.role ?? "").toLowerCase();
    // M-1 CLOSURE: restriction yang ada tidak pernah lenyap menjadi
    // tanpa-batas — bentuk tak dikenal melempar (fail-closed), bentuk
    // string/iterable menyempit. Absen = absen yang legitimat.
    const capabilitySet = toCapabilitySet(partial.capabilitySet);
    return {
        principalId: partial.principalId ?? partial.sessionId ?? "anon",
        role: ROLE_RANK.includes(role) ? role : "user",
        channel: partial.channel ?? "unknown",
        sessionId: partial.sessionId ?? "anon",
        source: partial.source ?? "runtime",
        workerId: partial.workerId ?? null,
        missionId: partial.missionId ?? null,
        ...(capabilitySet ? { capabilitySet } : {})
    };
}

function isPrivileged(role) {
    return rankOf(role) <= ROLE_RANK.indexOf("superadmin");
}

/**
 * N2-FINAL — SATU TITIK derivasi otoritas delegasi.
 *
 * TIDAK ada subsistem otonomi/planner/healing/worker yang boleh
 * memilih sendiri otoritasnya. Semua wajib lewat sini:
 *
 *   1. Inisiator nyata (manusia/model/request) → otoritas DIWARISI
 *      (effective ≤ initiator). `internalGrant` pada identitas diLUCUTKAN
 *      — identitas dari ToolExecutor/HTTP memang tidak pernah memilikinya,
 *      dan pelucutan ini membuat pemalsuan lewat ctx.exec mustahil
 *      secara struktural.
 *   2. Identitas hilang → least privilege (null → 'user' di konsumen).
 *   3. 'system' hanya bila: TIDAK ada inisiator, pemanggil adalah batas
 *      runtime otonom yang positif-teridentifikasi (watchdog/pulse/dream/
 *      self-healing timer), DAN batas itu eksplisit menandai
 *      internalOrigin=true. Flag ini parameter fungsi in-process —
 *      tidak pernah bisa berasal dari arg model/tool/HTTP/MCP.
 *   4. superadmin tetap superadmin — TIDAK diam-diam menjadi system;
 *      keduanya setara hanya menurut kebijakan kanonik ROLE_RANK.
 *
 * @returns delegasi ternormalisasi untuk konsumen (agentHub/orchestrator)
 */
function resolveDelegator(initiatorExec = null, internalOrigin = false, provenance = "runtime") {

    // 1. Inisiator nyata menang. Token grant diLUCUTKAN dari identitas:
    //    spread menyalin symbol-keyed properti, jadi hapus eksplisit —
    //    identitas apa pun yang datang dengan token bukan identitas sah.
    const role = String(initiatorExec?.role ?? "").toLowerCase();

    if (role) {
        const inherited = { ...initiatorExec };
        delete inherited.internalGrant;          // bentuk lama (jika ada)
        delete inherited[INTERNAL_GRANT_TOKEN];  // token in-process
        // A-FINAL + M-1 CLOSURE: RESTRICTION menyeberang delegasi —
        // diwarisi utuh (pewarisan hanya pernah MENYEMPITKAN). Bentuk
        // tak dikenal → THROW (fail-closed); dulu cabang Array.isArray
        // diam-diam melucuti restriction non-array dan mewariskan
        // peran privileged TANPA batas (temuan M-1).
        const inheritedSet = toCapabilitySet(initiatorExec?.capabilitySet);
        if (inheritedSet) {
            inherited.capabilitySet = inheritedSet;
        }
        return inherited;
    }

    // Grant kanonik yang sudah diselesaikan batas tepercaya mengalir
    // turun tanpa dibuat ulang (diakui lewat SYMBOL in-process —
    // tidak bisa direkonstruksi dari JSON/arg/model/HTTP).
    if (isCanonicalInternalGrant(initiatorExec)) {
        return initiatorExec;
    }

    // 2+3. Batas otonom eksplisit is descriptive metadata only.  It is
    // deliberately NOT an execution grant: a boolean supplied to this
    // public resolver must never mint a bearer capability.
    if (internalOrigin === true) {
        return Object.freeze({
            // source hanya LABEL TELEMETRI — bukan bukti kepercayaan.
            source: `autonomous:${String(provenance || "runtime").slice(0, 40)}`,
            sessionId: String(provenance || "runtime").slice(0, 60)
        });
    }

    // M-1 CLOSURE — pembawa restriction tanpa peran: inisiator yang
    // hanya membawa capabilitySet (tanpa role, tanpa grant) tidak
    // boleh menghilangkan restriction itu (dulu → null = lenyap).
    // Dikembalikan sebagai delegasi ber-restriction tanpa peran:
    // konsumen memetakan perannya ke least-privilege ('user') dan set
    // TETAP mengeksekusi/disklosur di gerbang — murni menyempit.
    const carriedSet = toCapabilitySet(initiatorExec?.capabilitySet);
    if (carriedSet) {
        return {
            capabilitySet: carriedSet,
            source: `delegation:${String(provenance || "runtime").slice(0, 40)}`,
            sessionId: String(provenance || "runtime").slice(0, 60)
        };
    }

    // 2. Tanpa inisiator & tanpa batas tepercaya → least privilege.
    return null;

}

/**
 * D — BUKTI KEPERCAYAAN TERTUTUP: symbol in-process.
 *
 * Symbol tidak ikut JSON.stringify/parse, tidak bisa dikirim lewat
 * HTTP/MCP/model args, dan hanya bisa diciptakan modul ini. String
 * `source` adalah label telemetri semata — TIDAK pernah bukti trust.
 */
const INTERNAL_GRANT_TOKEN = Symbol("damar.internalGrant");

/** Apakah sebuah delegasi berupa grant otonom kanonik. */
function isCanonicalInternalGrant(exec) {
    if (exec === null || typeof exec !== "object" || utilTypes.isProxy(exec)) {
        return false;
    }
    return false;
}

function isToolAuthorizedByGrant(exec, toolName) {
    return false;
}

/** Klasifikasi internal — metadata eksternal TIDAK ikut menentukan. */
function classify(recordOrTool) {

    // Terima CapabilityRecord (punya .source/.destructive/.tail) ATAU
    // tool mentah. Provenance ditentukan INTERNAL dari bentuk nama.
    const name = String(recordOrTool?.name ?? "");

    // H10: satu sumber klasifikasi (CapabilityIndex.provenanceOf).
    const { provenanceOf } = require("./CapabilityIndex");
    const prov = provenanceOf(recordOrTool);

    const external = prov.external || recordOrTool?.external === true;

    const destructive = recordOrTool?.destructive !== undefined
        ? Boolean(recordOrTool.destructive)
        : Boolean(require("../../core/safety/riskCatalog").riskOf(name, recordOrTool));

    return {
        name,
        external,
        destructive,
        // Eksternal tak pernah readOnly-by-default: semantik tak dikenal.
        readOnly: !external && !destructive && recordOrTool?.sideEffects !== true
    };

}

/**
 * Gerbang DISKLOSUR: tool mana yang boleh DILIHAT model untuk
 * identitas ini. Dipakai Pipeline, tool_search, dan deferred
 * disclosure — satu fungsi, tiga permukaan (invariant E/F/J).
 *
 * Aturan trust boundary:
 *   - kapabilitas eksternal (MCP) hanya terlihat oleh peran
 *     privileged — dunia luar tidak masuk universe pengguna biasa;
 *   - kanal voice menyembunyikan destruktif (gerbang, bukan skor);
 *   - roleService gagal dimuat → fail-closed (kosongkan privileged).
 */
function disclosureFilter(tools = [], exec = {}) {

    const id = identity(exec);

    let roleAllows = null;

    try {
        const roleService = require("../../services/roleService");
        roleAllows = (name) => roleService.allows(id.role, name);
    }
    catch {
        telemetry.warn("[authz] roleService tak tersedia — fail-closed");
        roleAllows = () => false;                     // INVARIANT B
    }

    return tools.filter(raw => {

        const c = classify(raw);

        // Metadata kanal/peran pada record (dipindah dari Ranker agar
        // SATU gerbang mengurus semua kelayakan disklosur).
        if (Array.isArray(raw?.roles) &&
            (!id.role || !raw.roles.includes(id.role))) return false;

        if (Array.isArray(raw?.channels) &&
            (!id.channel || !raw.channels.includes(id.channel))) return false;

        // B-FINAL — PERMISSION-BEFORE-DISCLOSURE: himpunan kapabilitas
        // delegasi membatasi JUGA universe disklosur. Yang tidak boleh
        // dijalankan tidak boleh DILIHAT — disclosure universe ⊆
        // capabilitySet, execution universe ⊆ capabilitySet.
        if (Array.isArray(id.capabilitySet) &&
            !capSetWithin(c.name, id.capabilitySet)) return false;

        // Eksternal: hanya privileged (invariant D).
        if (c.external && !isPrivileged(id.role)) return false;

        // Kebijakan peran internal (regex allow/deny yang sudah ada).
        if (!c.external && !roleAllows(c.name)) return false;

        // Voice: gerbang destruktif, bukan penalti skor.
        if (id.channel === "voice" && c.destructive && !isPrivileged(id.role)) {
            return false;
        }

        return true;

    });

}

/**
 * Gerbang EKSEKUSI — dipanggil ToolExecutor TEPAT sebelum menjalankan
 * (invariant A). Melempar ToolError machine-readable bila menolak.
 */
function assertExecution(toolOrName, exec = {}) {

    const id = identity(exec);
    const c = classify(typeof toolOrName === "string"
        ? { name: toolOrName }
        : toolOrName);

    // INVARIANT B: roleService wajib hidup untuk keputusan berbasis
    // peran; mati → tolak kapabilitas non-publik.
    let roleOk = false;
    let roleServiceAlive = true;

    try {
        roleOk = require("../../services/roleService").allows(id.role, c.name);
    }
    catch {
        roleServiceAlive = false;
    }

    if (!roleServiceAlive && !isPrivileged(id.role)) {
        throw ArgumentValidator.make(
            ArgumentValidator.CODES.PERMISSION_DENIED,
            "Komponen otorisasi tidak tersedia — akses ditolak (fail-closed)."
        );
    }

    // C-F — CAPABILITY SET TERBATAS: delegasi boleh membawa himpunan
    // kapabilitas eksplisit (mis. pemulihan watchdog). Di luar set =
    // DENY, apa pun perannya — system pun terkunci ke dalam set.
    //
    // CRITICAL-2 FIX: set dibaca dari IDENTITAS TERNORMALISASI
    // (identity() membekukannya), bukan dari exec mentah — sehingga
    // ToolExecutor yang menormalkan identitas tidak lagi melucuti
    // restriction di tengah jalan. Pencocokan KANONIK: tail collision
    // ('evil__system_health' vs 'system_health') tidak memberi akses.
    if (Array.isArray(id.capabilitySet) &&
        !capSetWithin(c.name, id.capabilitySet)) {
        throw ArgumentValidator.make(
            ArgumentValidator.CODES.PERMISSION_DENIED,
            `'${c.name}' berada di luar himpunan kapabilitas delegasi ini.`,
            { constraint: "capability-set" }
        );
    }

    // Kapabilitas eksternal: namespace terpisah, privileged saja
    // (invariant D + C6: regex nama internal tak boleh dielabui nama
    // eksternal yang mirip).
    if (c.external && !isPrivileged(id.role)) {
        throw ArgumentValidator.make(
            ArgumentValidator.CODES.PERMISSION_DENIED,
            `Kapabilitas eksternal '${c.name}' membutuhkan peran istimewa.`,
            { constraint: "external-trust-boundary" }
        );
    }

    if (!roleOk) {
        throw ArgumentValidator.make(
            ArgumentValidator.CODES.PERMISSION_DENIED,
            `Peran '${id.role}' tidak diizinkan menjalankan '${c.name}'.`,
            { constraint: "role-policy" }
        );
    }

    // Destruktif + kanal lisan → wajib privileged (gerbang, bukan skor).
    if (c.destructive && id.channel === "voice" && !isPrivileged(id.role)) {
        throw ArgumentValidator.make(
            ArgumentValidator.CODES.POLICY_DENIED,
            `Kapabilitas destruktif '${c.name}' tidak diizinkan lewat kanal suara.`,
            { constraint: "voice-destructive-gate" }
        );
    }

    return c;

}

/**
 * M-1 CLOSURE — SATU mekanisme kanonik asersi pelestarian restriction.
 *
 * Dipakai oleh agentHub.assertRestrictionsPreserved DAN batas fallback
 * runtime (aiRuntimeService.chatLocalFallback) — TIDAK ada lagi
 * implementasi lokal ber-bentuk Array.isArray yang bisa fail-open:
 *
 *   parent restriction ABSENT            → sah (tidak ada yang dijaga)
 *   parent PRESENT + child ABSENT        → THROW (fail-closed)
 *   parent [] (terkunci penuh)           → PRESENT; child wajib membawa []
 *   parent string/Set                    → dinormalisasi, tak pernah dilucuti
 *   malformed (parent maupun child)      → THROW (fail-closed)
 *   child ⊄ parent                       → THROW (restriction tak boleh MELEBAR)
 */
function assertRestrictionPreserved(parentExec, childPayload) {

    if (!hasRestriction(parentExec?.capabilitySet)) {
        return childPayload;    // tanpa restriction di parent — tak ada yang wajib dijaga
    }

    const parentSet = toCapabilitySet(parentExec.capabilitySet);
    const childSet = toCapabilitySet(childPayload?.capabilitySet);

    if (!childSet) {
        throw new Error(
            "PELANGGARAN INVARIAN: capabilitySet delegasi hilang " +
            "saat diteruskan ke runtime eksekusi."
        );
    }

    for (const cap of childSet) {
        if (!parentSet.includes(cap)) {
            throw new Error(
                `PELANGGARAN INVARIAN: restriction delegasi MELEBAR — ` +
                `'${cap}' tidak ada dalam set delegator.`
            );
        }
    }

    return childPayload;
}

/**
 * Bukti status bridged (invariant H/G7): flag boolean dari objek
 * tool TIDAK cukup. Bridged sah hanya bila registry inti benar-benar
 * memegang id tersebut DAN catatan itu menandai dirinya dijaga
 * internally. MCP tidak pernah memenuhinya.
 */
function proveBridgedGuarded(tool) {

    if (!tool?.bridged || tool.guardedInternally !== true) return false;

    try {
        const { ToolRegistry } = require("../../core/tools");
        return ToolRegistry.has(tool.bridged);
    }
    catch {
        return false;
    }

}

module.exports = {
    ROLE_RANK, identity, rankOf, isPrivileged,
    resolveDelegator, isCanonicalInternalGrant,
    isToolAuthorizedByGrant,
    canonicalCapabilityId, normalizeCapabilitySet, intersectCapabilitySets,
    toCapabilitySet, hasRestriction, assertRestrictionPreserved,
    capSetWithin,
    classify, disclosureFilter, assertExecution, proveBridgedGuarded
};
