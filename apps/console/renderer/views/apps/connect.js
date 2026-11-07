import { createApp } from "../../lib/appHost.js";
import { devices } from "../devices.js";
import { integrations } from "../integrations.js";

/** Terhubung — Perangkat + Integrasi jadi satu aplikasi. */
export function buildConnectApp(onBack) {
    return createApp({
        id: "connect", label: "Terhubung", icon: "plug",
        subtitle: "Perangkat · Integrasi", onBack,
        tabs: [
            { id: "devices", label: "Perangkat", icon: devices.icon, view: devices },
            { id: "integrations", label: "Integrasi", icon: integrations.icon, view: integrations }
        ]
    });
}
