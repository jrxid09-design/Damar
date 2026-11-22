# Protected Windows authority checkpoint

## Implemented offline

AuthorityService.cs uses Windows ServiceBase.Run/OnStart/OnStop, not Node directly registered with SCM. Named pipe has protected explicit ACL, NETWORK deny, SID allowlist and RunAsClient token verification. Service SID must differ from Core SID; privileged Owner transport SID must differ from Core SID. Ordinary Core clients can only read status. Dedicated Windows Owner identity may advance/revoke; no client-supplied role is trusted. Service invokes private stdin worker which reuses protected-admission.cjs. No reserve/settle/dispatch operation exposed while provider enforcement/credential ownership is unresolved. Environment NODE_OPTIONS/NODE_PATH removed for worker.

Compiled with installed Framework64/v4.0.30319/csc.exe, references System.ServiceProcess.dll/System.Web.Extensions.dll. Output only C:/Users/jrxid/AppData/Local/Temp/opencode/DamarProtectedAuthority.exe. Compilation is not SCM installation or runtime authentication proof. No service, account, ACL, policy or credential migration performed.

## Verification and honest gaps

Fresh complete suite 257/257, C:/Users/jrxid/AppData/Local/Temp/opencode/damar-service-full.tap. Worker subprocess tests verify scope mismatch, missing state, stale revoke, valid revoke and blocked provisioning/dispatch bypass. Existing admission tests exercise concurrency, conservative budget, crash lock, revoked-state persistence and uncertain recovery.

Production host is NOT ready to activate. Installed SCM lifecycle, distinct-account pipe authentication, ACL inheritance/parent-path validation and service-stop behavior under hung worker require privileged isolated provisioning tests. Host presently compiles but does not enforce binary/config hash or storage ACL preflight internally. Worker timeout/output handling and failure-event observability require hardening before production. The service uses serial synchronous worker completion to avoid terminating an uncertain mutation; hung worker can leave stop uncertain. No claim of verified dedicated identity or rollback resistance from compilation.

Threat boundary: protected service storage vs ordinary Core user. Restoring authority's own journal as administrator/whole-machine rollback is not detected. Existing Core file rollback does not rewind separately protected state. Protected enrollment and recovery cannot be exposed to the Core user or reset counters automatically.

## Provider dependency

Exact upstream route enforcement remains unverified. Installed character-count endpoint and static model/pricing defaults are not enforceable contracts. No credential/config database read, paid request, metadata endpoint invocation or service restart occurred. Required provider artifact: version-bound cx/gpt-6-luna route contract defining maximum all-inclusive input, output/reasoning cap, tool/cache accounting, no retries/fallback and account prices/currency/spend admission. Need broker/gateway dispatch ownership that cannot be bypassed without migrating Core credentials implicitly. Until then worker intentionally blocks transport.

## Native failure investigation

Historical VERIFICATION_FAILED stack points to tests/computer-use.test.cjs:126, first act click; this is after a successful helper result, while authority verification requires changed screen region plus foreground/cursor checks. Existing failure output omitted useful checks. Added full result/ground-truth diagnostic only; no acceptance weakening, timing retry or repeated click. Latest suite passes, but exact historical failure cause remains unproven; capture timing/region change is a hypothesis, not a finding of success. Not live model perception acceptance.

## Consolidated activation decision

Do not restart 29785. Follow windows-authority-provisioning.md: review/install a pinned ServiceBase host with dedicated restricted identity and protected ProgramData/binary paths; validate service and pipe ACLs against actual Core token; use a separate administrative Owner identity, not Core's conversational bearer as Windows identity; verify recovery/termination under SCM. Explicitly approve any gateway/credential-ownership change separately. Current compiled host needs the hardening/tests listed above before that install is a production recommendation.

Bounded inference proposal remains unapproved: exact existing session/29785/ninerouter/http://localhost:20127/v1/cx/gpt-6-luna; at most 100 upstream attempts; no automatic retry/fallback; 512-token meaning must be explicitly decided; input cap, aggregate categories within 100000, monetary ceiling/currency, expiry UTC and application window/allowed interactions must be supplied and enforceable. No grant, provisioning, restart or inference approval inferred.

Rollback procedure: disable authority admission, preserve protected journal/locks/reservations, stop through SCM after work reconciliation; do not restore an older database or reset scope counters. Binary rollback must not silently change protocol/state semantics. Missing or uncertain authority remains disabled pending administrator reconciliation. Do not delete crash locks without independent outcome evidence.

## Host hardening continuation

Fresh complete suite 258/258, damar-host-hardening-full.tap; affected host/worker/admission 7/7, damar-host-hardening.tap. Host compilation plus reflection executes bounded-output and hash rejection checks without starting a service. This does NOT test Windows service installation or cross-account ACL enforcement.

Host now checks explicit service/Core/administrative Owner SID separation, pipe name, binary/config hashes, file and parent-path ACL allow entries/ownership, reparse points, and storage/config path agreement. Conservative ACL checks may reject a deployment even where effective Windows access would be safe; do not loosen them without testing actual provisioned token/access. Requires config Storage, NodeSha256, WorkerSha256, EngineConfigSha256, AdmissionSha256. Config/storage only allow trusted service/SYSTEM/administrative access; ordinary Core may not administer them.

IPC has total-frame timeout and requires newline termination. Worker stdout/stderr reads are bounded, malformed/unexpected result fails closed. A durable in-flight marker precedes worker creation and is removed only after a validated completed result. Timeout/uncertain result latches host disabled and retains marker; no forced worker termination or replay. Restart rejects retained marker pending administrator outcome reconciliation. Trace emits only fixed failure codes; installing a durable diagnostic sink remains part of provisioning (no EventLog source silently registered). Tests exercise hash/output primitives, not a simulated privileged production deployment.

These changes supersede prior notes that hash/ACL checks and bounded worker handling were absent. Remaining external gates: actual SCM lifecycle/stop/recovery, distinct-account IPC/access-denial tests, approved service identity/storage provisioning, provider contract and dispatch ownership. Worker reserve/settle/dispatch remain blocked; no production Core bridge is enabled. No provider evidence changed, so the exact route remains unsupported for safe paid activation under current demonstrated contract. No repeated inference probing performed.
