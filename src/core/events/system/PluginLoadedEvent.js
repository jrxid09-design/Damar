const { BaseEvent } = require("..");

class PluginLoadedEvent extends BaseEvent {

    constructor(manifest, instance) {

        super(

            "plugin.loaded",

            {

                manifest,

                instance

            }

        );

    }

}

module.exports = PluginLoadedEvent;