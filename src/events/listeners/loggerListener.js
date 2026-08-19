const eventBus = require("../eventBus");
const Events = require("../events");

eventBus.on(Events.TOOL_STARTED, (event) => {
    console.log(
        `[TOOL STARTED] ${event.tool}`
    );
});

eventBus.on(Events.TOOL_COMPLETED, (event) => {
    console.log(
        `[TOOL COMPLETED] ${event.tool}`
    );
});

eventBus.on(Events.TOOL_FAILED, (event) => {
    console.log(
        `[TOOL FAILED] ${event.tool}`
    );
});