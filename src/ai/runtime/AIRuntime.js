const BaseComponent = require("../../core/components/BaseComponent");

const {

    AIEventEmitter

} = require("../events");

const runtimeRegistries = new WeakMap();
const mutableRuntimes = new WeakSet();

const {

    MiddlewarePipeline

} = require("../middleware");

const {
    AIToolRegistry
} = require("../tools");

const {
    AIProviderRegistry
} = require("../providers");

const {
    ProviderNotFoundError
} = require("../exceptions");

const {
    RuntimeValidator
} = require("../validators");

const {
    RuntimeLogger
} = require("../loggers");

const {
    RuntimeExecutor,
    RetryExecutor,
    TimeoutExecutor
} = require("../executors");

const {
    AIService
} = require("../services");

const RuntimeOptions = require("./RuntimeOptions");

const { selectTools } = require("../tools/ToolSelector");
const Pipeline = require("../tools/Pipeline");
const SchemaMinimizer = require("../tools/SchemaMinimizer");
const RuntimeMetrics = require("./RuntimeMetrics");
const { canonicalRequestExec } = require("./requestIdentity");

const {
    AIRequestStartedEvent,
    AIRequestCompletedEvent,
    AIRequestFailedEvent
} = require("../events");

class AIRuntime extends BaseComponent {

    constructor(
    context,
    options = new RuntimeOptions()
) {

    super();

    this.context = context;

    this.options = options;

    this.providerRegistry =
        new AIProviderRegistry();

    this.metrics =
        new RuntimeMetrics();

    this.validator =
        new RuntimeValidator();

    this.logger =
        new RuntimeLogger(
            context?.logger
        );

    this.service =
        new AIService();

    this.pipeline =
        new MiddlewarePipeline();

    this.eventEmitter =
        new AIEventEmitter();

    const toolRegistry = options.toolRegistry instanceof AIToolRegistry
        ? options.toolRegistry
        : new AIToolRegistry();
    runtimeRegistries.set(this, toolRegistry);
    if (!(options.toolRegistry instanceof AIToolRegistry)) mutableRuntimes.add(this);

    this.executor =
        new RuntimeExecutor(
            this.service,
            {

                maxToolIterations:
                    this.options.maxToolIterations,

                // Batas untuk SATU panggilan model. Lihat catatan di
                // bawah: inilah tempat batas waktu semestinya berada.
                callTimeout:
                    this.options.timeout,

                events:
                    this.eventEmitter,

                logger:
                    this.logger

            }
        );

    this.executor.setToolRegistry(toolRegistry);

    if (options.toolRegistry instanceof AIToolRegistry) {
        this.setToolRegistry = undefined;
    }

    this.retryExecutor =
        new RetryExecutor(this.options.retry);

    /**
     * Pagar terakhir untuk SELURUH permintaan.
     *
     * Dulu batas 120 detik membungkus seluruh loop tool, bukan tiap
     * panggilan model. Di inferensi CPU satu panggilan saja bisa 40–60
     * detik, sehingga permintaan yang memakai dua tool hampir pasti
     * gagal — batasnya justru menghukum perilaku yang kita inginkan.
     * Terbukti: pertanyaan "kenapa terminal_run diblokir" (satu ronde
     * tool + satu ronde jawaban) dijawab daemon dengan "Request
     * timeout."
     *
     * Batas per panggilan kini ditegakkan di dalam RuntimeExecutor.
     * Yang di sini tinggal langit-langit supaya permintaan yang benar-
     * benar menggantung tidak hidup selamanya.
     */
    this.timeoutExecutor =
        new TimeoutExecutor(
            this.options.timeout * 4
        );

    this.currentProviderId = null;

}

    useMiddleware(middleware) {

        this.pipeline.use(middleware);

        return this;

    }

    registerProvider(id, provider) {

        this.providerRegistry.register(id, provider);

        return this;

    }

    unregisterProvider(id) {

        this.providerRegistry.unregister(id);

        return this;

    }

    getProvider(id) {

        return this.providerRegistry.get(id);

    }

    hasProvider(id) {

        return this.providerRegistry.has(id);

    }

    listProviders() {

        return this.providerRegistry.list();

    }

    use(id) {

        const provider =
            this.getProvider(id);

        if (!provider) {

            throw new ProviderNotFoundError(id);

        }

        this.currentProviderId = id;

        this.service.setProvider(provider);

        return this;

    }

    setDefaultModel(model) {

        this.options.defaultModel = model;

        return this;

    }

    setToolRegistry(registry) {
        if (!mutableRuntimes.has(this)) throw new TypeError("canonical runtime registry is owner-controlled");
        if (!registry || typeof registry.all !== "function") throw new TypeError("invalid tool registry");
        const current = runtimeRegistries.get(this);
        for (const tool of current.all()) current.unregister(tool.name);
        for (const tool of registry.all()) current.register(tool);
        return this;
    }

    listTools() {
    return runtimeRegistries.get(this).all().map(tool => ({
        name: tool.name,
        description: tool.description ?? null,
        parameters: tool.parameters ?? null
    }));

}

    async chat(request) {

        this.validator.validate(request);

        if (!request.model) {

    request.model =
        this.options.defaultModel;

}

// H1/CLOSURE — SATU identitas kanonik untuk SELURUH permintaan:
// disklosur (resolveTools), eksekusi (executor → request.exec),
// dan deferred disclosure membaca objek yang SAMA. capabilitySet
// yang dikirim langsung ke runtime (jalur direct/fallback) ikut
// ternormalisasi & dibekukan — tidak pernah hilang di resolveTools.
request.exec = canonicalRequestExec(request);

if (request.tools === undefined) {

    request.tools = this.resolveTools(request);

}

        this.context?.emit?.(
            new AIRequestStartedEvent({
                provider: this.currentProviderId,
                request
            })
        );

        this.logger.started(
            this.currentProviderId,
            request
        );

        const started =
            Date.now();

        try {

            const response =
                await this.timeoutExecutor.execute(
                    () => this.retryExecutor.execute(
                        () => this.executor.execute(request)
                    )
                );

            const duration =
                Date.now() - started;

            this.metrics.recordSuccess({

                duration,

                tokens:
                    response?.usage?.totalTokens ?? 0

            });

            this.logger.completed(

                this.currentProviderId,

                duration

            );

            this.context?.emit?.(
                new AIRequestCompletedEvent({

                    provider:
                        this.currentProviderId,

                    duration,

                    request,

                    response

                })
            );

            return response;

        }

        catch (error) {

            const duration =
                Date.now() - started;

            this.metrics.recordFailure({

                duration

            });

            this.logger.failed(

                this.currentProviderId,

                error

            );

            this.context?.emit?.(
                new AIRequestFailedEvent({

                    provider:
                        this.currentProviderId,

                    duration,

                    request,

                    error

                })
            );

            throw error;

        }

    }
    async *stream(request) {

    this.validator.validate(request);

    if (!request.model) {

        request.model =
            this.options.defaultModel;

    }

    // H1/CLOSURE: paritas dengan chat() — jalur streaming bukan hop
    // pelucutan identitas; capabilitySet langsung di request ikut.
    request.exec = canonicalRequestExec(request);

    if (request.tools === undefined) {

        request.tools = this.resolveTools(request);

    }

    yield* this.executor.stream(request);

}
/**
 * Tool yang dikirim untuk satu permintaan.
 *
 * Kini lewat TOOL INTELLIGENCE PIPELINE (lihat ai/tools/Pipeline.js):
 * retrieval kapabilitas deterministik → filter peran/kanal → ranking
 * stabil → anggaran konteks → schema minimum. Model hanya melihat
 * tool yang relevan dengan pesan; seluruh tool tetap terdaftar dan
 * bisa dieksekusi.
 *
 * INVARIANT G1: `request.tools` eksplisit dari pemanggil berarti
 * "kandidat universe", BUKAN pintu melewati otorisasi — ia selalu
 * diiriskan dengan universe berizin (Authorization.disclosureFilter)
 * sebelum masuk anggaran.
 *
 * DAMAR_TOOL_PIPELINE=legacy hanya mengganti ALGORITMA seleksi;
 * gerbang otorisasi yang sama tetap dijalankan (invariant H1).
 */
resolveTools(request) {

    const Authorization = require("../tools/Authorization");

    let all = runtimeRegistries.get(this)?.all() ?? [];

    // Universe berizin untuk identitas giliran ini (satu gerbang).
    //
    // A-FINAL + H1/CLOSURE — IDENTITAS KANONIK: `request.exec` adalah
    // identitas eksekusi yang dirakit runtime tepercaya (aiRuntimeService)
    // dan SATU-SATUNYA sumber kebenaran. Bila exec absen, identitas
    // kanonik dibangun dari pembawa otoritas level request (role/
    // capabilitySet/channel/sessionId) lewat canonicalRequestExec —
    // capabilitySet IKUT, dibekukan, dan tidak ada lagi jalur identitas
    // role-only paralel yang bisa menjatuhkan restriction.
    const exec = canonicalRequestExec(request) ?? {};

    // M-1: restriction di sini sudah bentuk kanonik — malformed
    // (bentuk tak dikenal dari request.exec mentah) gagal-keras di
    // batas runtime, bukan ditafsirkan tanpa-batas di hilir.
    const canonicalSet = Authorization.toCapabilitySet(exec.capabilitySet);

    // Window konteks: dari identitas kanonik atau bentuk legacy request.
    const activeWindow =
        exec.contextTokens ??
        request.execContextTokens ??
        null;

    const eligibleUniverse = Authorization.disclosureFilter(all, exec);

    // G1: tools eksplisit pemanggil = kandidat, bukan bypass.
    if (Array.isArray(request.tools)) {
        const allowedNames = new Set(eligibleUniverse.map(t => t.name));
        return request.tools.filter(t => allowedNames.has(t.name));
    }

    const legacy = process.env.DAMAR_TOOL_PIPELINE === "legacy";

    if (legacy) {

        const budget = Number(
            this.options.toolBudget ??
            process.env.DAMAR_TOOL_BUDGET ??
            32
        );

        if (!Number.isFinite(budget) || budget <= 0) {
            return eligibleUniverse.map(t => this.minimizedView(t));
        }

        return selectTools(eligibleUniverse, this.lastUserText(request), budget);

    }

    const { tools, diagnostics } = Pipeline.select({
        tools: eligibleUniverse,
        message: this.lastUserText(request),
        historyTexts: this.historyTexts(request, 2),
        channel: exec.channel ?? request.channel ?? null,
        role: exec.role ?? request.role ?? null,
        // B-FINAL + M-1: himpunan kapabilitas ikut ke pipeline dalam
        // bentuk kanoniknya, sehingga segmen stabil & dinamis sama-sama
        // tunduk pada set delegasi.
        capabilitySet: canonicalSet,
        usedTokens: estimateUsedTokens(request),
        contextTokens: activeWindow
    });

    // Diagnostik giliran terakhir — untuk Console & pengujian.
    this.lastSelection = diagnostics;

    return tools;

}

lastUserText(request) {

    const lastUser = [...(request.messages ?? [])]
        .reverse()
        .find(message => message.role === "user");

    return typeof lastUser?.content === "string" ? lastUser.content : "";

}

historyTexts(request, count = 2) {

    const texts = (request.messages ?? [])
        .filter(message => message.role === "user" &&
            typeof message.content === "string")
        .map(message => message.content);

    return texts.slice(Math.max(0, texts.length - 1 - count), -1);

}

/** Tampilan minimum untuk jalur legacy (schema tetap dipangkas). */
minimizedView(tool) {
    try {
        return require("../tools/SchemaMinimizer").toView(tool);
    }
    catch {
        return tool;
    }
}

getEventEmitter() {

    return this.eventEmitter;

}

}

/** Perkiraan token prompt yang sudah terpakai (system+riwayat+memori). */
function estimateUsedTokens(request) {

    try {
        const chars = JSON.stringify(request.messages ?? []).length;
        return Math.ceil(chars / 4);
    }
    catch {
        return 0;
    }

}

module.exports = AIRuntime;
