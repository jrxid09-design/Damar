const Config = require("../core/config/Config");

console.log(

    Config.get("app.name")

);

console.log(

    Config.get("weather.provider")

);

console.log(

    Config.get("http.timeout")

);

Config.set(

    "weather.provider",

    "weatherapi"

);

console.log(

    Config.get("weather.provider")

);

console.log(

    Config.get("not.exist", "Default Value")

);