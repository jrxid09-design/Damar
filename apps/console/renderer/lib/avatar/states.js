/**
 * Damar Character States — kanonik.
 * Sumber: character/damar-state.json (source of truth).
 *
 * Setiap state mendefinisikan parameter per-komponen:
 *   eyes   : { shape, scale, rotation (deg), brightness, color? }
 *   shell  : { rotationSpeed, fragmentAmplitude }
 *   core   : { brightness, pulseSpeed, rotationSpeed, color? }
 *   particles: { density, speed, pattern, color? }
 */

export const STATE_SPECS = {
    IDLE: {
        eyes: { shape: "vertical_oval", scale: 1.0, rotation: 0, brightness: 0.6 },
        shell: { rotationSpeed: 0.15, fragmentAmplitude: 0.02 },
        core: { brightness: 0.65, pulseSpeed: 0.5, rotationSpeed: 0.1 },
        particles: { density: 0.25, speed: 0.15, pattern: "slow_orbit" }
    },
    FOCUSED: {
        eyes: { shape: "slightly_narrow", scale: 0.9, rotation: 0, brightness: 0.8 },
        shell: { rotationSpeed: 0.25, fragmentAmplitude: 0.01 },
        core: { brightness: 0.85, pulseSpeed: 0.8, rotationSpeed: 0.2 },
        particles: { density: 0.35, speed: 0.3, pattern: "structured_orbit" }
    },
    THINKING: {
        eyes: { shape: "asymmetric_angled", scale: 0.95, rotation: 8, brightness: 0.75 },
        shell: { rotationSpeed: 0.5, fragmentAmplitude: 0.06 },
        core: { brightness: 1.0, pulseSpeed: 1.2, rotationSpeed: 0.4 },
        particles: { density: 0.7, speed: 0.7, pattern: "spiral" }
    },
    ANALYZING: {
        eyes: { shape: "focused_angular", scale: 0.85, rotation: 0, brightness: 1.0 },
        shell: { rotationSpeed: 0.65, fragmentAmplitude: 0.03 },
        core: { brightness: 1.0, pulseSpeed: 1.5, rotationSpeed: 0.5 },
        particles: { density: 0.8, speed: 0.9, pattern: "data_stream" }
    },
    EXECUTING: {
        eyes: { shape: "sharp_focused", scale: 0.9, rotation: 0, brightness: 1.0 },
        shell: { rotationSpeed: 0.9, fragmentAmplitude: 0.08 },
        core: { brightness: 1.2, pulseSpeed: 2.0, rotationSpeed: 0.8 },
        particles: { density: 1.0, speed: 1.0, pattern: "directional_stream" }
    },
    CURIOUS: {
        eyes: { shape: "wide_soft", scale: 1.15, rotation: 0, brightness: 0.9 },
        shell: { rotationSpeed: 0.3, fragmentAmplitude: 0.05 },
        core: { brightness: 0.9, pulseSpeed: 0.6, rotationSpeed: 0.2 },
        particles: { density: 0.55, speed: 0.5, pattern: "floating" }
    },
    HAPPY: {
        eyes: { shape: "soft_crescent", scale: 1.0, rotation: 0, brightness: 1.0 },
        shell: { rotationSpeed: 0.35, fragmentAmplitude: 0.05 },
        core: { brightness: 1.0, pulseSpeed: 0.8, rotationSpeed: 0.2 },
        particles: { density: 0.6, speed: 0.4, pattern: "gentle_orbit" }
    },
    UNDERSTANDING: {
        eyes: { shape: "relaxed", scale: 0.95, rotation: 0, brightness: 0.85 },
        shell: { rotationSpeed: 0.2, fragmentAmplitude: 0.03 },
        core: { brightness: 1.1, pulseSpeed: 0.7, rotationSpeed: 0.15 },
        particles: { density: 0.4, speed: 0.25, pattern: "smooth_circular" }
    },
    ALERT: {
        eyes: { shape: "sharp_angled", scale: 0.9, rotation: -8, brightness: 1.5 },
        shell: { rotationSpeed: 1.3, fragmentAmplitude: 0.1 },
        core: { brightness: 1.5, pulseSpeed: 2.5, rotationSpeed: 0.6 },
        particles: { density: 1.0, speed: 1.5, pattern: "rapid_orbit" }
    },
    SURPRISED: {
        eyes: { shape: "large_round", scale: 1.35, rotation: 0, brightness: 1.5 },
        shell: { rotationSpeed: 0.15, fragmentAmplitude: 0.15 },
        core: { brightness: 1.2, pulseSpeed: 1.5, rotationSpeed: 0.2 },
        particles: { density: 0.9, speed: 1.3, pattern: "radial_burst" }
    },
    ERROR: {
        eyes: { shape: "sharp_angular", scale: 0.9, rotation: 0, brightness: 1.8, color: "#FF3B3B" },
        shell: { rotationSpeed: 1.8, fragmentAmplitude: 0.2 },
        core: { brightness: 1.8, pulseSpeed: 3.0, rotationSpeed: 0.9, color: "#FF3B3B" },
        particles: { density: 1.2, speed: 2.0, pattern: "chaotic_fragmentation", color: "#FF3B3B" }
    },
    SLEEP: {
        eyes: { shape: "closed_line", scale: 0.7, rotation: 0, brightness: 0.1 },
        shell: { rotationSpeed: 0.03, fragmentAmplitude: 0.005 },
        core: { brightness: 0.15, pulseSpeed: 0.1, rotationSpeed: 0.02 },
        particles: { density: 0.05, speed: 0.02, pattern: "almost_static" }
    },
    RECOVERY: {
        eyes: { shape: "soft_oval", scale: 1.0, rotation: 0, brightness: 0.7, color: "#21E6A4" },
        shell: { rotationSpeed: 0.15, fragmentAmplitude: 0.03 },
        core: { brightness: 0.8, pulseSpeed: 0.5, rotationSpeed: 0.1, color: "#21E6A4" },
        particles: { density: 0.7, speed: 0.5, pattern: "stabilizing_spiral", color: "#21E6A4" }
    }
};

/** Warna entitas per-state (hierarki warna damar-materials.json). */
export const STATE_COLOR = {
    IDLE: 0x00D9FF,
    FOCUSED: 0x00D9FF,
    THINKING: 0x7C5CFF,
    ANALYZING: 0x00D9FF,
    EXECUTING: 0x0FAAFF,
    CURIOUS: 0x00D9FF,
    HAPPY: 0x21E6A4,
    UNDERSTANDING: 0x00D9FF,
    ALERT: 0xE8FCFF,
    SURPRISED: 0x00D9FF,
    ERROR: 0xFF3B3B,
    SLEEP: 0x39435E,
    RECOVERY: 0x21E6A4
};

/** Pemetaan nama legacy/runtime → state kanonik. */
export const LEGACY_MAP = {
    idle: "IDLE",
    listening: "FOCUSED",
    focused: "FOCUSED",
    thinking: "THINKING",
    reasoning: "THINKING",
    analyzing: "ANALYZING",
    executing: "EXECUTING",
    speaking: "UNDERSTANDING",
    curious: "CURIOUS",
    happy: "HAPPY",
    success: "HAPPY",
    understanding: "UNDERSTANDING",
    alert: "ALERT",
    warning: "ALERT",
    surprised: "SURPRISED",
    error: "ERROR",
    offline: "SLEEP",
    sleep: "SLEEP",
    recovery: "RECOVERY"
};

/** resolveState("thinking") → "THINKING". Unknown → "IDLE". */
export function resolveState(name) {
    if (!name) return "IDLE";
    if (STATE_SPECS[name]) return name;
    const k = LEGACY_MAP[String(name).toLowerCase()];
    return STATE_SPECS[k] ? k : "IDLE";
}

/**
 * Bentuk mata → [scaleX, scaleY, rotFactor] (rotFactor: +1 kiri, -1 kanan).
 * Ekspresi murni geometri — tanpa wajah manusia (DAMAR_CHARACTER_RULES).
 */
export const EYE_SHAPES = {
    vertical_oval: [1, 1, 0],
    slightly_narrow: [1, 0.9, 0],
    asymmetric_angled: [1, 0.95, 1],
    focused_angular: [1.05, 0.8, 0],
    sharp_focused: [1, 0.85, 0],
    wide_soft: [1.05, 1.15, 0],
    soft_crescent: [1, 0.42, 0],
    relaxed: [1, 0.95, 0],
    sharp_angled: [1, 0.9, -1],
    large_round: [1.3, 1.3, 0],
    closed_line: [1, 0.06, 0],
    soft_oval: [1, 1.05, 0]
};

/** Pola partikel → bobot medan gerak [orbit, spiral, stream, float, jitter, burst]. */
export const PATTERN_WEIGHTS = {
    slow_orbit: { orbit: 0.3, spiral: 0, stream: 0, float: 0.15, jitter: 0, burst: 0 },
    structured_orbit: { orbit: 0.5, spiral: 0, stream: 0, float: 0.1, jitter: 0, burst: 0 },
    spiral: { orbit: 0.6, spiral: 0.6, stream: 0, float: 0, jitter: 0, burst: 0 },
    data_stream: { orbit: 0.25, spiral: 0, stream: 0.5, float: 0, jitter: 0, burst: 0 },
    directional_stream: { orbit: 0.1, spiral: 0, stream: 1.0, float: 0, jitter: 0, burst: 0 },
    floating: { orbit: 0.15, spiral: 0, stream: 0, float: 0.6, jitter: 0, burst: 0 },
    gentle_orbit: { orbit: 0.35, spiral: 0, stream: 0, float: 0.25, jitter: 0, burst: 0 },
    smooth_circular: { orbit: 0.45, spiral: 0, stream: 0, float: 0.1, jitter: 0, burst: 0 },
    rapid_orbit: { orbit: 1.4, spiral: 0, stream: 0, float: 0, jitter: 0, burst: 0 },
    radial_burst: { orbit: 0.3, spiral: 0, stream: 0, float: 0, jitter: 0.1, burst: 0.8 },
    chaotic_fragmentation: { orbit: 0.6, spiral: 0, stream: 0, float: 0, jitter: 1.0, burst: 0.3 },
    almost_static: { orbit: 0.05, spiral: 0, stream: 0, float: 0.02, jitter: 0, burst: 0 },
    stabilizing_spiral: { orbit: 0.3, spiral: 0.7, stream: 0, float: 0, jitter: 0, burst: 0 }
};

/**
 * Transisi (damar-state.json transitionRules):
 * default 450ms smooth-damped; ANY→ALERT/ERROR cepat; pulih perlahan.
 * Diimplementasikan sebagai time-constant τ per target state.
 */
export const TRANSITION_TAU = {
    default: 0.45,
    ALERT: 0.15,
    ERROR: 0.1,
    RECOVERY: 1.2,
    SLEEP: 0.8
};
