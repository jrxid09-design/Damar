# Scoped model grant engineering checkpoint

Candidate source/test manifest SHA-256: 67310e9884eab7b4cde2b662bd2b9817f3e641724f9aaa3c232e0428d1fd289b
Manifest: C:/Users/jrxid/AppData/Local/Temp/opencode/damar-grants-build.json
Scope of digest: sorted src/tests .cjs/.js/.py files, not executable dependencies or launchers.

Implemented candidate-only Core journal, HMAC integrity using existing Core Owner authority (not provider credential), scope binding to real candidate/session paths and port; exact ninerouter/gateway/cx/gpt-6-luna tuple; Owner-only grant/readback/revoke routes; required explicit numeric limits and approval reference; expiry at most 24 hours; fsync audit; version-checked serialized mutation; dynamic selection and dispatch gates; CLI authoritative authorizedModels readback; alternative-model fallback disabled. Global constant unchanged. Grant revision changes invalidate previously selected native-model execution. Resume preserves journal, not executable selection.

Evidence:
- Full fresh regression: 242/242 passed, damar-grants-full.tap under the temp directory above.
- Real scratch Core lifecycle: port 29993, directory D:/Damar/R9_WORK/r7r3-scratch/model-grants-1794993227790. Official stop/resume, grant persistence, requester denial, revocation, selection reset. Zero provider requests. See damar-grants-core-lifecycle.log.
- Offline tests: exact tuple mismatch, alias refusal, cross-directory/candidate/port/Owner-authority copy rejection, corrupt/truncated journal, expiry, revoked/regranted selection, concurrent route requests, stale metadata completion.

Read-only lifecycle preflight on active 29785: same configuration db4116e4-daec-47dd-b8e5-98b90feb19ac:1, READY, zero outstanding turns/permissions/Pandawa/jobs, hasKey/keyRemembered true, model null, executable false. Listening PID 10480; protected 29623 PID 3192. Neither mutated/restarted.

Restart impact, conditional only: controlled lifecycle restart briefly disconnects CLI requests/streams and changes runtime/configuration incarnation. Same directory, port, Owner authority, provider key-store/settings/registry paths must remain. Provider selection must be explicitly reapplied after readback. No key migration or re-entry. Recheck outstanding work immediately before any authorized restart. Do not use fresh-session creation or recovery as interchangeable with resume: recovery rotates authority and must not inherit grant.

Remaining gates before recommending active reload:
- Exact historical live inference request/token/spend authorization and Computer-Use window evidence not recovered. Code budget defaults are not authorization. No grant applied to active Core and no paid request issued.
- Journal HMAC detects corruption and cross-scope copying, but does not independently detect restoration of an older valid journal by a local actor with write access. Anti-rollback persistence/security review still required before treating revocation as protected against local storage rollback.
- Existing usage ledger writes completion after response; crash-safe reservation accounting and strict pre-request total-token enforcement need review. Current aggregate total is a metered stop threshold, not a provable no-overspend bound.
- Native UI interaction for new authorization-aware state and full executable/dependency identity have not been verified at this checkpoint. Prior Card 6 native evidence is historical, not new live acceptance.

This is an implementation checkpoint, not a claim that all security acceptance gates are closed. No active lifecycle reload is authorized or recommended yet. No inference/Pandawa/Computer-Use live acceptance.
