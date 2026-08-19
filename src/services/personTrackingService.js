const path = require("node:path");
const crypto = require("node:crypto");

const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");

/**
 * Person Tracking Service — pelacakan lokasi orang secara umum.
 *
 * Bukan hanya keluarga: siapa pun yang OPT-IN bisa dilacak.
 * Setiap orang punya link/token unik; perangkatnya mengirim lokasi
 * secara berkala. Token bisa dicabut kapan saja.
 *
 * Fitur:
 *   - Daftar orang (nama, label, grup).
 *   - Token perangkat (QR code / link).
 *   - Lokasi terkini + riwayat (max 100 titik per orang).
 *   - Geofence: notifikasi bila masuk/keluar area.
 *   - Sosial: siapa di dekat siapa.
 *
 * Data disimpan lokal; tidak ada server pihak ketiga.
 */

const FILE = process.env.AETHER_PERSON_TRACKING_FILE
    || path.join(__dirname, "..", "..", "configs", "person-tracking.json");

const store = new JsonStore(FILE, { persons: {}, geofences: {} });

const MAX_HISTORY = 100;

function id() {
    return "p_" + crypto.randomBytes(4).toString("hex");
}

function now() {
    return new Date().toISOString();
}

function validCoord(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function publicView(p) {
    return {
        id: p.id,
        name: p.name,
        label: p.label ?? null,
        group: p.group ?? null,
        sharing: Boolean(p.location),
        location: p.location ?? null,
        updatedAt: p.updatedAt ?? null,
        historyCount: p.history?.length ?? 0,
        // Token TIDAK pernah ditampilkan setelah pendaftaran.
        createdAt: p.createdAt
    };
}

class PersonTrackingService {

    /** Daftarkan orang baru. Token dikembalikan SEKALI. */
    register({ name, label = null, group = null } = {}) {
        const nm = String(name || "").trim();
        if (!nm) throw new Error("Nama wajib diisi.");

        const data = store.read();
        const pid = id();
        const token = crypto.randomBytes(24).toString("hex");
        const shareUrl = `${process.env.AETHER_PUBLIC_URL ?? "http://localhost:3000"}/track/${token}`;

        const person = {
            id: pid,
            name: nm,
            label: label ? String(label).trim() : null,
            group: group ? String(group).trim() : null,
            token,
            location: null,
            history: [],
            geofenceSubscriptions: [],
            createdAt: now(),
            updatedAt: null
        };

        data.persons[pid] = person;
        store.write(data);

        telemetry.info(`[tracking] orang didaftarkan: ${nm}`);
        return { id: pid, name: nm, shareUrl, token };
    }

    /** Perangkat mengirim lokasi (auth via token). */
    update(token, { lat, lng, accuracy = null, battery = null, speed = null } = {}) {
        const t = String(token || "");
        if (!t) throw new Error("Token wajib.");
        if (!validCoord(Number(lat), Number(lng))) throw new Error("Koordinat tidak valid.");

        const data = store.read();
        const person = Object.values(data.persons ?? {}).find(p => p.token === t);
        if (!person) throw new Error("Token tidak dikenal atau dicabut.");

        const point = {
            lat: Number(lat),
            lng: Number(lng),
            accuracy,
            battery,
            speed,
            at: now()
        };

        person.location = point;
        person.updatedAt = now();
        person.history = [...(Array.isArray(person.history) ? person.history : []), point].slice(-MAX_HISTORY);

        store.write(data);
        return publicView(person);
    }

    /** Daftar semua orang + lokasi terkini. */
    list({ group = null } = {}) {
        const data = store.read();
        let persons = Object.values(data.persons ?? {});
        if (group) persons = persons.filter(p => p.group === group);
        return { persons: persons.map(publicView) };
    }

    /** Detail satu orang + riwayat. */
    get(id) {
        const data = store.read();
        const p = data.persons?.[id];
        if (!p) throw new Error("Orang tidak ditemukan.");
        return {
            ...publicView(p),
            history: (Array.isArray(p.history) ? p.history : []).slice(-20)
        };
    }

    /** Riwayat lengkap (untuk ekspor/analisis). */
    history(id, { limit = 100 } = {}) {
        const data = store.read();
        const p = data.persons?.[id];
        if (!p) throw new Error("Orang tidak ditemukan.");
        return (Array.isArray(p.history) ? p.history : []).slice(-limit);
    }

    /** Cabut akses (token mati). */
    revoke(id) {
        const data = store.read();
        if (!data.persons?.[id]) throw new Error("Orang tidak ditemukan.");
        delete data.persons[id];
        store.write(data);
        return { revoked: id };
    }

    /** Buat geofence (area notifikasi). */
    addGeofence({ name, lat, lng, radiusM = 500, persons = [] } = {}) {
        if (!validCoord(Number(lat), Number(lng))) throw new Error("Koordinat tidak valid.");
        const data = store.read();
        const gid = "g_" + crypto.randomBytes(4).toString("hex");
        data.geofences[gid] = {
            id: gid,
            name: String(name).trim() || "Area",
            lat: Number(lat),
            lng: Number(lng),
            radiusM: Number(radiusM),
            persons: Array.isArray(persons) ? persons : [],
            createdAt: now()
        };
        store.write(data);
        return data.geofences[gid];
    }

    /** Cek apakah seseorang di dalam geofence. */
    checkGeofence(personId) {
        const data = store.read();
        const p = data.persons?.[personId];
        if (!p?.location) return { inside: [], outside: [] };

        const inside = [];
        const outside = [];

        for (const g of Object.values(data.geofences ?? {})) {
            const dist = haversine(p.location.lat, p.location.lng, g.lat, g.lng);
            if (dist <= g.radiusM) inside.push(g.name);
            else outside.push(g.name);
        }

        return { inside, outside };
    }

    /** Siapa di dekat siapa (radius 1 km). */
    nearby({ radiusM = 1000 } = {}) {
        const data = store.read();
        const persons = Object.values(data.persons ?? {}).filter(p => p.location);

        const pairs = [];
        for (let i = 0; i < persons.length; i++) {
            for (let j = i + 1; j < persons.length; j++) {
                const a = persons[i];
                const b = persons[j];
                const dist = haversine(a.location.lat, a.location.lng, b.location.lat, b.location.lng);
                if (dist <= radiusM) {
                    pairs.push({
                        a: { id: a.id, name: a.name },
                        b: { id: b.id, name: b.name },
                        distanceM: Math.round(dist)
                    });
                }
            }
        }

        return { pairs, radiusM };
    }

    /** Hapus geofence. */
    removeGeofence(id) {
        const data = store.read();
        if (!data.geofences?.[id]) throw new Error("Geofence tidak ditemukan.");
        delete data.geofences[id];
        store.write(data);
        return { removed: id };
    }

    /** Daftar geofence. */
    geofences() {
        const data = store.read();
        return Object.values(data.geofences ?? {});
    }

}

// ---- Utilitas --------------------------------------------------------

/** Jarak haversine dalam meter. */
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meter
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = new PersonTrackingService();
module.exports.haversine = haversine;
module.exports.validCoord = validCoord;
