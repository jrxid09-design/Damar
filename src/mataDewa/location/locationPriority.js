/**
 * Location Priority — P0..P5 kanonik untuk konteks lokasi Mata Dewa.
 *
 * P0: lokasi perangkat live BEROTORISASI pengguna
 * P1: home/base default
 * P2: region yang dipin pengguna
 * P3: destinasi aktif / koridor rute
 * P4: Indonesia (default regional)
 * P5: global
 *
 * PRIVACY: lokasi presisi pengguna TIDAK PERNAH di-hard-code dan TIDAK PERNAH
 * di-log. FOLLOW ME hanya aktif dengan izin live-location eksplisit. Tanpa
 * izin → degrade ke tingkat berikutnya secara jujur.
 */

const { isValidPoint } = require("../spatial/geo");

const PRIORITY = Object.freeze({
    P0_LIVE_DEVICE: "P0",
    P1_HOME_BASE: "P1",
    P2_PINNED_REGION: "P2",
    P3_ROUTE_CORRIDOR: "P3",
    P4_REGION_DEFAULT: "P4",
    P5_GLOBAL: "P5"
});

const ORDER = [PRIORITY.P0_LIVE_DEVICE, PRIORITY.P1_HOME_BASE, PRIORITY.P2_PINNED_REGION,
    PRIORITY.P3_ROUTE_CORRIDOR, PRIORITY.P4_REGION_DEFAULT, PRIORITY.P5_GLOBAL];

const DEFAULT_REGION = Object.freeze({ lat: -2.5, lon: 118.0, label: "Indonesia" });

/**
 * LocationProvider:
 * {
 *   liveLocationProvider?: async () => { ok, location?, reason? },  // P0, butuh izin
 *   homeBase?: {lat,lon,label},                                     // P1 (pengguna set lokal)
 *   pinnedRegions?: [{lat,lon,label}],                              // P2
 *   corridorProvider?: () => { ok, waypoints? }                     // P3
 * }
 */
class LocationPriority {

    constructor(provider = {}) {
        this.provider = {
            liveLocationProvider: typeof provider.liveLocationProvider === "function"
                ? provider.liveLocationProvider : null,
            homeBase: isValidPoint(provider.homeBase ?? {}) ? provider.homeBase : null,
            pinnedRegions: Array.isArray(provider.pinnedRegions)
                ? provider.pinnedRegions.filter(r => isValidPoint(r)) : [],
            corridorProvider: typeof provider.corridorProvider === "function"
                ? provider.corridorProvider : null
        };
        // FOLLOW ME butuh otorisasi eksplisit; default TIDAK.
        this.followMe = false;
        this.liveLocationGranted = false;
    }

    /** Aktifkan follow-me HANYA dengan izin live location eksplisit. */
    requestFollowMe({ granted }) {
        this.followMe = granted === true && this.liveLocationGranted === true;
        return { ok: this.followMe, reason: this.followMe ? null : "live_location_not_authorized" };
    }

    /** Tandai izin live location (dari jalur otorisasi Damar — bukan dari sini). */
    setLiveLocationAuthorized(granted) {
        this.liveLocationGranted = granted === true;
        if (!granted) {
            this.followMe = false; // izin dicabut → follow-me mati
        }
    }

    /**
     * Resolusi konteks lokasi sesuai prioritas. Mengembalikan
     * { priority, location|null, degradedFrom[], reason }
     */
    async resolve({ corridorContext = null } = {}) {
        const degradedFrom = [];

        // P0: live device location — hanya dengan izin eksplisit.
        if (this.liveLocationGranted && this.provider.liveLocationProvider) {
            try {
                const live = await this.provider.liveLocationProvider();
                if (live?.ok && isValidPoint(live.location)) {
                    return {
                        priority: PRIORITY.P0_LIVE_DEVICE,
                        location: { lat: live.location.lat, lon: live.location.lon },
                        degradedFrom,
                        reason: null
                    };
                }
                degradedFrom.push({ priority: PRIORITY.P0_LIVE_DEVICE, reason: live?.reason ?? "live_location_failed" });
            }
            catch (error) {
                degradedFrom.push({ priority: PRIORITY.P0_LIVE_DEVICE, reason: error.message ?? "live_location_failed" });
            }
        } else if (this.provider.liveLocationProvider) {
            degradedFrom.push({ priority: PRIORITY.P0_LIVE_DEVICE, reason: "live_location_not_authorized" });
        }

        // P1: home/base.
        if (this.provider.homeBase) {
            return {
                priority: PRIORITY.P1_HOME_BASE,
                location: { lat: this.provider.homeBase.lat, lon: this.provider.homeBase.lon },
                degradedFrom,
                reason: null
            };
        }

        // P2: pinned region pertama.
        const pinned = this.provider.pinnedRegions[0];
        if (pinned) {
            return {
                priority: PRIORITY.P2_PINNED_REGION,
                location: { lat: pinned.lat, lon: pinned.lon },
                degradedFrom,
                reason: null
            };
        }

        // P3: koridor rute aktif (centroid waypoint pertama).
        const corridor = corridorContext ?? (this.provider.corridorProvider
            ? await this.provider.corridorProvider().catch(() => null) : null);
        if (corridor?.ok && Array.isArray(corridor.waypoints) && corridor.waypoints.length) {
            const first = corridor.waypoints.find(isValidPoint);
            if (first) {
                return {
                    priority: PRIORITY.P3_ROUTE_CORRIDOR,
                    location: { lat: first.lat, lon: first.lon },
                    degradedFrom,
                    reason: null
                };
            }
        }

        // P4: default regional (Indonesia) — TIDAK pernah lokasi presisi pengguna.
        return {
            priority: PRIORITY.P4_REGION_DEFAULT,
            location: { lat: DEFAULT_REGION.lat, lon: DEFAULT_REGION.lon },
            degradedFrom,
            reason: degradedFrom.length ? degradedFrom[degradedFrom.length - 1].reason : "no_user_context"
        };
    }
}

module.exports = { LocationPriority, PRIORITY, ORDER, DEFAULT_REGION };
