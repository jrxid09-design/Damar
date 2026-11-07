const response = require("../utils/response");

const deviceService = require("../services/deviceService");

const sensorService = require("../services/sensorService");

class DeviceController {

    get(req, res, next) {

        try {
            return response.success(res, "Device configuration", {
                config: deviceService.get(),
                readiness: deviceService.readiness()
            });
        }
        catch (error) {
            next(error);
        }

    }

    update(req, res, next) {

        try {
            return response.success(
                res,
                "Device configuration saved",
                deviceService.update(req.body ?? {})
            );
        }
        catch (error) {
            next(error);
        }

    }

    addSensor(req, res, next) {

        try {
            return response.success(
                res,
                "Sensor added",
                deviceService.addSensor(req.body ?? {}),
                201
            );
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    removeSensor(req, res, next) {

        try {
            deviceService.removeSensor(req.params.id);

            return response.success(res, "Sensor removed", { id: req.params.id });
        }
        catch (error) {
            next(error);
        }

    }

    async readSensors(req, res, next) {

        try {
            return response.success(res, "Sensor readings", {
                readings: await sensorService.readAll()
            });
        }
        catch (error) {
            next(error);
        }

    }

}

module.exports = new DeviceController();
