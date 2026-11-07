const response = require("../utils/response");
const osint = require("../services/osintService");
const breach = require("../services/breachService");
const phoneIntel = require("../services/phoneIntelService");
const personTracking = require("../services/personTrackingService");
const socialIntel = require("../services/socialIntelService");

/**
 * Controller OSINT — investigasi, kebocoran data, telepon, dan pelacakan.
 */
class OsintController {

    // ---- Investigasi cepat ----------------------------------------

    async investigate(req, res, next) {
        try {
            const { name, email, username, phone, domain, case_id } = req.body ?? {};
            const target = {};
            if (name) target.name = name;
            if (email) target.email = email;
            if (username) target.username = username;
            if (phone) target.phone = phone;
            if (domain) target.domain = domain;

            if (Object.keys(target).length === 0) {
                return response.error(res, "Sebutkan minimal satu target.", 400);
            }

            const report = await osint.investigate(target, { caseId: case_id });
            return response.success(res, "Investigasi selesai", report);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async email(req, res, next) {
        try {
            const { email } = req.body ?? {};
            if (!email) return response.error(res, "Field 'email' wajib.", 400);
            const info = osint.analyzeEmail(email);
            if (!info.valid) return response.error(res, info.error, 400);

            // Cek kebocoran (gratis)
            let exposure = null;
            try {
                exposure = await breach.check(email);
            }
            catch { /* breach check gagal — lanjut tanpa */ }

            return response.success(res, "Analisis email", { ...info, exposure });
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async username(req, res, next) {
        try {
            const { username, limit } = req.body ?? {};
            if (!username) return response.error(res, "Field 'username' wajib.", 400);
            const results = await osint.searchUsername(username, { maxPlatforms: limit ?? 20 });
            return response.success(res, "Pencarian username", {
                username,
                checked: results.length,
                found: results.filter(r => r.found === true).length,
                results
            });
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async phone(req, res, next) {
        try {
            const { phone } = req.body ?? {};
            if (!phone) return response.error(res, "Field 'phone' wajib.", 400);
            const info = phoneIntel.analyze(phone);
            return response.success(res, "Analisis telepon", info);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async domain(req, res, next) {
        try {
            const { domain } = req.body ?? {};
            if (!domain) return response.error(res, "Field 'domain' wajib.", 400);
            const info = await osint.analyzeDomain(domain);
            return response.success(res, "Analisis domain", info);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    // ---- Kebocoran data (gratis) ------------------------------------

    async breachCheck(req, res, next) {
        try {
            const { query } = req.body ?? {};
            if (!query) return response.error(res, "Field 'query' (email/username) wajib.", 400);
            const result = await breach.check(query);
            // `summary` ikut di sini, bukan hanya di /breach/summary:
            // Console membacanya sebagai vonis utama, dan tanpa field
            // ini seluruh panel Kebocoran gagal dengan TypeError —
            // yang terbaca pengguna sebagai "cek kebocoran error".
            return response.success(res, "Cek kebocoran", {
                ...result,
                summary: breach.summarize(result)
            });
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async breachSummary(req, res, next) {
        try {
            const { query } = req.body ?? {};
            if (!query) return response.error(res, "Field 'query' wajib.", 400);
            const result = await breach.check(query);
            const summary = breach.summarize(result);
            return response.success(res, "Ringkasan kebocoran", { query, ...summary, result });
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    // ---- Telepon intelijen ------------------------------------------

    async phoneAnalyze(req, res, next) {
        try {
            const { phone } = req.body ?? {};
            if (!phone) return response.error(res, "Field 'phone' wajib.", 400);
            const info = phoneIntel.analyze(phone);
            return response.success(res, "Analisis telepon", info);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async phoneAssess(req, res, next) {
        try {
            const { phone, duration, answered } = req.body ?? {};
            if (!phone) return response.error(res, "Field 'phone' wajib.", 400);
            const assessment = phoneIntel.assessCall(phone, { duration, answered });
            return response.success(res, "Penilaian panggilan", assessment);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async phoneBlacklistAdd(req, res, next) {
        try {
            const { phone } = req.body ?? {};
            if (!phone) return response.error(res, "Field 'phone' wajib.", 400);
            const r = phoneIntel.blacklistAdd(phone);
            return response.success(res, "Ditambahkan ke blacklist", r);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async phoneBlacklistRemove(req, res, next) {
        try {
            const { phone } = req.body ?? {};
            if (!phone) return response.error(res, "Field 'phone' wajib.", 400);
            const r = phoneIntel.blacklistRemove(phone);
            return response.success(res, "Dihapus dari blacklist", r);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async phoneWhitelistAdd(req, res, next) {
        try {
            const { phone } = req.body ?? {};
            if (!phone) return response.error(res, "Field 'phone' wajib.", 400);
            const r = phoneIntel.whitelistAdd(phone);
            return response.success(res, "Ditambahkan ke whitelist", r);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async phoneList(req, res, next) {
        try {
            return response.success(res, "Daftar telepon", phoneIntel.list());
        }
        catch (error) { next(error); }
    }

    // ---- Pelacakan orang --------------------------------------------

    async personList(req, res, next) {
        try {
            const { group } = req.query ?? {};
            const r = personTracking.list({ group });
            return response.success(res, "Daftar orang", r);
        }
        catch (error) { next(error); }
    }

    async personRegister(req, res, next) {
        try {
            const { name, label, group } = req.body ?? {};
            if (!name) return response.error(res, "Field 'name' wajib.", 400);
            const r = personTracking.register({ name, label, group });
            return response.success(res, "Orang didaftarkan", r, 201);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async personUpdate(req, res, next) {
        try {
            const { token, ...rest } = req.body ?? {};
            if (!token) return response.error(res, "Field 'token' wajib.", 400);
            const r = personTracking.update(token, rest);
            return response.success(res, "Lokasi diperbarui", r);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async personDetail(req, res, next) {
        try {
            const r = personTracking.get(req.params.id);
            return response.success(res, "Detail orang", r);
        }
        catch (error) { return response.error(res, error.message, 404); }
    }

    async personRevoke(req, res, next) {
        try {
            const r = personTracking.revoke(req.params.id);
            return response.success(res, "Akses dicabut", r);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async personGeofenceAdd(req, res, next) {
        try {
            const r = personTracking.addGeofence(req.body ?? {});
            return response.success(res, "Geofence dibuat", r, 201);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async personGeofenceList(req, res, next) {
        try {
            return response.success(res, "Daftar geofence", personTracking.geofences());
        }
        catch (error) { next(error); }
    }

    async personGeofenceCheck(req, res, next) {
        try {
            const r = personTracking.checkGeofence(req.params.id);
            return response.success(res, "Cek geofence", r);
        }
        catch (error) { return response.error(res, error.message, 404); }
    }

    async personNearby(req, res, next) {
        try {
            const { radius } = req.query ?? {};
            const r = personTracking.nearby({ radiusM: radius ? Number(radius) : 1000 });
            return response.success(res, "Orang terdekat", r);
        }
        catch (error) { next(error); }
    }

    // ---- Manajemen kasus (tetap) ------------------------------------

    async caseCreate(req, res, next) {
        try {
            const { title, description, target, tags } = req.body ?? {};
            if (!title) return response.error(res, "Field 'title' wajib.", 400);
            const c = osint.createCase({ title, description, target, tags });
            return response.success(res, "Kasus dibuat", c, 201);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async caseList(req, res, next) {
        try {
            const { status, tag } = req.query ?? {};
            const cases = osint.listCases({ status, tag });
            return response.success(res, "Daftar kasus", { count: cases.length, cases });
        }
        catch (error) { next(error); }
    }

    async caseDetail(req, res, next) {
        try {
            const c = osint.getCase(req.params.id);
            if (!c) return response.error(res, "Kasus tidak ditemukan.", 404);
            return response.success(res, "Detail kasus", c);
        }
        catch (error) { next(error); }
    }

    async caseAddFinding(req, res, next) {
        try {
            const f = osint.addFinding(req.params.id, req.body ?? {});
            return response.success(res, "Temuan ditambahkan", f, 201);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async caseAddEvidence(req, res, next) {
        try {
            const e = osint.addEvidence(req.params.id, req.body ?? {});
            return response.success(res, "Bukti ditambahkan", e, 201);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async caseClose(req, res, next) {
        try {
            const { conclusion, verdict } = req.body ?? {};
            const c = osint.closeCase(req.params.id, { conclusion, verdict });
            return response.success(res, "Kasus ditutup", c);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async caseDelete(req, res, next) {
        try {
            const r = osint.deleteCase(req.params.id);
            return response.success(res, "Kasus dihapus", r);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async caseExport(req, res, next) {
        try {
            const r = osint.exportCase(req.params.id);
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename="osint-${req.params.id}.json"`);
            return res.send(JSON.stringify(r, null, 2));
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    // ---- Metadata -------------------------------------------------

    async platforms(req, res, next) {
        try {
            return response.success(res, "Platform yang didukung", {
                count: osint.PLATFORMS.length,
                platforms: osint.PLATFORMS.map(p => ({ name: p.name, url: p.url }))
            });
        }
        catch (error) { next(error); }
    }

    // ---- Social Intelligence ----------------------------------------

    async socialBot(req, res, next) {
        try {
            const profile = req.body ?? {};
            if (!profile.username) return response.error(res, "Field 'username' wajib.", 400);
            const result = socialIntel.analyzeAccount(profile);
            return response.success(res, "Analisis akun", result);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async socialComments(req, res, next) {
        try {
            const { username, platforms } = req.body ?? {};
            if (!username) return response.error(res, "Field 'username' wajib.", 400);
            const result = await socialIntel.traceComments(username, { platforms });
            return response.success(res, "Tracing komentar", result);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async socialLocation(req, res, next) {
        try {
            const { trace_id, username, posts, ...profile } = req.body ?? {};

            // Jalur utama: lanjutan dari lacak komentar. Postingan &
            // timestamp-nya sudah ada di jejak, jadi pengguna tak perlu
            // mengetiknya ulang — itu satu alur, bukan dua.
            if (trace_id) {
                return response.success(res, "Estimasi lokasi",
                    socialIntel.locationFromTrace(trace_id));
            }

            if (!username) return response.error(res, "Sebutkan 'trace_id' hasil lacak komentar, atau 'username'.", 400);

            const postList = Array.isArray(posts) ? posts : [];
            const result = socialIntel.estimateLocation({ username, ...profile }, postList);
            return response.success(res, "Estimasi lokasi", result);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async socialNetwork(req, res, next) {
        try {
            const { username, connections } = req.body ?? {};
            if (!username) return response.error(res, "Field 'username' wajib.", 400);
            const connList = Array.isArray(connections) ? connections : [];
            const result = socialIntel.analyzeNetwork(username, connList);
            return response.success(res, "Analisis jaringan", result);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async hoaxCheck(req, res, next) {
        try {
            const { claim, url } = req.body ?? {};

            // Cukup tautannya. Menyuruh pengguna menyalin isi artikel
            // adalah pekerjaan sia-sia, dan potongan pilihan manusia
            // biasanya kehilangan judul — bagian yang justru paling
            // banyak memuat ciri misinformasi.
            const tautan = url ?? (/^https?:\/\//i.test(String(claim ?? "").trim()) ? String(claim).trim() : null);

            if (tautan) {
                return response.success(res, "Cek hoax", await socialIntel.checkHoaxUrl(tautan));
            }

            if (!claim) return response.error(res, "Kirim 'url' berita, atau 'claim' berupa teks.", 400);

            return response.success(res, "Cek hoax", socialIntel.checkHoax(claim));
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async hoaxTrace(req, res, next) {
        try {
            const { claim } = req.body ?? {};
            if (!claim) return response.error(res, "Field 'claim' wajib.", 400);
            const result = await socialIntel.traceSpreader(claim);
            return response.success(res, "Tracing penyebar", result);
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

}

module.exports = new OsintController();
