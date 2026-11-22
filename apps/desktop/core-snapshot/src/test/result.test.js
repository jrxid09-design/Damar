const Result = require("../core/models/Result");

console.log(Result.ok({
    name: "Damar"
}));

console.log(Result.fail("Something went wrong"));