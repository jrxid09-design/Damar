# SANDBOX DESIGN DECISION — Wave 6 Repair3 (R3-02/R3-03)

Status: IMPLEMENTED + KERNEL-LEVEL PROVEN on Windows (this machine, Node v24.19.0).
Decision record: W1 — "separate isolated/native sandbox host architecture".

---

## 1. Decision

Untrusted external capabilities execute inside a **Windows AppContainer** with
**zero package capabilities** and **LOW integrity**, launched by a small native
helper (`native/sandbox-host/sandbox-host.exe`, a narrowly-scoped launch
primitive — NOT a Damar authority system). Raw TCP/UDP/DNS egress — including
loopback — is denied by the **Windows kernel (WFP AppContainer enforcement)**,
not by any JS/Node mechanism.

The governed Damar path is unchanged:

```
Manager → Authority → Capability → governed claim
  → claim consume (one-use) → private AppContainer sandbox host
  → bounded JSON result → Verification → Audit
```

`launchSandboxedTool` is **not exported anywhere**. The only public entry point
is `execute({ claimId, args, envMaterial })` on the canonical router claim path
(R3-03).

---

## 2. Why Node `--permission` was insufficient (empirically proven)

On this host (Node v24.19.0, Windows):

| Probe | Attempt | Result |
|---|---|---|
| `node --permission` child + raw TCP to a local listener on `127.0.0.1` | connect | **CONNECTED** (admitted) |
| `--allow-net` / `process.permission.has("net")` | node flags/API | **not supported** (bad option; `has()` returns false) |
| JS-level patch of `require("net")` then child reads via `process.getBuiltinModule("net")` | bypass | **BYPASS_VIA_GETBUILTIN** |

Conclusion: **Node's permission model has no raw-network enforcement**, and any
JS/`require`-interception approach is bypassable (verified). Therefore network
isolation must be kernel/OS-level.

---

## 3. Mechanism selected

**Windows AppContainer (restricted process sandbox).**

- `sandbox-host.exe` creates/derives the AppContainer profile
  `DamarGovExternalSandbox` with **0 capabilities** and launches the child with
  `PROCESS_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` (`0x20009`).
- The AppContainer token is LOW integrity, has no app-container capabilities,
  and therefore the Windows WFP layer **denies outbound network** including
  loopback (no `internetClient`, `internetClientServer`, or
  `privateNetworkClientServer` capability is granted).
- Inside the child, a vm-based sandbox shim (`src/federation/sandboxShim.js`)
  loads the validated tool module **as text** and runs it in a `vm` context:
  - `require()` accepts only `node:` builtins + a curated core allowlist
    (no relative/npm resolution — none is staged in the container).
  - Ambient environment is scrubbed **before** tool code runs (only a
    documented allow-set + explicitly scoped material survive).
  - Result is written as bounded JSON to the write root; the launcher reads it
    back and enforces the 256 KiB output cap.
- Child process timeout (default 30 s) is enforced by the native host
  (`TerminateProcess`), and oversized output fails closed
  (`BOUNDS_EXCEEDED`).

### Why AppContainer on this platform (vs alternatives)

| Option | Verdict |
|---|---|
| Node `--permission` | Proven NOT network-isolating (Section 2). Rejected. |
| WFP firewall rules via `netsh` | Requires admin; rejected (non-admin host). |
| Driver/LSP callout | Requires admin + signed driver packaging. Rejected. |
| Docker container | Not present in repo/environment. Rejected for production. |
| **AppContainer** | Native Windows, non-admin, kernel-enforced, packagable. **SELECTED.** |

---

## 4. Threat model

- **In-scope attacker**: a malicious/compromised external tool module (the
  untrusted code we execute). The tool may be arbitrary JS.
- **Primary objective**: prevent the tool from (a) establishing any network
  egress (incl. loopback/exfil to localhost services), (b) reading/writing data
  outside the sanctioned sandbox roots, (c) spawning subprocesses / worker
  threads, (d) obtaining ambient credentials/secrets from the environment.
- **Trust boundary**: the sandbox is for *external capability* code only. It is
  NOT a boundary around the Damar owner process; Damar's own canonical
  Authority/Capability code is outside the sandbox and governed separately.

---

## 5. Enforced boundaries (verification)

Independent probes (see `tests/wave6/repair/sandboxEnforcement.test.js` and the
evidence bundle `raw-network probe results`) executed inside the AppContainer:

| Boundary | Probe | Result |
|---|---|---|
| Loopback TCP connect `127.0.0.1` | `net.connect` | `DENIED:ETIMEDOUT` |
| `localhost` | `net.connect` | `DENIED:ECONNREFUSED` |
| `::1` | `net.connect` | `DENIED:ECONNREFUSED` |
| LAN address `192.168.1.1` | `net.connect` | `DENIED:EACCES` |
| Public IP `8.8.8.8` | `net.connect` | `DENIED:EACCES` |
| DNS resolution `/` raw socket | `dns.lookup`, `dgram` | `DENIED:ENOTFOUND` / denied |
| Filesystem outside ACL'd roots | `fs.readFile` control file | denied (kernel) in the 
  kernel boundary model; residual documented below |
| Subprocess / worker threads | not granted | denied at kernel/AppContainer layer |
| Ambient env secrets | scrubbed before tool code | not visible to tool |
| Output size | 256 KiB cap | `BOUNDS_EXCEEDED` |
| Execution timeout | host `TerminateProcess` | `MESSAGE_EXPIRED` |
| Replayed claim | one-use consume | `MESH_REPLAY` |

The network denial is **kernel-level** — a tool that imports `node:net` can
still attempt a connection but the connect is rejected by the OS; it cannot
establish egress regardless of what the JS does.

---

## 6. Known limitations (honest disclosure)

1. **Loopback bind is permitted.** An AppContainer process may still *listen*
   on loopback (no listen-targeting capability block for local addresses on
   this build). This is not an egress path by itself, but a tool could bind a
   local socket. Documented residual; acceptable for the R3-02 gate (egress
   denial) and disclosed here.
2. **User-owned filesystem readability.** The AppContainer token carries the
   user SID, so Windows may still grant read access to files the *user* can
   read in the user profile. Non-admin hosts cannot strip the user SID from the
   token (no `SeDebugPrivilege`/`SeTakeOwnershipPrivilege`). We mitigate with:
   - default-deny posture (only ACL'd package + explicitly handed roots are
     staged inside the sandbox environment),
   - request-time admission checks (fs needs must be declared and inside policy),
   - `--deny` ACE support in the host for sensitive control files.
   This remains a **documented residual**; there is NO claim of a hard
   filesystem DMZ for arbitrary user-writable paths on a non-admin host.
3. **Windows-only.** On non-Windows the governed executor fails closed (it
   never downgrades to a non-isolating sandbox).
4. **AppContainer availability is required** (Windows 8.1+/Server 2012 R2+).
   If sandbox-host.exe is missing or the platform is unsupported, external
   execution **fails closed**.
5. **Module surface**: tool modules are single-file, core-only (`node:`
   builtins + curated allowlist). npm dependencies or relative requires are not
   supported inside the sandbox.

---

## 7. Packaging implications

- `sandbox-host.exe` + `host.cs` are shipped under `native/sandbox-host/`
  (x64; build command recorded in the file header). The launcher locates them
  via `src/federation/appContainerSandbox.js` (`HOST_EXE`).
- The AppContainer profile `DamarGovExternalSandbox` is created on first use
  (non-admin-safe; profile is stored under `%LOCALAPPDATA%\Packages\`).
- Per-run staging copies of `node.exe` and the tool artifact are placed under
  `%LOCALAPPDATA%\Packages\DamarGovExternalSandbox\run-<nonce>\` (the package
  folder is traversable by the package SID, which avoids the `C:\`-root
  realpath denial).
- Distribution for non-Windows targets: external capability execution disabled
  (fail-closed); no network isolation claim made off Windows.

---

## 8. How an auditor can independently reproduce isolation

On Windows (non-admin is fine), from repo root:

```
# 1. Compile (if needed)
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /platform:x64 `
  /out:native/sandbox-host/sandbox-host.exe /r:System.dll native/sandbox-host/host.cs

# 2. Run the R3 sandbox enforcement suite (kernel network denial probes)
node --test --require ./tests/helpers/testEnv.js tests/wave6/repair/sandboxEnforcement.test.js
#   expect: 12 pass / 0 fail, including:
#     R3-SBOX-04  raw network access DENIED inside AppContainer (kernel)
#     R3-SBOX-01  ambient env scrubbed
#     R3-SBOX-05  timeout
#     R3-SBOX-06  oversized output -> BOUNDS_EXCEEDED
#     R3-SBOX-08  launchSandboxedTool not exported

# 3. Raw-network reproduction (independent of test framework):
#    start a listener on 127.0.0.1:<port>, then run a tool that attempts
#    net.connect over the governed claim path; assert connect fails.
```

The evidence bundle also stores the raw probe JSON (`probe_results_*.json`) and
the native host source for forensic review.

---

_NOTE: This document is part of Wave 6 Repair3 evidence. It does not claim
self-certification; independent re-certification of the candidate is required._