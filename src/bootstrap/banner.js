const consoleUI = require("../utils/console");

module.exports = ({ version, port }) => {

    consoleUI.title(`AETHER AI v${version}`);

    console.log(` Environment : ${process.env.NODE_ENV}`);
    console.log(` URL         : http://localhost:${port}`);

};