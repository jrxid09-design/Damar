const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChannelManager } = require("../../src/channels/channelManager");
const { SessionStore } = require("../../src/channels/sessionStore");

/**
 * Registry kanal + konteks permintaan (AsyncLocalStorage) — abstraksi
 * kanal dengan antarmuka plugin seragam.
 */

function makeManager() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-chmgr-"));
    return new ChannelManager(new SessionStore(path.join(dir, "channels.db")));
}

test("register + list: kanal tercatat dengan status", () => {
    const manager = makeManager();

    manager.register("whatsapp", { running: true, currentChatId: "62812" });
    manager.register("telegram", { running: false });

    const list = manager.list();
    assert.equal(list.length, 2);
    assert.deepEqual(
        list.find(c => c.id === "whatsapp"),
        { id: "whatsapp", running: true, configured: true }
    );
    assert.deepEqual(
        list.find(c => c.id === "telegram"),
        { id: "telegram", running: false, configured: false }
    );
});

test("runWithContext + currentContext: konteks mengalir di rantai async", async () => {
    const manager = makeManager();

    const result = await manager.runWithContext(
        { channel: "whatsapp", chatId: "62812" },
        async () => {
            await Promise.resolve(); // lompati tick — konteks harus bertahan
            return manager.currentContext();
        }
    );

    assert.deepEqual(result, { channel: "whatsapp", chatId: "62812" });
});

test("currentContext di luar runWithContext → null", () => {
    const manager = makeManager();
    assert.equal(manager.currentContext(), null);
});

test("activeChat: konteks permintaan menang atas fallback currentChatId", () => {
    const manager = makeManager();

    // Dua kanal hidup sekaligus (skenario bug lama: tujuan media tertukar).
    manager.register("whatsapp", { running: true, currentChatId: "62812" });
    manager.register("telegram", { running: true, currentChatId: "99" });

    // Tanpa konteks → fallback (urutan registrasi: whatsapp dulu).
    assert.deepEqual(manager.activeChat(), { kind: "whatsapp", id: "62812" });

    // Dengan konteks telegram → telegram menang, walau whatsapp terdaftar dulu.
    return manager.runWithContext({ channel: "telegram", chatId: "99" }, () => {
        assert.deepEqual(manager.activeChat(), { kind: "telegram", id: "99" });
    });
});

test("activeChat: kanal konteks mati → abaikan, pakai fallback", () => {
    const manager = makeManager();
    manager.register("whatsapp", { running: false, currentChatId: "62812" });

    return manager.runWithContext({ channel: "whatsapp", chatId: "62812" }, () => {
        assert.deepEqual(manager.activeChat(), { kind: "console", id: null });
    });
});

test("history/remember/forget: sesi persist lewat manager", async () => {
    const manager = makeManager();
    await manager.start();

    await manager.remember("whatsapp", "62812", { role: "user", content: "halo" }, "dm");

    const turns = await manager.history("whatsapp", "62812", "dm");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].content, "halo");

    await manager.forget("whatsapp", "62812", "dm");
    assert.deepEqual(await manager.history("whatsapp", "62812", "dm"), []);

    manager.stop();
});
