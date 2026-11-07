#!/usr/bin/env node
/*
 * Deterministic fail-closed dependency policy validator (isolated candidate).
 * Executes BEFORE network retrieval + lifecycle scripts (wired as CI pre-step / safe bootstrap).
 * Usage: node check-dep-policy.js package-lock.json --policy policy.json --package-json package.json
 *        --lock-sha256 <sha256> --approved-lock-sha256 <owner-approved-sha256>
 * Exit 0 = policy OK; nonzero = POLICY_VIOLATION (fail-closed).
 */
const fs = require("fs");
const crypto = require("crypto");

const lockPath = process.argv[2];
if (!lockPath) { console.error("POLICY_VIOLATION: no lockfile argument"); process.exit(1); }

let lockBytes;
try { lockBytes = fs.readFileSync(lockPath); }
catch (e) { console.error("POLICY_VIOLATION: unreadable lockfile: " + e.message); process.exit(1); }

// Byte-integrity guard: the expected digest must come from the caller.
// In CI, missing/malformed/duplicate digest arguments are a hard failure.
// WARNING: deriving the digest from untrusted PR content is NOT publisher proof.
const ciEnv = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const shaArgs = process.argv.filter(x => x === "--lock-sha256").length;
const shaIdx = process.argv.indexOf("--lock-sha256");
const supplied = shaIdx > -1 ? process.argv[shaIdx + 1] : null;
if ((ciEnv && shaArgs !== 1) || (shaArgs > 0 && (shaArgs !== 1 || !/^[0-9a-fA-F]{64}$/.test(String(supplied || ""))))) {
  console.error("POLICY_VIOLATION: CI requires exactly one valid --lock-sha256 argument");
  process.exit(1);
}
if (shaArgs === 1) {
  const want = supplied.toLowerCase();
  const got = crypto.createHash("sha256").update(lockBytes).digest("hex");
  if (want !== got) {
    console.error("POLICY_VIOLATION: TOCTOU lockfile digest mismatch (want " + want + ", got " + got + ")");
    process.exit(1);
  }
}

// Approved-byte authorization is separate from the self-computed TOCTOU digest.
// The required value MUST originate outside the PR/candidate and be enforced by
// a trusted independent check. A PR-controlled value is not a trust anchor.
const approvedCount = process.argv.filter(x => x === "--approved-lock-sha256").length;
const approvedIdx = process.argv.indexOf("--approved-lock-sha256");
const approvedValue = approvedIdx > -1 ? process.argv[approvedIdx + 1] : null;
if ((ciEnv && approvedCount !== 1) ||
    (approvedCount > 0 && (approvedCount !== 1 || !/^[0-9a-fA-F]{64}$/.test(String(approvedValue || ""))))) {
  console.error("POLICY_VIOLATION: CI requires exactly one valid --approved-lock-sha256 from independent owner approval");
  process.exit(1);
}
if (approvedCount === 1) {
  const got = crypto.createHash("sha256").update(lockBytes).digest("hex");
  if (approvedValue.toLowerCase() !== got) {
    console.error("POLICY_VIOLATION: UNAPPROVED_LOCK_BYTES independently approved digest differs");
    process.exit(1);
  }
}
// A missing/omitted policy or package manifest invalidates CI assurance.
for (const flag of ["--policy", "--package-json"]) {
  const count = process.argv.filter(x => x === flag).length;
  const idx = process.argv.indexOf(flag);
  if (ciEnv && (count !== 1 || !process.argv[idx+1] || process.argv[idx+1].startsWith("--"))) {
    console.error("POLICY_VIOLATION: CI requires one " + flag + " argument");
    process.exit(1);
  }
}
// A protected CI gate must never degrade to report-only, even if checks pass.
if (ciEnv && process.argv.includes("--report-only")) {
  console.error("POLICY_VIOLATION: --report-only refused in CI environment");
  process.exit(1);
}

// Policy allowlist: explicit file, else builtin narrow default (verified against R1/R2 graph).
let policy = { allowedGitDeps: ["git+https://github.com/whiskeysockets/libsignal-node.git#bcea72df9ec34d9d9140ab30619cf479c7c144c7"], allowedProtocols: ["https:"], allowGitSsh: false };
const polIdx = process.argv.indexOf("--policy");
if (polIdx > -1 && process.argv[polIdx + 1]) {
  try {
    const incoming = JSON.parse(fs.readFileSync(process.argv[polIdx + 1], "utf8"));
    const safeMerge = Object.create(null);
    for (const k of Object.keys(incoming)) { if (k === "__proto__" || k === "constructor" || k === "prototype") continue; safeMerge[k] = incoming[k]; }
    for (const k of Object.keys(safeMerge)) { policy[k] = safeMerge[k]; }
  }
  catch (e) { console.error("POLICY_VIOLATION: unreadable policy file: " + e.message); process.exit(1); }
}

let lock;
try { lock = JSON.parse(lockBytes.toString("utf8")); }
catch (e) { console.error("POLICY_VIOLATION: malformed lockfile JSON: " + e.message); process.exit(1); }

const errs = [];
let softDangling = 0;
if (lock.lockfileVersion !== 3) { errs.push("SCHEMA: lockfileVersion=" + lock.lockfileVersion + " (require 3)"); }
if (!lock.packages || typeof lock.packages !== "object") { errs.push("SCHEMA: packages{} missing"); }

const REG = /^https:\/\/registry\.npmjs\.org\//;
const GITOK = /^git\+https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git#[0-9a-f]{40}$/;
const packages = lock && lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages)
  ? lock.packages : {};
const root = packages[""] && typeof packages[""] === "object" && !Array.isArray(packages[""])
  ? packages[""] : {};
if (!packages[""] || typeof packages[""] !== "object" || Array.isArray(packages[""])) {
  errs.push("SCHEMA: root packages[''] missing or malformed");
}
const declared = new Set();      // every packages{} key except root
const declaredDirs = new Map();  // dir path -> Set(depName) declared at that node_modules level
const requiredBy = new Map();    // dep name -> true (referenced by any edge)

for (const [path, rawInfo] of Object.entries(packages)) {
  if (!path) continue; // root manifest entry handled below
  if (!rawInfo || typeof rawInfo !== "object" || Array.isArray(rawInfo)) {
    errs.push("SCHEMA: invalid package entry " + path);
    continue;
  }
  const info = rawInfo;
  declared.add(path);
  const name = path.replace(/^node_modules\//, "").replace(/.*\/node_modules\//, "");
  const nmIdx = path.lastIndexOf("node_modules/");
  const dir = nmIdx > -1 ? path.slice(0, nmIdx + "node_modules/".length) : "";
  if (!declaredDirs.has(dir)) declaredDirs.set(dir, new Set());
  declaredDirs.get(dir).add(name);

  const r = info.resolved;
  if (r !== undefined && r !== null && typeof r !== "string") {
    errs.push("SCHEMA: nonstring resolved for " + path);
    continue;
  }
  if (r === undefined || r === null || r === "") {
    // link/workspace/file deps may legitimately lack resolved; anything else fails closed.
    if (!info.link) errs.push("MISSING_RESOLVED:" + path);
    continue;
  }
  if (r.startsWith("git+")) {
    if (r.startsWith("git+ssh:")) { if (!policy.allowGitSsh) { errs.push("GIT_SSH_NOT_ALLOWED:" + path); continue; } }
    if (/%[0-9A-Fa-f]{2}/.test(r)) { errs.push("URL_ALIAS_ENCODING:" + path + " " + r); continue; }
    if (/[?#]/.test(r.split("#")[0])) { errs.push("URL_EXTRA_PARAMS:" + path + " " + r); continue; }
    if (!GITOK.test(r)) { errs.push("GIT_FORMAT:" + path + " " + r); continue; }
    if (/@(develop|main|master|latest|next)$/i.test(r)) { errs.push("GIT_FLOATING_REF:" + path + " " + r); continue; }
    const short = r.split("#")[0] + "#" + r.split("#")[1].slice(0, 8);
    if (!policy.allowedGitDeps.includes(r)) { errs.push("GIT_NOT_ALLOWED:" + path + " " + short); continue; }
  } else {
    let u; try { u = new URL(r); } catch { errs.push("UNPARSEABLE_URL:" + path + " " + r); continue; }
    if (u.username || u.password) { errs.push("CREDENTIALS_IN_URL:" + path); continue; }
    if (!policy.allowedProtocols.includes(u.protocol)) { errs.push("PROTOCOL_NOT_ALLOWED:" + path + " " + u.protocol); continue; }
    if (!REG.test(r) && u.protocol === "https:") { errs.push("NON_REGISTRY:" + path + " " + r); continue; }
    if (u.protocol === "file:" || u.protocol === "link:") { errs.push("LOCAL_TRANSPORT:" + path); continue; }
  }
  // collect transitive requirement edges
  for (const depName of Object.keys(info.dependencies || {})) requiredBy.set(depName, true);
  for (const depName of Object.keys(info.optionalDependencies || {})) requiredBy.set("opt:" + depName, true);
}

// Dangling edges: hierarchical node_modules resolution (DLOCK final fix).
// npm resolves dep X of package at dir D by walking UP from D: D+node_modules/X, then parent dirs.
// R2 false-positive cause: only top-level node_modules/<name> was checked.
const resolveDep = (fromPath, depName) => {
  // try nearest enclosing node_modules dir: for "a/node_modules/b", candidates are
  // "a/node_modules/b/node_modules/<dep>", "a/node_modules/<dep>", "node_modules/<dep>".
  let d = fromPath;
  while (true) {
    const candidate = d + "/node_modules/" + depName;
    if (declared.has(candidate)) return true;
    const cut = d.lastIndexOf("/node_modules/");
    if (cut === -1) return declared.has("node_modules/" + depName);
    d = d.slice(0, cut);
  }
};
for (const [path, info] of Object.entries(packages)) {
  if (!path || !info || typeof info !== "object" || Array.isArray(info)) continue;
  for (const depName of Object.keys(info.dependencies || {})) { if (!resolveDep(path, depName)) errs.push("DANGLING_EDGE:" + depName + " (from " + path + ")"); }
  for (const depName of Object.keys(info.optionalDependencies || {})) { if (!resolveDep(path, depName)) { /* optional edges may dangle only if target fully absent everywhere; still count */ softDangling++; } }
}

// Root-manifest edges MUST resolve too (v5 hardening: previously skipped).
for (const depName of Object.keys(root.dependencies || {})) { if (!resolveDep("", depName)) errs.push("DANGLING_EDGE:" + depName + " (from root manifest)"); }
for (const depName of Object.keys(root.optionalDependencies || {})) { if (!resolveDep("", depName)) softDangling++; }
// link:true entries must declare a real workspace/file target (v5 hardening).
for (const [p2, i2] of Object.entries(packages)) {
  if (i2 && i2.link) {
    const hasFile = typeof i2.resolved === "string" && i2.resolved.startsWith("file:");
    const ws = root.workspaces;
    const wsList = Array.isArray(ws) ? ws : (ws && ws.packages) || [];
    const name2 = p2.replace(/^node_modules\//, "");
    const isWs = wsList.some(w => { const sw = String(w).replace(/^\.\//, "").replace(/\/$/, ""); return p2.includes(sw) || name2 === sw || name2.includes(sw); });
    if (!isWs && !hasFile) errs.push("LINK_WITHOUT_TARGET:" + p2);
  }
}
// Root shape was checked before traversing dependency edges.

// Exact-pinned git dependency count cross-check.
const gitCount = Object.values(packages).filter(i => i && typeof i === "object" && typeof i.resolved === "string" && i.resolved.startsWith("git+")).length;
if (gitCount !== policy.allowedGitDeps.length) {
  errs.push("GIT_COUNT_MISMATCH manifest=" + gitCount + " allowlist=" + policy.allowedGitDeps.length);
}

// Root manifest vs on-disk package.json (drift detection, same bytes the installer would use).
const pkgIdx = process.argv.indexOf("--package-json");
if (pkgIdx > -1 && process.argv[pkgIdx + 1]) {
  try {
    const pkg = JSON.parse(fs.readFileSync(process.argv[pkgIdx + 1], "utf8"));
    const rootDeps = Object.assign({}, root.dependencies, root.devDependencies);
    const diskDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    for (const k of new Set([...Object.keys(rootDeps), ...Object.keys(diskDeps)])) {
      if (rootDeps[k] !== diskDeps[k]) errs.push("LOCK_DRIFT:" + k + " lock=" + rootDeps[k] + " disk=" + diskDeps[k]);
    }
  } catch (e) { errs.push("SCHEMA: unreadable package.json: " + e.message); }
}

if (errs.length) {
  console.error("POLICY_VIOLATION\\n" + errs.join("\\n"));
  if (process.argv.includes("--report-only") && ciEnv) { console.error("POLICY_VIOLATION: --report-only refused in CI environment"); process.exit(1); }
  if (process.argv.includes("--report-only")) { console.error("REPORT-ONLY MODE: violations listed above; exiting 0 (bootstrap phase only, NOT for release)"); process.exit(0); }
  process.exit(1);
}
console.log("POLICY_OK gitdeps=" + gitCount + " packages=" + (declared.size + 1) + " soft_dangling_optional=" + softDangling);
