"use strict";
// W6-R3-02 — AppContainer sandbox shim SOURCE (run as node -e <this string>).
//
// This is the ONLY code executed inside the AppContainer child for an
// external-tool sandbox. It is passed to `sandbox-host.exe --entry __eval__`
// as the -e body. It does NOT require() any project module, does NOT touch
// CJS file resolution (which AppContainer denies at the root walk), and runs
// the validated tool module TEXT inside a vm context whose `require` accepts
// ONLY node: builtins + a curated core allowlist. Network/fs/process are
// denied by the Windows AppContainer kernel enforcement (independently
// proven); the shim additionally scrubs ambient environment before tool code.
//
// Because it is Source (a string), exporting it never executes it here; the
// governed executor passes it verbatim to the AppContainer host.

const SHIM_SOURCE = `(async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const path = require("node:path");
  const TOOL_PATH = process.argv[1] || "";
  const OUT_FILE = process.argv[2] || "";
  let ARGS = {};
  let ENV_OK = {};
  try { ARGS = JSON.parse(process.argv[3] || "{}"); } catch (e) { ARGS = {}; }
  try { ENV_OK = JSON.parse(process.argv[4] || "{}"); } catch (e) { ENV_OK = {}; }

  // ---- scrub ambient env BEFORE any tool code (defense in depth) ----
  const ALLOW_ENV = new Set(["NODE_ENV","DAMAR_SANDBOX","SystemRoot","SystemDrive","COMSPEC","WINDIR","TEMP","TMP","USERPROFILE","HOMEDRIVE","HOMEPATH","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE"]);
  for (const k of Object.keys(process.env)) {
    if (!ALLOW_ENV.has(k)) { try { delete process.env[k]; } catch (e) {} }
  }
  for (const k of Object.keys(ENV_OK)) {
    const v = ENV_OK[k];
    if (typeof v === "string") { try { process.env[k] = v; } catch (e) {} }
  }

  // ---- require shim: node: builtins ONLY + curated core — NO relative/npm
  // resolution (none is staged in the AppContainer; kernel denies net/fs/process
  // operations regardless). NET modules REMAIN importable so the tool can
  // ATTEMPT a connection and be kernel-denied (the R3-02 proof); blocking at
  // require would hide the kernel boundary behind a JS check.
  const CORE_ALLOW = new Set(["fs","path","util","os","events","string_decoder","querystring","url","assert","buffer","stream","crypto","zlib"]);
  const results = { ok: false, error: null, output: null, pid: process.pid };
  function sandboxRequire(id) {
    if (typeof id !== "string") throw new Error("SANDBOX_REQUIRE_DENIED:non-string");
    if (id.startsWith("node:")) {
      // node: builtins are importable (core modules); the WFP AppContainer
      // kernel still denies every socket/dgram/dns/http child_process operation.
      const core = id.slice(5);
      return require(core);
    }
    if (CORE_ALLOW.has(id)) return require(id);
    throw new Error("SANDBOX_REQUIRE_DENIED:" + String(id).slice(0, 80));
  }

  try {
    if (!TOOL_PATH || !fs.existsSync(TOOL_PATH)) { results.error = "tool artifact missing in sandbox"; }
    else {
      const src = fs.readFileSync(TOOL_PATH, "utf8");
      const sb = {};
      sb.require = sandboxRequire;
      sb.process = process;
      sb.console = console;
      sb.Buffer = Buffer;
      sb.setTimeout = setTimeout;
      sb.clearTimeout = clearTimeout;
      sb.setImmediate = setImmediate;
      sb.clearImmediate = clearImmediate;
      sb.setInterval = setInterval;
      sb.clearInterval = clearInterval;
      sb.URL = URL;
      sb.URLSearchParams = URLSearchParams;
      sb.TextEncoder = TextEncoder;
      sb.TextDecoder = TextDecoder;
      sb.queueMicrotask = queueMicrotask;
      sb.module = { exports: {} };
      sb.exports = {};
      sb.__filename = TOOL_PATH;
      sb.__dirname = path.dirname(TOOL_PATH);
      sb.global = sb;
      vm.createContext(sb);
      vm.runInContext(src, sb, { filename: TOOL_PATH });
      const exp = sb.module.exports;
      const mod = (typeof exp === "function") ? exp
        : (exp && typeof exp.default === "function" ? exp.default : null);
      if (typeof mod !== "function") { results.error = "tool does not export a callable function"; }
      else {
        const out = await mod(ARGS);
        results.ok = true;
        results.output = out;
      }
    }
  } catch (e) {
    results.error = String(e && e.message).slice(0, 400);
    results.errorType = e && e.constructor && e.constructor.name;
  }
  try {
    const payload = JSON.stringify(results);
    if (Buffer.byteLength(payload, "utf8") > 256 * 1024) {
      // write an explicit cap marker so the executor can map BOUNDS_EXCEEDED
      fs.writeFileSync(OUT_FILE, JSON.stringify({ ok: false, error: "OUTPUT_EXCEEDS_CAP" }), "utf8");
      process.exit(9);
    }
    fs.writeFileSync(OUT_FILE, payload, "utf8");
    process.exit(results.ok ? 0 : 3);
  } catch (e) {
    process.exit(9);
  }
})();`;

module.exports = Object.freeze({ SHIM_SOURCE });