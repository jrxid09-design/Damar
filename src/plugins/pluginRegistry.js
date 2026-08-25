const { BaseRegistry } =
    require("../core/registry");

class PluginRegistry extends BaseRegistry {

    register(plugin) {

        return super.register(

            plugin.manifest.id,

            plugin

        );

    }

    /** Semua plugin yang ter-load, tanpa perlu tahu bentuk Map-nya. */
    all() {

        return this.values();

    }

    /** Ringkasan aman-untuk-UI, tanpa membocorkan instance modul. */
    describe() {

        return this.values().map(plugin => ({

            id: plugin.manifest.id,

            name: plugin.manifest.name,

            version: plugin.manifest.version,

            description: plugin.manifest.description ?? "",

            category: plugin.manifest.category ?? "general",

            author: plugin.manifest.author ?? null,

            tags: plugin.manifest.tags ?? [],

            permissions: plugin.manifest.permissions ?? [],

            toolCount: (plugin.instance?.tools ?? []).length

        }));

    }

}

module.exports = new PluginRegistry();