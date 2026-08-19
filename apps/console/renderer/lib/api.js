/**
 * Klien untuk bidang kendali daemon Aether.
 *
 * Semua permintaan lewat satu titik agar base URL, token, dan
 * penanganan error tidak tersebar di seluruh view.
 */
class AetherApi {

    constructor() {

        this.baseUrl = "http://localhost:3000";

        this.token = "";

        /** Pembatalan untuk stream chat yang sedang berjalan. */
        this.chatAbort = null;

        this.eventSource = null;

    }

    configure({ baseUrl, token }) {

        if (baseUrl) {
            this.baseUrl = String(baseUrl).replace(/\/+$/, "");
        }

        this.token = token ?? "";

        return this;

    }

    get root() {

        return `${this.baseUrl}/api/v1/console`;

    }

    headers(extra = {}) {

        // Daemon melayani Console, CLI, WhatsApp, dan Telegram lewat
        // pintu yang sama, jadi hanya klien yang tahu ia siapa. Tanpa
        // header ini Aether tak punya cara mengetahui percakapan
        // sedang berlangsung di mana.
        const headers = { "x-aether-channel": "console", ...extra };

        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        return headers;

    }

    async request(path, { method = "GET", body = null, timeout = 20000 } = {}) {

        const controller = new AbortController();

        const timer = setTimeout(() => controller.abort(), timeout);

        try {

            const response = await fetch(`${this.root}${path}`, {
                method,
                headers: this.headers(
                    body ? { "Content-Type": "application/json" } : {}
                ),
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok || payload?.success === false) {

                throw new Error(
                    payload?.message ??
                    `HTTP ${response.status} ${response.statusText}`
                );

            }

            return payload?.data ?? payload;

        }

        catch (error) {

            if (error.name === "AbortError") {
                throw new Error("Permintaan melebihi batas waktu.");
            }

            // fetch melempar TypeError yang sama untuk daemon mati,
            // port salah, maupun host tak terjangkau — jadikan pesan
            // yang bisa ditindaklanjuti.
            if (error instanceof TypeError) {
                throw new Error(`Tidak bisa menghubungi daemon di ${this.baseUrl}`);
            }

            throw error;

        }

        finally {
            clearTimeout(timer);
        }

    }

    // ---- Keselamatan (§37, §123) --------------------------------
    // Timeout sengaja pendek: kalau daemon sedang bermasalah,
    // pemilik tetap harus bisa menekan STOP tanpa menunggu lama.

    safety()            { return this.request("/safety", { timeout: 8000 }); }
    safetyStop(reason)  { return this.request("/safety/stop", { method: "POST", body: { reason: reason || "dihentikan dari Console", actor: "console" }, timeout: 8000 }); }
    safetyRelease()     { return this.request("/safety/release", { method: "POST", body: { actor: "console" }, timeout: 8000 }); }
    safetyTrail(limit = 60) { return this.request(`/safety/trail?limit=${limit}`, { timeout: 8000 }); }

    // ---- Ringkasan & telemetri ----------------------------------

    overview()          { return this.request("/overview", { timeout: 25000 }); }
    context()           { return this.request("/context", { timeout: 25000 }); }
    contextBrief()      { return this.request("/context/brief", { method: "POST", timeout: 90000 }); }
    stats()             { return this.request("/stats"); }
    logs(limit = 200)   { return this.request(`/logs?limit=${limit}`); }

    // ---- AI -----------------------------------------------------

    providers()         { return this.request("/ai/providers", { timeout: 25000 }); }
    selectProvider(id)  { return this.request("/ai/provider", { method: "POST", body: { id } }); }
    models(provider)    { return this.request(`/ai/models${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, { timeout: 25000 }); }
    selectModel(model)  { return this.request("/ai/model", { method: "POST", body: { model } }); }
    metrics()           { return this.request("/ai/metrics"); }
    aiUsage(days = 14)  { return this.request(`/ai/usage?days=${days}`); }

    // ---- Plugin & tool -------------------------------------------

    plugins()           { return this.request("/plugins"); }
    tools()             { return this.request("/tools"); }

    runTool(id, args)   {
        return this.request(
            `/tools/${encodeURIComponent(id)}/execute`,
            { method: "POST", body: { args }, timeout: 60000 }
        );
    }

    // ---- Integrasi ------------------------------------------------

    integrations()      { return this.request("/integrations"); }
    checkIntegrations() { return this.request("/integrations/check", { method: "POST", timeout: 30000 }); }
    checkIntegration(id){ return this.request(`/integrations/${encodeURIComponent(id)}/check`, { method: "POST", timeout: 20000 }); }

    updateIntegration(id, patch) {
        return this.request(
            `/integrations/${encodeURIComponent(id)}`,
            { method: "PATCH", body: patch, timeout: 20000 }
        );
    }

    // ---- Memori ------------------------------------------------------

    memoryStats()       { return this.request("/memory/stats", { timeout: 25000 }); }

    memories(params = {}) {

        const query = new URLSearchParams(
            Object.entries(params).filter(([, value]) => value != null && value !== "")
        );

        return this.request(`/memory?${query}`);

    }

    memory(id)          { return this.request(`/memory/${id}`); }

    recall(body)        { return this.request("/memory/recall", { method: "POST", body, timeout: 30000 }); }

    remember(body)      { return this.request("/memory", { method: "POST", body }); }

    updateMemory(id, body) { return this.request(`/memory/${id}`, { method: "PATCH", body }); }

    forget(id)          { return this.request(`/memory/${id}`, { method: "DELETE" }); }

    consolidate(dryRun) {
        return this.request(
            `/memory/consolidate${dryRun ? "?dryRun=true" : ""}`,
            { method: "POST", timeout: 60000 }
        );
    }

    entities(params = {}) {

        const query = new URLSearchParams(
            Object.entries(params).filter(([, value]) => value != null && value !== "")
        );

        return this.request(`/memory/entities?${query}`);

    }

    entity(id)          { return this.request(`/memory/entities/${id}`); }

    createEntity(body)  { return this.request("/memory/entities", { method: "POST", body }); }

    removeEntity(id)    { return this.request(`/memory/entities/${id}`, { method: "DELETE" }); }

    documents(query)    {
        return this.request(`/memory/documents${query ? `?query=${encodeURIComponent(query)}` : ""}`);
    }

    documentChunks(id)  { return this.request(`/memory/documents/${id}/chunks`); }

    // Ingest folder bisa memakan waktu lama, jadi diberi tenggat sendiri.
    ingest(body)        { return this.request("/memory/documents", { method: "POST", body, timeout: 300000 }); }

    removeDocument(id)  { return this.request(`/memory/documents/${id}`, { method: "DELETE" }); }

    memoryProposals()      { return this.request("/memory/proposals"); }
    approveProposal(id)    { return this.request(`/memory/proposals/${id}/approve`, { method: "POST" }); }
    rejectProposal(id)     { return this.request(`/memory/proposals/${id}/reject`, { method: "POST" }); }
    memoryAudit()          { return this.request("/memory/audit"); }

    embeddingStatus()   { return this.request("/memory/embeddings"); }

    backfillEmbeddings() {
        return this.request("/memory/embeddings/backfill", { method: "POST", timeout: 300000 });
    }

    // ---- Vision -----------------------------------------------------

    visionStatus()        { return this.request("/vision/status"); }
    visionConfig()        { return this.request("/vision/config"); }
    saveVisionConfig(b)   { return this.request("/vision/config", { method: "POST", body: b }); }
    visionAnalyze(b)      { return this.request("/vision/analyze", { method: "POST", body: b, timeout: 90000 }); }
    cameras()             { return this.request("/cameras"); }
    addCamera(b)          { return this.request("/cameras", { method: "POST", body: b }); }
    removeCamera(id)      { return this.request(`/cameras/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    seeCamera(id, prompt) { return this.request(`/cameras/${encodeURIComponent(id)}/see`, { method: "POST", body: { prompt }, timeout: 90000 }); }

    // ---- Home automation --------------------------------------------

    homeStatus()          { return this.request("/home/status", { timeout: 12000 }); }
    homeConfig()          { return this.request("/home/config"); }
    saveHomeConfig(b)     { return this.request("/home/config", { method: "POST", body: b }); }
    homeDevices(domain)   { return this.request(`/home/devices${domain ? `?domain=${encodeURIComponent(domain)}` : ""}`, { timeout: 15000 }); }
    homeControl(b)        { return this.request("/home/control", { method: "POST", body: b, timeout: 15000 }); }

    // ---- Multi-agent ------------------------------------------------

    agents()             { return this.request("/agents", { timeout: 25000 }); }

    /**
     * Jalankan orkestrasi; panggil onEvent untuk tiap tahap
     * (planning/plan/step:start/step:done/final). Pakai jalur SSE
     * yang sama dengan chat.
     */
    async orchestrate(request, onEvent) {

        const response = await fetch(`${this.root}/orchestrate`, {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/json" }),
            body: JSON.stringify({ request })
        });

        if (!response.ok) {
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.message ?? `HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {

            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";

            for (const frame of frames) {
                let event = "message";
                const dataLines = [];
                for (const line of frame.split(/\r?\n/)) {
                    if (line.startsWith("event:")) event = line.slice(6).trim();
                    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
                }
                if (dataLines.length) {
                    try { onEvent({ event, data: JSON.parse(dataLines.join("\n")) }); }
                    catch { /* frame parsial */ }
                }
            }

        }

    }

    // ---- Forge (buat tool sendiri) ----------------------------------

    /** Upload berkas (foto/dokumen apa pun) ke sesi percakapan. */
    uploadChatFile({ name, data, mimeType }) {
        return this.request("/memory/upload", {
            method: "POST",
            body: { name, data, mimeType },
            timeout: 60000
        });
    }

    // ---- Laboratorium (project workspace) -----------------------------

    labProjects()             { return this.request("/lab/projects"); }
    labCreateProject(dir, title) {
        return this.request("/lab/projects", { method: "POST", body: { dir, title } });
    }
    labActivateProject(id)    { return this.request(`/lab/projects/${encodeURIComponent(id)}/activate`, { method: "POST" }); }
    labRemoveProject(id)      { return this.request(`/lab/projects/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    labBrowse(id, rel = "")   { return this.request(`/lab/projects/${encodeURIComponent(id)}/browse?path=${encodeURIComponent(rel)}`); }
    labOpenVSCode(id)         { return this.request(`/lab/projects/${encodeURIComponent(id)}/vscode`, { method: "POST" }); }

    // ---- Aether Lab v2 (laboratorium kolaboratif) ----------------------

    labProjectsV2()           { return this.request("/lab/projects"); }
    labProject(id)            { return this.request(`/lab/projects/${encodeURIComponent(id)}`); }
    labSetPhase(id, phase)    { return this.request(`/lab/projects/${encodeURIComponent(id)}/phase`, { method: "POST", body: { phase } }); }
    labTimeline(id)           { return this.request(`/lab/projects/${encodeURIComponent(id)}/timeline`); }
    labMemorySummary(id)      { return this.request(`/lab/projects/${encodeURIComponent(id)}/memory/summary`); }
    labMemoryRemember(id, type, content) {
        return this.request(`/lab/projects/${encodeURIComponent(id)}/memory`, { method: "POST", body: { type, content } });
    }
    labKnowledgeIngest(id, text, title) {
        return this.request(`/lab/projects/${encodeURIComponent(id)}/knowledge`, { method: "POST", body: { text, title } });
    }
    labMissions(q = {}) {
        const p = new URLSearchParams();
        if (q.project) p.set("project", q.project);
        if (q.status) p.set("status", q.status);
        return this.request(`/lab/missions?${p}`);
    }
    labMissionCreate(body)    { return this.request("/lab/missions", { method: "POST", body }); }
    // Detail misi — satu-satunya yang memuat tasks + hasil akhir.
    // Daftar misi sengaja ringan, jadi tanpa panggilan ini panel
    // Mission Control selalu tampak "belum ada task".
    labMissionDetail(id)      { return this.request(`/lab/missions/${encodeURIComponent(id)}`); }
    /** Terapkan hasil misi: memory | beranda | followup | code. */
    labMissionApply(id, target, instruction) {
        return this.request(`/lab/missions/${encodeURIComponent(id)}/apply`, {
            method: "POST", body: { target, instruction }, timeout: 600000
        });
    }
    labMissionRun(id)         { return this.request(`/lab/missions/${encodeURIComponent(id)}/run`, { method: "POST", body: {}, timeout: 600000 }); }
    labMissionStatus(id, status, reason) {
        return this.request(`/lab/missions/${encodeURIComponent(id)}/status`, { method: "POST", body: { status, reason } });
    }
    labMissionResume(id, instruction) {
        return this.request(`/lab/missions/${encodeURIComponent(id)}/resume`, { method: "POST", body: { instruction }, timeout: 600000 });
    }
    labActivity(q = {}) {
        const p = new URLSearchParams();
        if (q.project) p.set("project", q.project);
        if (q.mission) p.set("mission", q.mission);
        if (q.limit) p.set("limit", String(q.limit));
        return this.request(`/lab/activity?${p}`);
    }
    labAgentsBoard()          { return this.request("/lab/agents"); }
    labInstruments()          { return this.request("/lab/instruments"); }
    graphCoding(limit = 160)  { return this.request(`/graph/coding?limit=${limit}`, { timeout: 30000 }); }
    labArtifacts(q = {}) {
        const p = new URLSearchParams();
        if (q.project) p.set("project", q.project);
        return this.request(`/lab/artifacts?${p}`);
    }
    labDecisions(q = {}) {
        const p = new URLSearchParams();
        if (q.project) p.set("project", q.project);
        return this.request(`/lab/decisions?${p}`);
    }
    labExperiments(q = {}) {
        const p = new URLSearchParams();
        if (q.project) p.set("project", q.project);
        return this.request(`/lab/experiments?${p}`);
    }
    labSnapshot(id, label) {
        return this.request(`/lab/projects/${encodeURIComponent(id)}/snapshots`, { method: "POST", body: { label } });
    }

    forgeList()          { return this.request("/forge"); }
    forgeRead(id)        { return this.request(`/forge/${encodeURIComponent(id)}`); }
    forgeCreate(body)    { return this.request("/forge", { method: "POST", body, timeout: 30000 }); }
    forgeApprove(id)     { return this.request(`/forge/${encodeURIComponent(id)}/approve`, { method: "POST", timeout: 30000 }); }
    forgeReject(id)      { return this.request(`/forge/${encodeURIComponent(id)}/reject`, { method: "POST" }); }
    forgeRemove(id)      { return this.request(`/forge/${encodeURIComponent(id)}`, { method: "DELETE" }); }

    whatsappStatus()     { return this.request("/whatsapp/status"); }

    telegramStatus()     { return this.request("/telegram/status"); }
    telegramConfig(b)    { return this.request("/telegram/config", { method: "POST", body: b }); }
    telegramTest(chatId) { return this.request("/telegram/test", { method: "POST", body: { chatId } }); }
    telegramReconnect()  { return this.request("/telegram/reconnect", { method: "POST" }); }

    // ---- Suara -------------------------------------------------------

    voiceStatus()       { return this.request("/voice/status"); }
    /** Daftar suara dari container TTS neural (bukan suara OS). */
    voiceVoices()       { return this.request("/voice/voices", { timeout: 8000 }); }

    /** CCTV dari Home Assistant (gambarnya diteruskan daemon). */
    homeCameras()       { return this.request("/home/cameras", { timeout: 15000 }); }
    voiceConfig()       { return this.request("/voice/config"); }
    saveVoiceConfig(b)  { return this.request("/voice/config", { method: "POST", body: b }); }

    cryptoConfig()      { return this.request("/crypto/config"); }
    saveCryptoConfig(b) { return this.request("/crypto/config", { method: "POST", body: b }); }
    cryptoStatus()      { return this.request("/crypto/status", { timeout: 20000 }); }

    transcribe(body)    { return this.request("/voice/transcribe", { method: "POST", body, timeout: 60000 }); }

    // ---- Perangkat -------------------------------------------------

    devices()             { return this.request("/devices"); }
    saveDevices(patch)    { return this.request("/devices", { method: "PUT", body: patch }); }
    addSensor(sensor)     { return this.request("/devices/sensors", { method: "POST", body: sensor }); }
    removeSensor(id)      { return this.request(`/devices/sensors/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    sensorReadings()      { return this.request("/devices/sensors/readings", { timeout: 20000 }); }

    // ---- OSINT --------------------------------------------------------

    osintInvestigate(target) { return this.request("/osint/investigate", { method: "POST", body: target, timeout: 60000 }); }
    osintEmail(email)        { return this.request("/osint/email", { method: "POST", body: { email }, timeout: 30000 }); }
    osintUsername(username, limit) { return this.request("/osint/username", { method: "POST", body: { username, limit }, timeout: 30000 }); }
    osintPhone(phone)        { return this.request("/osint/phone", { method: "POST", body: { phone }, timeout: 15000 }); }
    osintDomain(domain)      { return this.request("/osint/domain", { method: "POST", body: { domain }, timeout: 30000 }); }
    osintPlatforms()         { return this.request("/osint/platforms"); }

    osintBreach(query)       { return this.request("/osint/breach", { method: "POST", body: { query }, timeout: 45000 }); }
    osintBreachSummary(query){ return this.request("/osint/breach/summary", { method: "POST", body: { query }, timeout: 45000 }); }

    osintPhoneAnalyze(phone) { return this.request("/osint/phone/analyze", { method: "POST", body: { phone }, timeout: 15000 }); }
    osintPhoneAssess(phone, data) { return this.request("/osint/phone/assess", { method: "POST", body: { phone, ...data }, timeout: 15000 }); }
    osintPhoneBlacklistAdd(phone) { return this.request("/osint/phone/blacklist/add", { method: "POST", body: { phone } }); }
    osintPhoneBlacklistRemove(phone) { return this.request("/osint/phone/blacklist/remove", { method: "POST", body: { phone } }); }
    osintPhoneWhitelistAdd(phone) { return this.request("/osint/phone/whitelist/add", { method: "POST", body: { phone } }); }
    osintPhoneList()         { return this.request("/osint/phone/list"); }

    osintTrackRegister(data) { return this.request("/osint/track/register", { method: "POST", body: data }); }
    osintTrackList(group)    { const q = group ? "?group=" + encodeURIComponent(group) : ""; return this.request("/osint/track/list" + q); }
    osintTrackDetail(id)     { return this.request(`/osint/track/${encodeURIComponent(id)}`); }
    osintTrackRevoke(id)     { return this.request(`/osint/track/${encodeURIComponent(id)}/revoke`, { method: "POST" }); }
    osintTrackNearby(radius) { return this.request(`/osint/track/nearby?radius=${radius}`); }

    osintCaseCreate(data)    { return this.request("/osint/cases", { method: "POST", body: data }); }
    osintCaseList(params)    { const q = params ? "?" + new URLSearchParams(params) : ""; return this.request("/osint/cases" + q); }
    osintCaseDetail(id)      { return this.request(`/osint/cases/${encodeURIComponent(id)}`); }
    osintCaseAddFinding(id, data) { return this.request(`/osint/cases/${encodeURIComponent(id)}/findings`, { method: "POST", body: data }); }
    osintCaseAddEvidence(id, data) { return this.request(`/osint/cases/${encodeURIComponent(id)}/evidence`, { method: "POST", body: data }); }
    osintCaseClose(id, data) { return this.request(`/osint/cases/${encodeURIComponent(id)}/close`, { method: "POST", body: data }); }
    osintCaseDelete(id)      { return this.request(`/osint/cases/${encodeURIComponent(id)}`, { method: "DELETE" }); }

    osintSocialBot(profile)  { return this.request("/osint/social/bot", { method: "POST", body: profile, timeout: 30000 }); }
    osintSocialComments(username, platforms) { return this.request("/osint/social/comments", { method: "POST", body: { username, platforms }, timeout: 60000 }); }
    osintSocialLocation(data) { return this.request("/osint/social/location", { method: "POST", body: data, timeout: 30000 }); }
    osintSocialNetwork(data) { return this.request("/osint/social/network", { method: "POST", body: data, timeout: 30000 }); }
    // Tautan berita atau teks klaim — daemon yang memilah mana yang
    // mana, jadi satu kotak isian saja sudah cukup untuk pengguna.
    osintHoaxCheck(claim)    { return this.request("/osint/hoax/check", { method: "POST", body: { claim }, timeout: 30000 }); }
    osintHoaxTrace(claim)    { return this.request("/osint/hoax/trace", { method: "POST", body: { claim }, timeout: 60000 }); }

    // ---- NAS --------------------------------------------------------

    nasStatus()           { return this.request("/nas/status", { timeout: 15000 }); }
    nasConfig()           { return this.request("/nas/config"); }
    nasSetConfig(pool, quotaPercent) {
        const body = {};
        if (pool !== undefined) body.pool = pool;
        if (quotaPercent !== undefined) body.quotaPercent = quotaPercent;
        return this.request("/nas/config", { method: "POST", body });
    }
    immichStatus()        { return this.request("/nas/immich", { timeout: 15000 }); }
    immichUp()            { return this.request("/nas/immich/up", { method: "POST", timeout: 20000 }); }
    immichDown()          { return this.request("/nas/immich/down", { method: "POST", timeout: 70000 }); }
    nasPools()            { return this.request("/nas/pools", { timeout: 15000 }); }
    backups()             { return this.request("/nas/backup"); }
    backupAdd(job)        { return this.request("/nas/backup", { method: "POST", body: job }); }
    backupRun(id)         { return this.request(`/nas/backup/${encodeURIComponent(id)}/run`, { method: "POST", timeout: 300000 }); }
    backupRemove(id)      { return this.request(`/nas/backup/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    nasTestNotify()       { return this.request("/nas/notify/test", { method: "POST", timeout: 20000 }); }
    nasMonitorCheck()     { return this.request("/nas/monitor/check", { method: "POST", timeout: 20000 }); }

    // ---- Files ------------------------------------------------------

    files(p)              { return this.request(`/files${p ? `?path=${encodeURIComponent(p)}` : ""}`, { timeout: 15000 }); }

    // ---- Cuaca & profil --------------------------------------------

    weather()             { return this.request("/weather", { timeout: 12000 }); }
    profile()             { return this.request("/profile"); }
    saveProfile(name)     { return this.request("/profile", { method: "POST", body: { name } }); }

    // ---- Chat streaming --------------------------------------------

    /**
     * Streaming memakai fetch, bukan EventSource, karena butuh POST
     * dengan body. Potongan SSE diurai manual dari ReadableStream.
     *
     * @param {object} payload
     * @param {(chunk: object) => void} onChunk
     * @returns {Promise<{ aborted: boolean }>}
     */
    async streamChat(payload, onChunk) {

        this.chatAbort = new AbortController();

        let response;

        try {

            response = await fetch(`${this.root}/ai/stream`, {
                method: "POST",
                headers: this.headers({ "Content-Type": "application/json" }),
                body: JSON.stringify(payload),
                signal: this.chatAbort.signal
            });

        }
        catch (error) {

            if (error.name === "AbortError") {
                return { aborted: true };
            }

            throw new Error(`Tidak bisa menghubungi daemon di ${this.baseUrl}`);

        }

        if (!response.ok) {

            const detail = await response.json().catch(() => null);

            throw new Error(
                detail?.message ?? `HTTP ${response.status} ${response.statusText}`
            );

        }

        const reader = response.body.getReader();

        const decoder = new TextDecoder();

        let buffer = "";

        try {

            while (true) {

                const { value, done } = await reader.read();

                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                const frames = buffer.split(/\r?\n\r?\n/);

                buffer = frames.pop() ?? "";

                for (const frame of frames) {
                    this.dispatchFrame(frame, onChunk);
                }

            }

        }

        catch (error) {

            if (error.name === "AbortError") {
                return { aborted: true };
            }

            throw error;

        }

        finally {
            this.chatAbort = null;
        }

        return { aborted: false };

    }

    dispatchFrame(frame, onChunk) {

        let event = "message";

        const dataLines = [];

        for (const line of frame.split(/\r?\n/)) {

            if (line.startsWith("event:")) {
                event = line.slice(6).trim();
            }
            else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim());
            }

        }

        if (dataLines.length === 0) {
            return;
        }

        try {
            onChunk({ event, data: JSON.parse(dataLines.join("\n")) });
        }
        catch {
            // Frame tak utuh: abaikan alih-alih memutus stream.
        }

    }

    stopChat() {

        this.chatAbort?.abort();

        this.chatAbort = null;

    }

    // ---- Aliran telemetri -------------------------------------------

    /**
     * EventSource tidak bisa mengirim header, jadi token dilewatkan
     * sebagai query — middleware auth menerima keduanya.
     */
    connectEvents({ onLog, onEvent, onOpen, onError }) {

        this.disconnectEvents();

        const url = new URL(`${this.root}/events`);

        if (this.token) {
            url.searchParams.set("token", this.token);
        }

        const source = new EventSource(url.toString());

        source.addEventListener("hello", e => {
            onOpen?.(JSON.parse(e.data));
        });

        source.addEventListener("log", e => {
            onLog?.(JSON.parse(e.data));
        });

        source.addEventListener("event", e => {
            onEvent?.(JSON.parse(e.data));
        });

        source.onerror = () => onError?.();

        this.eventSource = source;

        return source;

    }

    disconnectEvents() {

        this.eventSource?.close();

        this.eventSource = null;

    }

}

export const api = new AetherApi();
