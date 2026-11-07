const test = require("node:test");
const assert = require("node:assert");

/** L-D1 + L-D2: kontrak kanonik RestrictionSet & CapabilityId. */

const { canonical: C } = require("../../src/authority");

test("L-D1: bentuk didukung dinormalisasi eksplisit & immutable", () => {
    for (const input of [["b","a"], new Set(["a","b"]), " a ", null, undefined]) {
        const rs = C.canonicalRestrictionSet(input);
        assert.ok(Object.isFrozen(rs));
        if (input === null || input === undefined) {
            assert.equal(rs.kind, "unrestricted");
        } else {
            assert.ok(rs.kind === "set" || rs.kind === "locked");
            assert.ok(Object.isFrozen(rs.items));
        }
    }
    // string kosong = LOCKED eksplisit
    const locked = C.canonicalRestrictionSet("   ");
    assert.equal(locked.kind, "locked");
    assert.deepEqual(locked.items, []);
});

test("L-D1: Map/object/number/bool MALFORMED -> fail closed (regresi #5)", () => {
    for (const bad of [new Map([["a",1]]), {a:1}, 7, false]) {
        assert.throws(() => C.canonicalRestrictionSet(bad),
            e => e.reasonCode === "CAP_MALFORMED",
            JSON.stringify([...(bad?.entries?.() ?? [])]));
    }
});

test("L-D1: restriction constraints equal-or-stricter", () => {
    const parent = C.canonicalRestrictionSet(["email.send"]);

    // Menambah constraint = authority makin sempit.
    const childStrict =
        C.canonicalRestrictionSet(["email.send","fs.read"]);

    // Menghilangkan constraint parent = authority melebar.
    const childWide =
        C.canonicalRestrictionSet(["fs.write"]);

    assert.equal(C.restrictionSubset(childStrict, parent), true);
    assert.equal(C.restrictionSubset(childWide, parent), false);

    assert.equal(C.restrictionSubset(
        C.canonicalRestrictionSet(null), parent), false,
        "child unrestricted di bawah parent terbatas = melanggar");

    assert.equal(C.restrictionSubset(
        C.canonicalRestrictionSet(""), parent), true,
        "LOCKED adalah restriction paling ketat");
});

test("L-D2: varian formatting menghasilkan CapabilityId KANONIK sama (regresi #6)", () => {
    for (const raw of ["Email.Send", "email__send", "email::send",
                       " email.send ", "EMAIL.SEND"]) {
        assert.equal(C.canonicalCapabilityId(raw), "email.send");
    }
    // bridged vs dotted unify:
    assert.equal(C.canonicalCapabilityId("plugin__tool"),
                 C.canonicalCapabilityId("plugin.tool"));
});

test("L-D2: id tidak sah ditolak dengan CAP_MALFORMED", () => {
    for (const bad of ["", "..", ".a", "a..b", "a b", 42, null]) {
        assert.throws(() => C.canonicalCapabilityId(bad),
            e => e.reasonCode === "CAP_MALFORMED");
    }
});
