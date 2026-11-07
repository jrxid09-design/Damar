"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ib = require("../../src/runtime/interactionBus");

const BUS_DIR = path.join(__dirname, "..", "..", "src", "runtime", "interactionBus");

function productionSources() {
  const files = [];
  for (const name of fs.readdirSync(BUS_DIR)) {
    if (name.endsWith(".js")) {
      files.push({ name, text: fs.readFileSync(path.join(BUS_DIR, name), "utf8") });
    }
  }
  return files;
}

test("zero-authority guard: no grant fabrication anywhere in production sources", () => {
  const forbidden = [
    /CapabilityGrant/,
    /grantAuthority|grant_authority|authorityGranted/i,
    /superadmin/i,
    /role\s*[:=]\s*["'`]system["'`]/,
    /\bowner\s*[:=]\s*true\b/,
    /isOwner\s*=\s*true/,
    /ToolBus/,
    /RuntimeExecutor/
  ];
  for (const file of productionSources()) {
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(file.text),
        false,
        `${file.name} must not match ${pattern} (zero authority)`
      );
    }
  }
});

test("zero-authority guard: no TOTP validation or OAuth flows in production sources", () => {
  const forbidden = [/totp/i, /oauth/i, /googleAuth|verifyCode|authenticator/i, /accessToken|idToken/i];
  for (const file of productionSources()) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(file.text), false, `${file.name} must not match ${pattern}`);
    }
  }
});

test("zero-actuation guard: no process execution or shell control in production sources", () => {
  const forbidden = [
    /child_process/,
    /process\.kill|process\.signal/ ,
    /\bexit\s*\(\s*[1-9]/,
    /shell\s*[:=]\s*true/,
    /\beval\s*\(/,
    /new\s+Function/,
    /\bexec\s*\(/,
    /\.spawn|spawnSync/
  ];
  for (const file of productionSources()) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(file.text), false, `${file.name} must not match ${pattern}`);
    }
  }
});

test("zero-actuation guard: no filesystem, network, or device actuation in production sources", () => {
  const forbidden = [
    /require\(["']node:fs|require\(["']fs["']\)/,
    /writeFile|appendFile|createWriteStream|unlink|mkdir|rmdir/,
    /createServer|\.listen\s*\(/,
    /fetch\s*\(|XMLHttpRequest|net\.connect/,
    /robotjs|nut-js|nut\.js|keyboard|mouseMove|screenCapture/i,
    /homeassistant|home_assistant|hass\.io/i,
    /\badb\b|puppeteer|playwright|webdriver/i
  ];
  for (const file of productionSources()) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(file.text), false, `${file.name} must not match ${pattern}`);
    }
  }
});

test("zero-actuation guard: every require() is a static string literal", () => {
  const dynamicRequire = /require\s*\(\s*(?!["'])/;
  for (const file of productionSources()) {
    assert.equal(
      dynamicRequire.test(file.text),
      false,
      `${file.name} must not require() dynamically from serialized input`
    );
  }
});

test("zero-execution guard: exported surface exposes no execution substrate", () => {
  const bannedKeyPattern = /toolbus|runtimeexec|childproc|shell|spawnbeval|actuat|devicecontrol/i;
  for (const key of Object.keys(ib)) {
    assert.equal(bannedKeyPattern.test(key), false, `exported key ${key} looks like an execution surface`);
  }
  assert.equal(typeof ib.createInteractionBus, "function");
});

test("future transports: all adapter contracts are inert across their lifecycle", () => {
  const t = { bus: {} };
  for (const Ctor of [
    ib.futureTransports.VoiceTransport,
    ib.futureTransports.TelegramTransport,
    ib.futureTransports.ObservatoryTransport,
    ib.futureTransports.PresenceTransport,
    ib.futureTransports.HotkeyTransport
  ]) {
    const instance = new Ctor(t.bus, { transportId: "x.y" });
    for (const method of ib.futureTransports.LIFECYCLE_METHODS) {
      assert.throws(() => instance[method](), /NOT_IMPLEMENTED/, `${Ctor.name}.${method}`);
    }
  }
});

test("future transports: refuse construction without a bus and expose no networking", () => {
  assert.throws(() => new ib.futureTransports.VoiceTransport(), /requires an InteractionBus/);
  const instance = new ib.futureTransports.TelegramTransport({});
  assert.equal(instance.state, "UNREGISTERED");
  const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(instance));
  for (const name of methodNames) {
    if (name === "constructor") continue;
    assert.equal(
      /poll|listen|fetch|socket|http|openChannel/i.test(name),
      false,
      `lifecycle method ${name} must not imply networking`
    );
  }
});
