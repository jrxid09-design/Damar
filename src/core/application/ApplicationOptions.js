class ApplicationOptions {

    constructor(options = {}) {

        this.name =
            options.name ??
            "Damar";

        this.version =
            options.version ??
            "0.1.0";

        this.pluginPath =
            options.pluginPath ??
            "./src/plugins";

        this.debug =
            options.debug ??
            false;

        this.enableCache =
            options.enableCache ??
            true;

        this.enableEvents =
            options.enableEvents ??
            true;

        this.enableLifecycle =
            options.enableLifecycle ??
            true;

        this.enablePlugins =
            options.enablePlugins ??
            true;

    }

}

module.exports = ApplicationOptions;