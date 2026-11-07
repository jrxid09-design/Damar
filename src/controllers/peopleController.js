const response = require("../utils/response");

const immich = require("../services/immichService");
const face = require("../services/faceService");

class PeopleController {

    async status(req, res, next) {
        try {
            return response.success(res, "People status", {
                immich: { ...immich.configView(), health: await immich.health() },
                face: face.configView()
            });
        }
        catch (error) {
            next(error);
        }
    }

    saveImmich(req, res, next) {
        try {
            return response.success(res, "Immich disimpan", immich.setConfig(req.body ?? {}));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    saveFace(req, res, next) {
        try {
            return response.success(res, "Layanan wajah disimpan", face.setConfig(req.body ?? {}));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    async people(req, res, next) {
        try {
            return response.success(res, "People", { people: await immich.people() });
        }
        catch (error) {
            return response.error(res, error.message,
                error.code === "IMMICH_NOT_CONFIGURED" ? 400 : 502);
        }
    }

    async search(req, res, next) {
        try {
            const { query, person, limit } = req.body ?? {};
            let photos;
            if (person) {
                const matches = await immich.findPerson(person);
                photos = matches.length
                    ? await immich.searchByPerson(matches.map(m => m.id), { query, limit })
                    : [];
            }
            else {
                photos = await immich.searchSmart(query, { limit });
            }
            return response.success(res, "Photos", { found: photos.length, photos });
        }
        catch (error) {
            return response.error(res, error.message,
                error.code === "IMMICH_NOT_CONFIGURED" ? 400 : 502);
        }
    }

}

module.exports = new PeopleController();
