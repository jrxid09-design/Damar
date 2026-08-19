const chalk = require("chalk");

function line() {
    console.log(chalk.gray("──────────────────────────────────────────────"));
}

function title(text) {
    line();
    console.log(chalk.bold.cyan(` ${text}`));
    line();
}

function section(text) {
    console.log();
    console.log(chalk.bold.white(text));
}

function success(text) {
    console.log(chalk.green(` ✓ ${text}`));
}

module.exports = {
    line,
    title,
    section,
    success
};