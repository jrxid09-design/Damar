const { manager: integrations } = require("../integrations");
const telemetry = require("./telemetryService");

const agentTools = require("../agent/agentTools");
const pandawaIdentity = require("./pandawaIdentity");
const { createPandawaSessionRegistry } = require("../runtime/interactionBus/pandawaSessions");
const pandawaDelegation = require("./pandawaDelegation");
const pandawaOrchestrator = require("./pandawaOrchestrator");
const pandawaColony = require("./pandawaColony");

/**
 * AgentHub — menyatukan beberapa "pekerja" dalam satu antarmuka.
 *
 * Damar bukan satu model saja; ia bisa mendelegasikan ke:
 *   - damar : otak LLM lokal (reasoning + tool + memori)
 *   - Pandawa: lima spesialis berbasis peran di runtime yang sama
 *              (Puntadewa, Werkudara, Janaka, Nakula, Sadewa)
 */

class AgentHub {

    /** Definisi semua agent yang bisa dipakai orkestrator. */
    agents() {

        return [
            {
                id: "damar",
                label: "Damar (LLM lokal)",
                kind: "reasoner",
                description:
                    "Menalar, menjawab, menulis, memakai memori & tool internal " +
                    "(kalkulasi, memori, filesystem, http, dst). Pilihan default " +
                    "untuk berpikir dan menyusun jawaban.",
                skills: [
                    "Menalar & menjawab",
                    "Memori jangka panjang",
                    "Vision — lihat kamera/CCTV",
                    "Kendali rumah",
                    "Kenali wajah (Immich)",
                    "Kirim media WhatsApp",
                    "Buat skill sendiri"
                ]
            },

            // ---- PANDAWA — lima spesialis Damar -------------------
            //
            // Pandawa BUKAN lima asisten terpisah dan BUKAN akar
            // otoritas. Mereka unit kognitif/operasional milik SATU
            // identitas kanonik (Damar), berjalan di runtime yang
            // sama dengan bias peran — selalu online selama daemon
            // hidup. Sintesis akhir ke pengguna tetap Damar.
            //
            // F-05: semantik peran eksekutable DIPROYEKSIKAN dari
            // pemilik kanonik tunggal (pandawaIdentity.ROLE_PROFILES).
            // AgentHub tidak lagi meng-hardcode peran — tidak ada
            // salinan kedua yang bisa basi. ROLE != AUTHORITY.
            //
            // HUKUM YANG TIDAK BOLEH DIGESER OLEH PERAN:
            //   PLAN         != AUTHORITY  (Puntadewa merencanakan)
            //   EVIDENCE     != TRUTH      (Sadewa memverifikasi)
            //   SECURITY     != BYPASS     (Werkudara tetap lewat Gate)
            //   ENGINEERING  != FREE EXEC  (Janaka tetap lewat Actuation)
            //   ANALYTICS    != FREE EXEC  (Nakula tetap lewat Actuation)
            //
            // Otoritas TIDAK PERNAH lahir dari peran: ia hanya
            // diwarisi dari delegator — lihat delegatedRoleOf() dan
            // assertRestrictionsPreserved() di bawah.

            ...["puntadewa", "werkudara", "janaka", "nakula", "sadewa"].map(workerId => {
                const entityId = `pandawa:${workerId}`;
                const profile = pandawaIdentity.roleProfile(entityId);
                return {
                    id: workerId,
                    entityId,
                    kind: "worker",
                    label: profile.label,
                    role: profile.mandate,
                    description: profile.description,
                    skills: [...profile.skills],
                    // Deklarasi lama diterjemahkan lewat alias kapabilitas
                    // di agentTools (CAPABILITY_ALIAS) — profil boost
                    // kanonik tetap WORKER_PROFILES di agentTools.
                    tools: [...profile.domains],
                    canDelegateTo: workerId === "puntadewa"
                        ? ["janaka", "werkudara", "nakula", "sadewa"]
                        : ["puntadewa", "janaka", "werkudara", "nakula", "sadewa"].filter(x => x !== workerId)
                };
            })

        ];

    }

    describe() {
        return this.agents();
    }

    /**
     * Nama agent EJAAN LAMA → id kanonik Pandawa (§rename).
     *
     * Rencana tersimpan, sesi lama, dan jejak audit masih menyebut
     * nama pra-rename. Alias ini HANYA menerjemahkan nama; ia tidak
     * mendaftarkan agent kedua (tidak muncul di `agents()`) dan
     * tidak menambah kemampuan apa pun.
     *
     * DEPRECATED — lihat docs/architecture/DAMAR-IDENTITY-MIGRATION.md.
     */
    static get PANDAWA_ALIAS() {
        return Object.freeze({ yudistira: "puntadewa", bima: "werkudara", arjuna: "janaka" });
    }

    static get LEGACY_AGENT_ALIAS() {
        return Object.freeze({
            aether: "damar",
            atlas: "puntadewa",
            cipher: "werkudara",
            vanta: "janaka",
            forge: "nakula",
            nexus: "nakula",
            sera: "nakula",
            echo: "nakula",
            lumen: "nakula",
            mira: "sadewa",
            pulse: "sadewa"
        });
    }

    /** Terjemahkan nama lama; nama kanonik dikembalikan apa adanya. */
    resolveAgentId(id) {
        const raw = String(id ?? "");
        return AgentHub.PANDAWA_ALIAS[raw.toLowerCase()] ?? AgentHub.LEGACY_AGENT_ALIAS[raw.toLowerCase()] ?? raw;
    }

    resolveTarget(value) {
        const target = pandawaIdentity.resolveTarget(value);
        return target.id === "damar" || target.id === "pandawa:colony"
            ? target : Object.freeze({ ...target, agentId: this.resolveAgentId(target.agentId) });
    }

    identityOf(id) {
        const target = pandawaIdentity.resolve(id);
        return target ? Object.freeze({ ...target }) : null;
    }

    pandawaSessions(options) {
        if (!this._pandawaSessions) this._pandawaSessions = createPandawaSessionRegistry(options);
        return this._pandawaSessions;
    }

    createPandawaSession(options) { return this.pandawaSessions().create(options); }
    resumePandawaSession(sessionId, options) { return this.pandawaSessions().resume(sessionId, options); }
    createPandawaDelegation(options) { return pandawaDelegation.createDelegation(options); }
    acceptPandawaDelegation(delegation, options) { return pandawaDelegation.acceptDelegation(delegation, options); }
    createPandawaWorkGraph(options) { return pandawaOrchestrator.createWorkGraph(options); }
    runPandawaWorkGraph(graph, options) { return pandawaOrchestrator.runGraph(graph, options); }
    createPandawaColony(options) { return pandawaColony.createColony(options); }

    get(id) {
        const wanted = this.resolveAgentId(id);
        return this.agents().find(a => a.id === wanted) ?? null;
    }

    /**
     * Apakah agent-konektor sedang online — SINKRON,
     * dari status terakhir yang diketahui, tanpa memanggil jaringan.
     *
     * Dipakai untuk menyaring tool: bila konektor offline, tool-tool
     * yang menuntutnya tidak perlu ditawarkan ke model — kalau tidak,
     * model memilihnya lalu gagal dengan "konektor sedang offline"
     * sementara jalur langsung tersedia.
     *
     * Default TRUE bila status belum diketahui: jangan menyembunyikan
     * kemampuan hanya karena probe pertama belum jalan.
     */
    connectorOnline(id) {
        try {
            const connector = integrations.get(id);
            if (!connector) return false;               // tak dikonfigurasi
            return connector.lastStatus?.online !== false;
        }
        catch {
            return true;
        }
    }

    /** Status kesiapan tiap agent (untuk UI & pemilihan rute). */
    async health() {

        const out = [];

        for (const agent of this.agents()) {

            // Agent inti & Pandawa hidup di runtime Damar yang
            // sama — selalu online selama daemon berjalan.
            if (agent.id === "damar" || agent.kind === "worker") {

                let toolCount = 0;
                try {
                    toolCount = require("../core/tools").ToolRegistry.describe().length;
                }
                catch { /* registry belum siap */ }

                out.push({
                    ...agent,
                    skills: agent.id === "damar" && toolCount
                        ? [...agent.skills, `+${toolCount} tool internal`]
                        : agent.skills,
                    online: true,
                    detail: agent.id === "damar" ? "runtime lokal" : "Pandawa — spesialis Damar"
                });
                continue;
            }

            const connector = integrations.get(agent.id);

            if (!connector) {
                out.push({ ...agent, online: false, detail: "tidak dikonfigurasi" });
                continue;
            }

            const snapshot = connector.lastStatus ?? {};

            out.push({
                ...agent,
                online: snapshot.online === true,
                detail: snapshot.online ? (connector.baseUrl ?? "") : (snapshot.error ?? "offline")
            });

        }

        return out;

    }

    /**
     * Jalankan satu tugas pada agent tertentu.
     *
     * `contextRefs` adalah port Context Intelligence untuk masa depan
     * (Pandawa): director mengirim referensi ("project:x") alih-alih
     * menyalin seluruh context; pipeline yang menyelesaikannya menjadi
     * context minimal untuk worker.
     *
     * N2: `exec` = identitas eksekusi DELEGATOR. Delegasi tidak boleh
     * menaikkan otoritas — worker mewarisi otoritas delegator.
     *
     * @returns {Promise<{ ok, agent, output, error? }>}
     */
    async run(rawAgentId, task, { signal = null, contextRefs = [], exec = null } = {}) {

        // Nama lama diterjemahkan SEKALI di pintu masuk; seluruh jalur
        // (telemetri, sessionId, hasil) memakai id kanonik supaya tidak
        // ada dua penamaan aktif untuk satu spesialis.
        const agentId = this.resolveAgentId(rawAgentId);

        telemetry.publish("agent:run", { agent: agentId, task: String(task).slice(0, 80) });

        try {

            if (agentId === "damar") {
                return { ok: true, agent: agentId, output: await this.runDamar(task, { contextRefs, exec }) };
            }

            // Pandawa: runtime Damar yang sama + bias peran.
            const worker = this.get(agentId);

            if (worker?.kind === "worker") {
                return { ok: true, agent: agentId, output: await this.runWorker(worker, task, { contextRefs, exec }) };
            }

            throw new Error(`Agent tidak dikenal: ${agentId}`);

        }

        catch (error) {

            telemetry.warn(`[agent] ${agentId} gagal: ${error.message}`);

            return { ok: false, agent: agentId, output: null, error: error.message };

        }

    }

    /**
     * N2-FINAL — penafsir delegasi yang SUDAH diselesaikan oleh titik
     * kanonik (Authorization.resolveDelegator). Hanya grant kanonik
     * berprovenance 'autonomous:' yang menghasilkan 'system'; identitas
     * biasa mewarisi perannya; tanpa keduanya → 'user' least-privilege.
     */
    delegatedRoleOf(exec) {
        const { isCanonicalInternalGrant } = require("../ai/tools/Authorization");
        if (isCanonicalInternalGrant(exec)) return "system";
        const role = String(exec?.role ?? "").toLowerCase();
        return role || "user";
    }

    /**
     * A-FINAL — RUNTIME ASSERTION: restriction tidak boleh hilang
     * di transit. Bila delegator membawa capabilitySet, permintaan
     * ke runtime WAJIB membawanya juga. Pelanggaran = bug wiring,
     * gagal-keras (fail-closed) sebelum otoritas bocor.
     *
     * M-1 CLOSURE: dulu precondition checker adalah Array.isArray
     * sendiri — restriction berbentuk non-array (string id, Set
     * programatik, hasil serialisasi rusak) MELOLEWATI asersi dan
     * lenyap menjadi privileged + unrestricted. Kini state restriction
     * dideteksi via Authorization.hasRestriction (malformed = PRESENT),
     * normalisasi lewat toCapabilitySet (fail-closed), dan pelestarian
     * diverifikasi arah: child hanya boleh SAMA atau LEBIH SEMPIT.
     */
    assertRestrictionsPreserved(exec, request) {
        // M-1 CLOSURE: SATU mekanisme kanonik di Authorization —
        // dipakai bersama batas fallback runtime; tidak ada lagi
        // implementasi pelestarian lokal yang bisa menyimpang.
        return require("../ai/tools/Authorization")
            .assertRestrictionPreserved(exec, request);
    }

    async runDamar(task, { contextRefs = [], exec = null } = {}) {

        const aiRuntime = require("./aiRuntimeService");

        // CRITICAL-1 FIX: capabilitySet delegasi IKUT ke runtime.
        // Dulu hanya role/sessionId yang lewat — restriction watchdog
        // lenyap di hop pertama dan worker melihat universe penuh.
        const request = {
            messages: [{ role: "user", content: String(task) }],
            contextRefs,
            // N2-FINAL: direktor mewarisi delegator; identitas hilang
            // dari jalur tak-tepercaya = 'user', BUKAN system implisit.
            role: this.delegatedRoleOf(exec),
            sessionId: exec?.sessionId ?? "anon"
        };

        // M-1 CLOSURE: restriction ikut dalam bentuk yang SAH apa pun
        // (array/string id/Set programatik); malformed = gagal-keras
        // di sini, bukan lenyap lalu tertangkap asersi.
        const runDamarSet = require("../ai/tools/Authorization")
            .toCapabilitySet(exec?.capabilitySet);
        if (runDamarSet) {
            request.capabilitySet = runDamarSet;
        }

        this.assertRestrictionsPreserved(exec, request);

        const response = await aiRuntime.chat(request);

        return response.content ?? "";

    }

    /** Janaka adalah kasus khusus (F-05: rekayasa/koding kanonik):
     * tugas menulis/mengubah kode didelegasikan ke opencode lewat tool
     * `opencode_run` — agent coding sungguhan dengan editor penuh,
     * bukan patch manual.
     */
    async runWorker(agent, task, { contextRefs = [], exec = null } = {}) {

        const aiRuntime = require("./aiRuntimeService");

        // N2 Round-2 — DELEGI TIDAK MENAIKKAN OTORITAS, dan identitas
        // hilang ≠ grant tepercaya. Lihat delegatedRoleOf().
        const workerRole = this.delegatedRoleOf(exec);

        // C-F — himpunan kapabilitas terbatas ikut ke SELEKSI: worker
        // ber-delegasi terbatas tidak melihat kandidat di luar set.
        // Pencocokan KANONIK (bukan tail) — satu mesin dengan gerbang
        // eksekusi, jadi seleksi & otorisasi tidak pernah berbeda.
        let universe = aiRuntime.tools();
        const filterSet = require("../ai/tools/Authorization")
            .toCapabilitySet(exec?.capabilitySet);
        if (filterSet && filterSet.length) {
            const { capSetWithin } = require("../ai/tools/Authorization");
            universe = universe.filter(t => capSetWithin(t.name, filterSet));
        }

        let tools = [];

        try {
            const Pipeline = require("../ai/tools/Pipeline");
            const agentTools = require("../agent/agentTools");
const pandawaIdentity = require("./pandawaIdentity");
const { createPandawaSessionRegistry } = require("../runtime/interactionBus/pandawaSessions");
const pandawaDelegation = require("./pandawaDelegation");
const pandawaOrchestrator = require("./pandawaOrchestrator");
const pandawaColony = require("./pandawaColony");

            tools = Pipeline.select({
                tools: universe,
                message: String(task),
                // Seleksi memakai peran worker hasil penurunan —
                // user yang mendelegasikan tidak melihat/mendapat
                // tool privileged lewat jalur worker.
                role: workerRole,
                workerId: agent.id,
                boost: agentTools.profileFor(agent.id)
            }).tools;
        }
        catch { /* registry belum siap — jalan tanpa tool */ }

        // Bias peran ditempel SEBELUM pesan pengguna, bukan sebagai
        // pesan system — supaya system prompt utama (memori, tool)
        // tetap terpasang oleh aiRuntimeService.
        const instruksi = agent.id === "janaka"
            ? `[Peran: ${agent.label}]\n${agent.role}\n\n` +
              "Untuk mengubah/menulis kode, WAJIB delegasikan ke opencode lewat tool " +
              "`opencode_run` — jangan tulis patch manual lewat filesystem.\n\n" +
              `Tugas: ${String(task)}`
            : `[Peran: ${agent.label}]\n${agent.role}\n\nTugas: ${String(task)}`;

        const request = {
            messages: [{ role: "user", content: instruksi }],
            tools,
            contextRefs,
            // H7 Round-2 + N2: seleksi & eksekusi SATU identitas
            // koheren yang DITURUNKAN dari delegator. workerId tetap
            // penanda delegasi/telemetri — BUKAN sumber otoritas.
            role: workerRole,
            sessionId: exec?.sessionId
                ? `${exec.sessionId}>worker:${agent.id}`
                : `worker:${agent.id}`
        };

        // CRITICAL-1 FIX: restriction ikut ke runtime (sama dengan
        // runDamar) — worker terbatas tidak boleh kehilangan set-nya.
        // CRITICAL-1 FIX + M-1 CLOSURE: restriction ikut ke runtime
        // dalam bentuk sah apa pun; malformed fail-closed di sini.
        const workerSet = require("../ai/tools/Authorization")
            .toCapabilitySet(exec?.capabilitySet);
        if (workerSet) {
            request.capabilitySet = workerSet;
        }

        this.assertRestrictionsPreserved(exec, request);

        const response = await aiRuntime.chat(request);

        return response.content ?? "";

    }

}

module.exports = new AgentHub();
