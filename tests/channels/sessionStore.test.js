const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionStore } = require("../../src/channels/sessionStore");

/**
 * Penyimpanan sesi percakapan persisten (SQLite) — evolusi dari
 * `Map` dalam memori yang hilang saat daemon restart.
 */

function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-channels-"));
    return new SessionStore(path.join(dir, "channels.db"));
}

test("sessionKey: grammar dm & group", () => {
    assert.equal(SessionStore.sessionKey("whatsapp", "62812", "dm"), "channel:whatsapp:dm:62812");
    assert.equal(SessionStore.sessionKey("whatsapp", "123@g.us", "group"), "channel:whatsapp:group:123@g.us");
});

test("load sesi baru → array kosong (tanpa galat)", async () => {
    const store = makeStore();
    const turns = await store.load("channel:whatsapp:dm:62812");
    assert.deepEqual(turns, []);
    store.close();
});

test("append + load: giliran tersimpan & bisa dibaca ulang", async () => {
    const store = makeStore();
    const key = "channel:whatsapp:dm:62812";

    await store.append(key, { role: "user", content: "halo" }, { channel: "whatsapp", kind: "dm", peer: "62812" });
    await store.append(key, { role: "assistant", content: "hai!" }, { channel: "whatsapp", kind: "dm", peer: "62812" });

    const turns = await store.load(key);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0], { role: "user", content: "halo" });
    assert.deepEqual(turns[1], { role: "assistant", content: "hai!" });
    store.close();
});

test("jendela giliran dibatasi 20 (yang lama dibuang)", async () => {
    const store = makeStore();
    const key = "channel:telegram:dm:42";

    for (let i = 0; i < 25; i++) {
        await store.append(key, { role: "user", content: `pesan-${i}` }, { channel: "telegram", kind: "dm", peer: "42" });
    }

    const turns = await store.load(key);
    assert.equal(turns.length, 20);
    assert.equal(turns[0].content, "pesan-5"); // 0..4 dibuang
    assert.equal(turns[19].content, "pesan-24");
    store.close();
});

test("clear: kosongkan sesi (/reset)", async () => {
    const store = makeStore();
    const key = "channel:whatsapp:dm:62812";

    await store.append(key, { role: "user", content: "x" }, { channel: "whatsapp", kind: "dm", peer: "62812" });
    await store.clear(key);

    assert.deepEqual(await store.load(key), []);
    store.close();
});

test("list: mengembalikan metadata sesi, bisa difilter kanal", async () => {
    const store = makeStore();

    await store.append("channel:whatsapp:dm:1", { role: "user", content: "a" }, { channel: "whatsapp", kind: "dm", peer: "1" });
    await store.append("channel:telegram:dm:2", { role: "user", content: "b" }, { channel: "telegram", kind: "dm", peer: "2" });

    const all = await store.list();
    assert.equal(all.length, 2);

    const wa = await store.list({ channel: "whatsapp" });
    assert.equal(wa.length, 1);
    assert.equal(wa[0].channel, "whatsapp");
    store.close();
});

test("persistensi: sesi selamat saat dibuka ulang (reopen)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-channels-"));
    const file = path.join(dir, "channels.db");
    const key = "channel:whatsapp:dm:62812";

    const store1 = new SessionStore(file);
    await store1.append(key, { role: "user", content: "bertahan" }, { channel: "whatsapp", kind: "dm", peer: "62812" });
    store1.close();

    const store2 = new SessionStore(file);
    const turns = await store2.load(key);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, "bertahan");
    store2.close();
});
