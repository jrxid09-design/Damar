const path = require("node:path");
const JsonStore = require("../core/config/JsonStore");

/**
 * profileService — identitas pemilik untuk sapaan/UI. Lokal, sederhana.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "profile.json"),
    { name: "Yansiska" }
);

module.exports = {
    get() { return store.read(); },
    set({ name } = {}) {
        if (name !== undefined) store.write({ name: String(name || "").trim() || "Yansiska" });
        return store.read();
    }
};
