# Deployment path validation: partial correction, installation blocked

Candidate-only changes in AuthorityService.cs and windows-authority-host.test.cjs.
System ancestors now accept SYSTEM, Administrators or TrustedInstaller ownership and use Windows AccessCheck against a duplicated actual Medium-integrity, non-enabled-administrator Core process token. Configuration now requires CoreProcessId; unavailable/mismatched tokens fail closed. Ancestor DELETE, FILE_DELETE_CHILD, WRITE_DAC and WRITE_OWNER are tested separately. Child-creation permission alone is not treated as replacement permission. Private subtree ownership/allowlist checks remain strict; inherit-only ACEs are ignored for the current object, not for their eventual children. All configured paths must remain within the storage parent subtree. Existing reparse and hash checks remain.

Affected tests: 7/7. Host test includes actual C:\ and C:\ProgramData read-only preflight plus synthetic write-DAC, inherit-only, deny-before-allow, delete-child, delete, write-owner and child-create-only descriptors.
Full regression: 257/258, trusted-plugin execution failed SANDBOX_GRANT_FAILED. No acceptance relaxation. Log: C:/Users/jrxid/AppData/Local/Temp/opencode/damar-path-validation-full.tap.

Rebuilt executable: C:/Users/jrxid/AppData/Local/Temp/opencode/DamarProtectedAuthority-path-validation.exe
SHA256: cdabddb8505b82e8dd1d9797558e636b7e3b8d368c47f28c0c43230888d41114
Inventory: damar-path-validation-build.json in same directory, all 4860 prior manifest paths freshly hashed. Aggregate 1231c965b9a49e109cab6eb0d086fc15711ffe5810813f1c9ba2a25f23387d58. Format explicitly recorded: UTF8 manifest-order path:sha256 joined by LF, no trailing LF. This is not an independently enumerated complete new inventory. Previous verified executable/manifest preserved.

NOT installation-ready. Name-based attribute/ACL/hash checks do not provide handle-bound path-race exclusion. Existing protected subtree does not yet exist, so its actual permissions and service-token/Core-token isolation remain unverified. Cross-process token acquisition by the restricted service identity is also unverified and may fail closed. Synthetic tests do not prove installed isolation. No installer prepared/staged, no SCM/account/storage/ACL/policy mutation. Core ports untouched; no credentials accessed or paid inference. Must finish handle-bound deployment validation and tests, resolve full-suite failure, then pass complete actual deployment preflight before installer staging.
