/**
 * Tes ekstraksi string bounded: ASCII, UTF-16LE, penegakan limit.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { strings } = require("../../src/reintel");
const { DEFAULTS } = require("../../src/reintel/config/ReIntelConfig");

const BASE_LIMITS = { ...DEFAULTS.limits };

function limits(over = {}) {
    return { ...BASE_LIMITS, ...over };
}

test("ASCII bounded: string printable terekstrak dengan offset", () => {
    const buf = Buffer.concat([
        Buffer.from([0x00, 0x01, 0x02]),
        Buffer.from("hello_world"),
        Buffer.from([0xff]),
        Buffer.from("second")
    ]);
    const res = strings.extractStrings(buf, limits());
    const values = res.strings.map((s) => s.value);
    assert.deepEqual(values, ["hello_world", "second"]);
    assert.equal(res.strings[0].encoding, "ascii");
    assert.equal(res.strings[0].offset, 3);
    assert.equal(res.truncated, false);
});

test("UTF-16LE bounded: string wide terekstrak", () => {
    const buf = Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from("wide_text", "utf16le"),
        Buffer.from([0xaa])
    ]);
    const res = strings.extractStrings(buf, limits());
    const wide = res.strings.filter((s) => s.encoding === "utf16le");
    assert.ok(wide.length >= 1);
    assert.equal(wide[0].value, "wide_text");
});

test("limit jumlah string ditegakkan + flag truncated", () => {
    const chunk = Buffer.from([0x00]);       // pemisah
    const word = Buffer.from("abcdefgh");    // 8 printable
    const parts = [];
    for (let i = 0; i < 50; i++) parts.push(word, chunk);
    const buf = Buffer.concat(parts);

    const res = strings.extractStrings(buf, limits({ maxStrings: 10 }));
    assert.equal(res.strings.length, 10);
    assert.equal(res.truncated, true);
});

test("budget byte pemindaian ditegakkan (tidak scan seluruh file)", () => {
    const word = Buffer.from("abcdefgh");
    const parts = [];
    for (let i = 0; i < 1000; i++) parts.push(word, Buffer.from([0x00]));
    const big = Buffer.concat(parts);

    const res = strings.extractStrings(big, limits({ maxStringScanBytes: 1024 }));
    assert.equal(res.scannedBytes, 1024);
    assert.ok(res.truncated);
    assert.ok(res.strings.length < 1000);
});
