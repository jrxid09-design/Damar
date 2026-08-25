const { BaseEvent } = require("..");

class PluginUnloadedEvent extends BaseEvent {

    constructor(manifest) {

        super(

            "plugin.unloaded",

            {

                manifest

            }

        );

    }

}

module.exports = PluginUnloadedEvent;