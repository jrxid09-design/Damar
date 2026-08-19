import { createApp } from "../../lib/appHost.js";
import { home } from "../home.js";
import { vision } from "../vision.js";
import { nas } from "../nas.js";

/**
 * Ruang — Rumah + Vision + NAS.
 *
 * OSINT sengaja TIDAK ada di sini: ia sudah punya aplikasi sendiri
 * (Aether OSINT), jadi tab kembar hanya membingungkan.
 */
export function buildSpaceApp(onBack) {
    return createApp({
        id: "space", label: "Ruang", icon: "home",
        subtitle: "Rumah · Vision · NAS", onBack,
        tabs: [
            { id: "home", label: "Rumah", icon: home.icon, view: home },
            { id: "vision", label: "Vision", icon: vision.icon, view: vision },
            { id: "nas", label: "NAS", icon: nas.icon, view: nas }
        ]
    });
}
