const BaseComponent = require("../../core/components/BaseComponent");

const {

    AIEventEmitter

} = require("../events");

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
const RuntimeMetrics = require("./RuntimeMetrics");

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

    this.toolRegistry =
        new AIToolRegistry();

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

    this.toolRegistry = registry;

    this.executor.setToolRegistry(registry);

    return this;

}

getToolRegistry() {

    return this.toolRegistry;

}

    async chat(request) {

        this.validator.validate(request);

        if (!request.model) {

    request.model =
        this.options.defaultModel;

}

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

    if (request.tools === undefined) {

        request.tools = this.resolveTools(request);

    }

    yield* this.executor.stream(request);

}
/**
 * Tool yang dikirim untuk satu permintaan.
 *
 * Seluruh tool tetap terdaftar dan bisa dieksekusi; yang dibatasi
 * hanya berapa banyak definisi yang ikut ke dalam prompt. Tanpa
 * batas ini prompt Aether menembus 11.000 token — terlalu berat
 * untuk model lokal dan ditolak provider gratis.
 */
resolveTools(request) {

    let all = this.toolRegistry?.all() ?? [];

    // Sembunyikan tool yang menuntut konektor OFFLINE.
    //
    // openclaw_* dijalankan lewat service OpenClaw (:18789). Bila
    // service itu mati, menawarkan tool-nya ke model hanya menuntun ke
    // kegagalan "openclaw sedang offline" — padahal jalur LANGSUNG
    // (open_app, desktop_type, dst lewat PowerShell) tetap tersedia.
    // Menyaringnya membuat model memilih jalur yang benar-benar bisa
    // jalan, bukan yang kebetulan bernama menarik.
    try {
        const agentHub = require("../../services/agentHub");
        if (!agentHub.connectorOnline("openclaw")) {
            all = all.filter(t => !String(t.name ?? t.id ?? "").toLowerCase().includes("openclaw"));
        }
    }
    catch { /* jika status tak terbaca, tawarkan semua seperti biasa */ }

    const budget = Number(
        this.options.toolBudget ??
        process.env.AETHER_TOOL_BUDGET ??
        32
    );

    if (!Number.isFinite(budget) || budget <= 0) {
        return all;
    }

    const lastUser = [...(request.messages ?? [])]
        .reverse()
        .find(message => message.role === "user");

    const text = typeof lastUser?.content === "string"
        ? lastUser.content
        : "";

    return selectTools(all, text, budget);

}

getEventEmitter() {

    return this.eventEmitter;

}

}

module.exports = AIRuntime;