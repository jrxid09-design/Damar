const test = require("node:test");
const assert = require("node:assert");

/**
 * G/H — PERAN EKSTERNAL DIKUNCI & DEFAULT FAIL-CLOSED.
 *
 * Environment string tidak boleh mencetak otoritas runtime "system"
 * di permukaan token/MCP; default otoritas yang hilang = user.
 */

const { tokenGuard, clampExternalRole, EXTERNAL_ROLES }
    = require("../../src/core/auth/tokenCompare");

function fakeReq({ ip = "127.0.0.1", token = null } = {}) {
    return {
        method: "GET",
        ip,
        socket: { remoteAddress: ip },
        headers: token ? { authorization: `Bearer ${token}` } : {},
        query: {}
    };
}

function fakeRes() {
    const res = {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(b) { this.body = b; return this; }
    };
    return res;
}

const ORIG = {
    TOKEN: process.env.DAMAR_TOKEN,
    ROLE: process.env.DAMAR_AUTH_ROLE,
    MCP_ROLE: process.env.DAMAR_MCP_ROLE,
    DEV_OPEN: process.env.DAMAR_UNSAFE_DEV_OPEN_API,
    DEV_ROLE: process.env.DAMAR_UNSAFE_DEV_ROLE
};

test.after(() => {
    for (const [k, v] of Object.entries(ORIG)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

test("G: enum peran eksternal tertutup — system bukan anggota", () => {
    assert.ok(!EXTERNAL_ROLES.includes("system"));
    assert.deepEqual([...EXTERNAL_ROLES], ["user", "admin", "superadmin"]);
});

test("G: DAMAR_AUTH_ROLE=system TIDAK menjadi system di permukaan token", () => {

    process.env.DAMAR_TOKEN = "token-uji-clamp";
    process.env.DAMAR_AUTH_ROLE = "system";

    const mw = tokenGuard({ roleWhenAuthenticated: "superadmin", surface: "console" });

    const req = fakeReq({ token: "token-uji-clamp" });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.authIdentity.role, "superadmin",
        "env 'system' jatuh ke default permukaan (bukan system)");
});

test("G: DAMAR_MCP_ROLE dikunci enum eksternal", () => {

    assert.equal(clampExternalRole(process.env.DAMAR_MCP_ROLE ?? "system", "user"), "user");
    assert.equal(clampExternalRole("SYSTEM", "user"), "user",
        "case/whitespace tidak menjadi celah");
    assert.equal(clampExternalRole("root", "user"), "user");
    assert.equal(clampExternalRole("", "user"), "user");
    assert.equal(clampExternalRole("admin", "user"), "admin");

});

test("G: jalur dev-open tidak bisa minta system via environment", () => {

    delete process.env.DAMAR_TOKEN;
    process.env.DAMAR_UNSAFE_DEV_OPEN_API = "1";
    process.env.DAMAR_UNSAFE_DEV_ROLE = "system";

    const mw = tokenGuard({ surface: "api" });

    // Klien lokal pun tetap 'user' saat env meminta system.
    const req = fakeReq({ ip: "127.0.0.1" });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.authIdentity.role, "user",
        "DAMAR_UNSAFE_DEV_ROLE=system dikunci ke user");

    // Klien non-lokal selalu user paling terbatas.
    const req2 = fakeReq({ ip: "192.168.1.77" });
    const res2 = fakeRes();
    mw(req2, res2, () => {});
    assert.equal(req2.authIdentity.role, "user");

});

test("G: roleWhenAuthenticated di luar enum juga dikunci", () => {

    process.env.DAMAR_TOKEN = "token-uji-clamp";
    delete process.env.DAMAR_AUTH_ROLE;

    const mw = tokenGuard({ roleWhenAuthenticated: "system", surface: "x" });
    const req = fakeReq({ token: "token-uji-clamp" });
    mw(req, fakeRes(), () => {});

    assert.equal(req.authIdentity.role, "user",
        "kode pun tidak boleh minta peran di luar enum eksternal");

});

test("H: whatsappService tanpa argumen peran jatuh ke 'user' (least privilege)", () => {

    // Static guard pada sumbernya: tiga titik masuk kanal WA wajib
    // ber-default user; tidak ada lagi default superadmin laten.
    const src = require("node:fs")
        .readFileSync(require("node:path")
            .join(__dirname, "..", "..", "src", "services", "whatsappService.js"),
            "utf8");

    const defaults = [...src.matchAll(/userRole\s*=\s*"([a-z]+)"/g)].map(m => m[1]);

    assert.ok(defaults.length >= 3, "tiga titik default userRole ditemukan");
    assert.ok(defaults.every(r => r === "user"),
        `semua default userRole harus 'user', dapat: ${defaults.join(",")}`);

});
