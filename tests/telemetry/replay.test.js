const test = require("node:test");
const assert = require("node:assert");

const telemetry = require("../../src/services/telemetryService");

/**
 * Replay event SSE (Last-Event-ID) — menutup kelemahan lama: Console
 * yang terlambat connect kehilangan event status (hanya log yang
 * punya backlog).
 */

test("publish menambah event ke buffer; events({since}) replay yang terlewat", () => {
    telemetry.clear();

    const e1 = telemetry.publish("whatsapp:message", { preview: "a" });
    const e2 = telemetry.publish("tool:invoked", { tool: "x" });
    const e3 = telemetry.publish("ai:fallback", { model: "m" });

    // Replay dari id e1 → dapat e2 & e3 (yang terlewat setelah e1).
    const missed = telemetry.events({ since: e1.id });
    assert.equal(missed.length, 2);
    assert.equal(missed[0].id, e2.id);
    assert.equal(missed[1].id, e3.id);

    // Replay dari 0 → semua.
    assert.equal(telemetry.events({ since: 0 }).length, 3);
});

test("events({since}) dengan id terbaru → kosong", () => {
    telemetry.clear();
    const e = telemetry.publish("forge:changed", {});
    assert.equal(telemetry.events({ since: e.id }).length, 0);
});

test("event buffer dibatasi capacity (yang tua dibuang)", () => {
    telemetry.clear();
    // capacity default 500; publikasi 600 event → buffer menahan 500.
    for (let i = 0; i < 600; i++) {
        telemetry.publish("probe", { i });
    }
    assert.ok(telemetry.eventBuffer.length <= 500);
});
