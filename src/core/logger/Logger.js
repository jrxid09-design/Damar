const LogLevel = require("./LogLevel");

class Logger {

    static format(level, message) {

        const timestamp = new Date().toISOString();

        return `[${timestamp}] [${level}] ${message}`;

    }

    static debug(message) {

        console.debug(
            this.format(LogLevel.DEBUG, message)
        );

    }

    static info(message) {

        console.info(
            this.format(LogLevel.INFO, message)
        );

    }

    static warn(message) {

        console.warn(
            this.format(LogLevel.WARN, message)
        );

    }

    static error(message) {

        console.error(
            this.format(LogLevel.ERROR, message)
        );

    }

}

module.exports = Logger;