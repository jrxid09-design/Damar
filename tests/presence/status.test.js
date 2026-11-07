const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { LIFECYCLE, CAUSE, createPresenceRuntime, createManualClock } = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence observers — isolasi kegagalan (P22)", () => {
    it("subscriber menerima event TRANSITION beku dengan field kanon", () => {
        const { rt, host } = createBootedRuntime();
        const events = [];
        rt.subscribe((event) => events.push(event));
        rt.summon(host);
        const transition = events.filter((e) => e.type === "TRANSITION").pop();
        assert.ok(transition);
        assert.equal(Object.isFrozen(transition), true);
        assert.deepEqual([transition.from, transition.to], [LIFECYCLE.DORMANT, LIFECYCLE.AWAKE]);
    });

    it("unsubscribe idempoten: panggil dua kali aman, event berhenti setelah unsub", () => {
        const { rt, host } = createBootedRuntime();
        let count = 0;
        const unsub = rt.subscribe(() => { count += 1; });
        rt.summon(host);
        assert.equal(count, 1);
        assert.equal(unsub(), true);
        assert.equal(unsub(), false, "unsubscribe kedua idempoten");
        rt.dismiss(host);
        assert.equal(count, 1);
    });

    it("registrasi duplikat listener yang sama ditolak eksplisit (PRESENCE_DUPLICATE_SUBSCRIBER)", () => {
        const { rt } = createBootedRuntime();
        const listener = () => {};
        rt.subscribe(listener);
        assert.throws(() => rt.subscribe(listener), /PRESENCE_DUPLICATE_SUBSCRIBER/);
    });

    it("listener non-fungsi ditolak TypeError", () => {
        const { rt } = createBootedRuntime();
        assert.throws(() => rt.subscribe("bukan-fungsi"), TypeError);
    });

    it("subscriber yang melempar terisolasi: subscriber lain tetap menerima event", () => {
        const { rt, host } = createBootedRuntime();
        const received = [];
        rt.subscribe(() => { throw new Error("crash visual"); });
        rt.subscribe((event) => received.push(event));
        rt.summon(host);
        assert.ok(received.length >= 1, "subscriber sehat tetap dilayani");
        const status = rt.getPresenceStatus();
        assert.equal(status.lifecycleState, LIFECYCLE.AWAKE);
        assert.ok(rt.getCounters().subscriberErrorsIsolated >= 1);
    });

    it("maxSubscribers ditegakkan: melebihi batas melempar PRESENCE_MAX_SUBSCRIBERS", () => {
        const { rt } = createBootedRuntime({ config: { maxSubscribers: 2 } });
        rt.subscribe(() => {});
        rt.subscribe(() => {});
        assert.throws(() => rt.subscribe(() => {}), /PRESENCE_MAX_SUBSCRIBERS/);
    });

    it("mutasi array subscriber saat notifikasi tidak merusak iterasi (unsubscribe di callback)", () => {
        const { rt, host } = createBootedRuntime();
        let calls = 0;
        let unsub = null;
        unsub = rt.subscribe(() => { calls += 1; unsub(); });
        rt.summon(host);
        rt.dismiss(host);
        assert.equal(calls, 1);
    });
});

describe("presence status snapshot — immutable & bounded (P21)", () => {
    it("snapshot dibekukan menyeluruh: objek dan array-nya frozen", () => {
        const { rt } = createBootedRuntime();
        const status = rt.getPresenceStatus();
        assert.equal(Object.isFrozen(status), true);
        assert.equal(Object.isFrozen(status.degradedReasons), true);
        assert.equal(Object.isFrozen(status.recentDiagnostics), true);
    });

    it("field kanon lengkap sesuai kontrak UI/Observatory/tray/watchdog", () => {
        const { rt } = createBootedRuntime();
        const status = rt.getPresenceStatus();
        for (const key of [
            "generation", "lifecycleState", "activityPresentation", "health",
            "summoned", "activeActivityCount", "waitingOwnerCount",
            "degradedReasons", "resourcePressure", "uptimeMs",
            "lastTransition", "recentDiagnostics"
        ]) {
            assert.ok(key in status, `field ${key} wajib ada`);
        }
    });

    it("uptime numerik sejak boot; pra-boot null", () => {
        const raw = createPresenceRuntime({ clock: createManualClock(100) });
        assert.equal(raw.getPresenceStatus().uptimeMs, null);
        const { rt, clock } = createBootedRuntime({ startMs: 1000 });
        clock.advanceMs(1500);
        const uptime = rt.getPresenceStatus().uptimeMs;
        assert.equal(uptime, 1500);
    });

    it("tanpa rahasia: snapshot hanya berisi nilai enum/id/angka — tak ada token aktivitas", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const { token } = rt.beginActivity("THINKING");
        const serialized = JSON.stringify(rt.getPresenceStatus());
        assert.equal(serialized.includes(token.id), false, "id token tak boleh bocor ke status");
        assert.equal(/secret|password|apikey/i.test(serialized), false);
    });

    it("recentDiagnostics bounded oleh maxDiagnostics", () => {
        const { rt, resource } = createBootedRuntime({ config: { maxDiagnostics: 5, maxDegradedReasons: 8 } });
        for (let i = 0; i < 20; i++) {
            rt.reportDegradation({ producer: resource, kind: DEGRADED_KIND(i) });
            rt.clearDegradation({ producer: resource, kind: DEGRADED_KIND(i) }).ok;
        }
        assert.ok(rt.getPresenceStatus().recentDiagnostics.length <= 5);
    });

    function DEGRADED_KIND(i) {
        return ["MODEL_UNAVAILABLE", "SENSORIUM_UNAVAILABLE", "DEPENDENCY_FAILURE", "UNKNOWN"][i % 4];
    }
});
