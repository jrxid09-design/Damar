const response = require("../utils/response");
const weather = require("../services/weatherService");
const profile = require("../services/profileService");

/** Cuaca dashboard + profil pemilik (nama). */
class PersonalController {

    async weather(req, res, next) {
        try { return response.success(res, "Cuaca", await weather.current()); }
        catch (error) { next(error); }
    }

    async weatherConfig(req, res, next) {
        try { return response.success(res, "Lokasi cuaca disimpan", weather.setConfig(req.body ?? {})); }
        catch (error) { return response.error(res, error.message, 400); }
    }

    async profile(req, res, next) {
        try { return response.success(res, "Profil", profile.get()); }
        catch (error) { next(error); }
    }

    async saveProfile(req, res, next) {
        try { return response.success(res, "Profil disimpan", profile.set(req.body ?? {})); }
        catch (error) { return response.error(res, error.message, 400); }
    }

}

module.exports = new PersonalController();
