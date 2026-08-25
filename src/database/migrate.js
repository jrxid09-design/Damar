const fs = require("fs");
const path = require("path");
const db = require("./index");

const schema = fs.readFileSync(
  path.join(__dirname, "schema.sql"),
  "utf8"
);

db.exec(schema, (err) => {
  if (err) {
    console.error("Migration failed:", err.message);
  } else {
    console.log("Database migrated");
  }
});