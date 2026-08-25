const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database(":memory:", (err) => {
  if (err) {
    console.error(err);
    return;
  }

  console.log("SQLite OK");
  db.close();
});