const test = require("node:test");
const assert = require("node:assert");

const { tokensEqual, extractToken } = require("../../src/core/auth/tokenCompare");

/**
 * Perbandingan token waktu-konstan — pengerasan terhadap timing attack
 * (kelemahan lama: `provided !== token` di LAN).
 */

test("tokensEqual: token sama → true", () => {
    assert.equal(tokensEqual("rahasia-123", "rahasia-123"), true);
});

test("tokensEqual: token beda → false", () => {
    assert.equal(tokensEqual("rahasia-123", "rahasia-999"), false);
});

test("tokensEqual: panjang beda → false (tanpa bocor)", () => {
    assert.equal(tokensEqual("pendek", "ini-token-yang-jauh-lebih-panjang"), false);
});

test("tokensEqual: non-string → false", () => {
    assert.equal(tokensEqual(null, "x"), false);
    assert.equal(tokensEqual(undefined, "x"), false);
    assert.equal(tokensEqual("x", null), false);
});

test("extractToken: header Bearer", () => {
    assert.equal(
        extractToken({ headers: { authorization: "Bearer abc123" }, query: {} }),
        "abc123"
    );
});

test("extractToken: query ?token=", () => {
    assert.equal(
        extractToken({ headers: {}, query: { token: "qwerty" } }),
        "qwerty"
    );
});

test("extractToken: tanpa token → null", () => {
    assert.equal(extractToken({ headers: {}, query: {} }), null);
});
