import { createApp } from "../../lib/appHost.js";
import { skills } from "../skills.js";
import { studio } from "../studio.js";
import { agents } from "../agents.js";
import { tools } from "../tools.js";

/** Studio — Skills + Studio + Agent + Tools jadi satu aplikasi. */
export function buildStudioApp(onBack) {
    return createApp({
        id: "studio", label: "Studio", icon: "grid",
        subtitle: "Skills · Studio · Agent · Tools", onBack,
        tabs: [
            { id: "skills", label: "Skills", icon: skills.icon, view: skills },
            { id: "studio", label: "Studio", icon: studio.icon, view: studio },
            { id: "agents", label: "Agent", icon: agents.icon, view: agents },
            { id: "tools", label: "Tools", icon: tools.icon, view: tools }
        ]
    });
}
