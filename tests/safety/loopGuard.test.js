const test = require("node:test");
const assert = require("node:assert");

const loopGuard = require("../../src/core/safety/loopGuard");

/** Tes deteksi kebuntuan (§140). */

test.beforeEach(() => loopGuard.resetAll());

test("panggilan identik lolos sampai ambang, lalu dihentikan", () => {

    const args = { operation: "add", a: 1, b: 1 };

    // Ambang 4: empat pertama harus lolos.
    for (let i = 1; i <= 4; i++) {
        assert.doesNotThrow(
            () => loopGuard.assertNotLooping("calculator.calculator", args),
            `panggilan ke-${i} seharusnya masih lolos`
        );
    }

    assert.throws(
        () => loopGuard.assertNotLooping("calculator.calculator", args),
        err => err.code === "LOOP_DETECTED",
        "panggilan ke-5 identik harus dihentikan"
    );

});

test("argumen berbeda tidak dianggap kebuntuan", () => {

    // Pengulangan sah itu nyata; salah tuduh lebih merusak
    // daripada membiarkan beberapa lewat.
    for (let i = 1; i <= 10; i++) {
        assert.doesNotThrow(
            () => loopGuard.assertNotLooping("calculator.calculator", { a: i, b: 2 }),
            `argumen berbeda ke-${i} tidak boleh diblokir`
        );
    }

});

test("tool berbeda dengan argumen sama tidak saling mengunci", () => {

    const args = { path: "/tmp/x" };

    for (let i = 1; i <= 4; i++) {
        loopGuard.assertNotLooping("filesystem.readFile", args);
    }

    assert.doesNotThrow(
        () => loopGuard.assertNotLooping("filesystem.exists", args),
        "jejak satu tool tidak boleh menghakimi tool lain"
    );

});

test("reset memberi kesempatan bersih", () => {

    const args = { a: 1 };

    for (let i = 1; i <= 4; i++) {
        loopGuard.assertNotLooping("t.x", args);
    }

    loopGuard.resetAll();

    assert.doesNotThrow(
        () => loopGuard.assertNotLooping("t.x", args),
        "setelah reset, giliran baru harus bebas dari jejak lama"
    );

});

test("error identik berulang dihentikan", () => {

    const err = { code: "ECONNREFUSED", message: "connection refused" };

    // Ambang 5.
    for (let i = 1; i <= 5; i++) {
        assert.doesNotThrow(
            () => loopGuard.recordFailure("http.get", err),
            `kegagalan ke-${i} masih boleh dicatat`
        );
    }

    assert.throws(
        () => loopGuard.recordFailure("http.get", err),
        e => e.code === "REPEATED_FAILURE",
        "kegagalan identik ke-6 harus menghentikan"
    );

});

test("error berbeda tidak menumpuk jadi kebuntuan", () => {

    for (let i = 1; i <= 10; i++) {
        assert.doesNotThrow(
            () => loopGuard.recordFailure("http.get", { code: `ERR_${i}` })
        );
    }

});

test("pelanggaran STICKY: pola sama ditahan selama cooldown (H12)", () => {

    const args = { a: 1 };

    for (let i = 1; i <= 4; i++) loopGuard.assertNotLooping("t.y", args);

    assert.throws(() => loopGuard.assertNotLooping("t.y", args));

    // Perilaku LAMA (dihapus oleh audit H12): counter dihapus begitu
    // terpicu sehingga pola identik langsung boleh dicoba lagi — persis
    // loop liar yang seharusnya dicegah. Kini pelanggaran STICKY:
    // panggilan serupa ditolak selama masa tenggang, TANPA menghapus
    // jejak pemicunya.
    assert.throws(
        () => loopGuard.assertNotLooping("t.y", args),
        /masih ditahan|ditahan/,
        "pola identik harus tetap tertahan selama cooldown"
    );

    // Strategi BARU (tool/args berbeda) tidak ikut tertahan.
    assert.doesNotThrow(
        () => loopGuard.assertNotLooping("t.y", { a: 2 }),
        "argumen berbeda bukan pola yang sama"
    );

});

// H4 — reset(scope) harus eksplisit dan terisolasi antar sesi.
test("reset lintas-sesi: reset(A) membersihkan A saja, B tetap tertahan", () => {

    const args = { a: 1 };

    for (let i = 1; i <= 4; i++) {
        loopGuard.assertNotLooping("t.cross", args, "sess-A");
        loopGuard.assertNotLooping("t.cross", args, "sess-B");
    }

    assert.throws(
        () => loopGuard.assertNotLooping("t.cross", args, "sess-A"),
        err => err.code === "LOOP_DETECTED",
        "sesi A harus terblokir sebelum reset"
    );
    assert.throws(
        () => loopGuard.assertNotLooping("t.cross", args, "sess-B"),
        err => err.code === "LOOP_DETECTED",
        "sesi B harus terblokir sebelum reset"
    );

    loopGuard.reset("sess-A");

    assert.doesNotThrow(
        () => loopGuard.assertNotLooping("t.cross", args, "sess-A"),
        "reset(A) harus membersihkan sesi A"
    );
    assert.throws(
        () => loopGuard.assertNotLooping("t.cross", args, "sess-B"),
        err => err.code === "LOOP_DETECTED",
        "reset(A) TIDAK boleh menyentuh sesi B"
    );

});

test("H4: reset tanpa scope eksplisit TIDAK boleh membersihkan apa pun", () => {

    const args = { a: 1 };

    for (let i = 1; i <= 4; i++) {
        loopGuard.assertNotLooping("t.noscope", args, "sess-C");
    }

    assert.throws(() => loopGuard.assertNotLooping("t.noscope", args, "sess-C"));

    for (const bad of [undefined, null, "", 0, {}]) {
        assert.throws(
            () => loopGuard.reset(bad),
            err => err.code === "INVALID_LOOPGUARD_SCOPE",
            `reset(${JSON.stringify(bad) ?? bad}) harus ditolak`
        );
    }

    assert.throws(
        () => loopGuard.assertNotLooping("t.noscope", args, "sess-C"),
        /masih ditahan|ditahan/,
        "reset tidak valid tidak boleh menghapus rem sesi mana pun"
    );

});
