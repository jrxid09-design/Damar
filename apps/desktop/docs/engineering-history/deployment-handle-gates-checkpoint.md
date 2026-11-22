# Deployment handle gates: progress, not installation acceptance

Full suite: 258/258, zero skipped, damar-handle-gates-full-01.tap in approved opencode temp directory. Affected host/plugin/worker/admission: 8/8. Previous failed damar-path-validation-full.tap retained.

SANDBOX_GRANT_FAILED reproduced in isolated trusted-plugin test. Fixture used system-owned C:/Program Files/nodejs; ordinary user could not add required sandbox grant, and fallback required ALL APPLICATION PACKAGES which is absent. Existing exact-container RX does not satisfy that fallback. Fixed fixture to copy exact process.execPath bytes into a test-owned runtime directory. Production job-run.py remains unchanged. Sandbox/digest/write-denial/network-denial/revocation assertions unchanged and passed.

AuthorityService now opens and retains deployment/ancestor handles, denies delete sharing, denies file write sharing, rejects opened reparse objects and multiply-linked files, checks final handle paths and queries security descriptors by handle. These are NOT sufficient acceptance evidence: ACL authorization and hash comparisons still use names; handle-bound security descriptor is only checked for non-null owner/DACL. Process creation ticks checked via separate Process handle before token acquisition, leaving PID-reuse TOCTOU. Restricted-service cross-account token acquisition not proved. PinDeployment paths and lifetime/recovery behavior need direct tests; existing host tests compile but do not exercise PinDeployment. Do not install this intermediate executable.

Build: C:/Users/jrxid/AppData/Local/Temp/opencode/DamarProtectedAuthority-handle-gates-01.exe
SHA256 c7afc792c957d795b1e1d7ac2d74fee8f7222a17b1d2705335e3b891e1184864
Source SHA256 f533f3b66a1f78248233301cec5e3d470fb0030e936370a8951a8d5d5cc68fa7

Independent no-reparse metadata enumeration: 12513 files, 7653 outside prior 4860 allowlist, no missing prior files, no reparse entries. Only changed prior-listed contents: AuthorityService.cs and trusted-plugin-execution.test.cjs. Enumeration JSON: damar-handle-gates-enumeration-01.json in approved temp directory. Unlisted contents not read/hashed to avoid credential/session access; this is NOT a completed full content manifest. Runtime/dependency/launcher allowlist and non-source exclusions must be established before reading all unlisted contents. No claim unexpected additions are trusted.

Read-only actual ancestor ACL/token test passed as part of host test. Private ProgramData candidate subtree remains unprovisioned, not preflight-passed. No installer staged or executed. No global Windows security modifications or protected Core/credential operations. Owner identity confirmation not requested.
