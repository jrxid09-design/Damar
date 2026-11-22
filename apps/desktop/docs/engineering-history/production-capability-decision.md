# Production capability decision

## Decision

Do not reload 29785 yet. Smallest viable path is a separately administered local broker, not a second file under the Core user's account. It must own monotonic grant state, conservative reservations, expiry time and actual provider dispatch. Provisioning and authorization are external gates. Existing Core can call it after an approved implementation/reload; current Core has no such broker. No broker was installed and no provider credential was read or transferred.

## Evidence and boundaries

- Installed listener 20127 belongs to node PID 21764, executing 9router-pro/app/custom-server.js. Package metadata: 9router-pro 0.5.109-pro.15. Listener binds 0.0.0.0, so loopback use does not establish that gateway access itself is isolated from the LAN.
- Read-only Windows service name/display-name scan found no named DAMAR/NineRouter/TPM authority service. This is a bounded search, not proof that no external service exists. Prior TPM probes returned no usable capability evidence. No hardware provisioning was attempted.
- Canonical/snapshot OwnerTrust composition stores anchors, vault and audit beside local state. It does not establish an independently protected monotonic counter against same-user restoration. Windows ACLs under the same user and DPAPI alone cannot provide freshness against that user. Administrator/OS rollback is outside what a local service alone can resist.
- Static installed route artifact: app/.next-cli-build/server/app/api/v1/messages/count_tokens/route.js, SHA256 ADAF5C6CAE9613244229E5799B9C68DE35369C332A9C0DAF2BCBC45C8CBF2AE1. Export estimateAnthropicInputTokens sums selected string/object lengths and returns Math.ceil(c/4). POST returns input_tokens from that estimator, without provider tokenization. No endpoint was invoked.
- Core SchemaMinimizer.js:35 similarly labels JSON-length/4 as estimatedTokens. Current usage reader accepts prompt_tokens/input_tokens and completion_tokens/output_tokens after the response. Neither is an authoritative pre-dispatch bound.
- Installed chunk 24.js has static gpt-6-luna capability defaults including contextWindow 272000 and maxOutput 128000; this is NOT proof of the exact deployed cx route, billable tokenizer, hidden prompt overhead, image budget or account limit. Chunk 8499.js contains multiple providers, formats and retry policies. Mere co-location cannot establish which applies to cx; no retry-free end-to-end route is proven.
- Packaged price tables contain gpt-6-luna entries, but no account-specific billing/pricing proof was established. These numbers must not determine an authorized cost ceiling.
- REA tools/CLI were unavailable in this session. Inspection used narrowly scoped static reads of installed JavaScript, not decompilation/runtime tracing or claimed REA Evidence IDs. No credential/config database inspected.

## Classification

| Capability | Classification | Minimal action |
|---|---|---|
| Durable Core reservation before dispatch, stale-version checks, fail-closed unknown usage | Implementable in isolated candidate; implemented and tested | Retain existing implementation |
| Local CAS witness protected from ordinary Core user rollback | Requires provisioning/Owner approval | Dedicated service identity; storage inaccessible to Core user; authenticated fixed-scope API; atomic CAS/reservation; no reset/enrollment by Core |
| Protection from admin, disk snapshot or whole-machine rollback | Unsupported by current demonstrated local architecture | External independently administered authority or verified hardware-backed monotonic service |
| Current count_tokens as authoritative upper bound | Unsupported | Do not wire character estimate into inputTokenBound |
| Exact pre-dispatch model token bound | Requires provider/tokenizer contract not currently established | Provider-enforced all-inclusive input cap, or pinned matching tokenizer plus complete serialization/vision/hidden-overhead specification |
| Monetary cap and no upstream retries | Requires provider/account enforcement evidence | Broker must enforce attempts and spend before transport; verify no gateway retry/fallback |
| Owner window | Requires explicit Owner designation | Exact app, title, PID/start identity/fingerprint and permitted interactions; revalidate existing lease/foreground gates |

## Broker trust, provisioning and recovery

Local broker protects against an unprivileged Core user restoring Core state, not an administrator controlling the broker/OS. Core must not receive an unrestricted durable secret capable of bypassing the broker. A witness-only service is insufficient if the same user can restore dispatch code and replay authorization: bind one-use reservation to request digest/scope and have the broker control dispatch or enforce admission at the gateway. Existing provider credential cannot silently be migrated to a service account; any credential-ownership change needs separate explicit approval and compatibility design.

Broker recovery must never recreate counter zero from a missing database or trust restored Core journals. Missing/older state stays disabled pending independent reconciliation/re-enrollment. All Core retries remain disabled; uncertain reservation consumes one attempt and blocks further dispatch. State durability must be tested across actual service termination/recovery before production acceptance. No current production implementation is claimed.

## Crash tests and limitations

Fresh complete suite: 251/251 passed, C:/Users/jrxid/AppData/Local/Temp/opencode/damar-capability-full.tap.
New child-process tests exit immediately after reservation fsync (before network) and from the transport (after dispatch entry). Restart reads one consumed attempt, unresolved usage and blocked dispatch; no replay. Witness/journal mismatch after acknowledged advance fails closed with simulated independent authority. Prior tests cover corruption, partial receipt, stream cancellation, concurrent requests and old-valid-journal restoration against a test witness.

There is no proposed deployed broker to crash-test. Same-user usage-ledger rollback remains unprotected in isolation; current production native grant/dispatch is disabled. Do not claim rollback-resistant budget recovery, power-loss atomicity, hardware monotonicity or external service durability based on these tests.

## Historical authorization reconciliation

Bounded searches: candidate/canonical Markdown, C:/Workspace/Damar/evidence, canonical .sw-factory and D:/Damar/R9_WORK/evidence Markdown. No original numeric approval artifact recovered. Conversation contains exact model approval and Owner-reported historical 100 completions/512 per request/100000 aggregate/no retries/one window; these do not resolve numeric semantics, price or expiry and are not proof of applied grant. No wider private logs or provider credential storage were inspected.

## Explicit authorization proposal (not approved; not executable)

Owner may approve only after bracketed fields are supplied and enforcement proven:

I authorize only the existing isolated DAMAR session D:/Damar/R9_WORK/r7r3-scratch/damar-owner-reopen-20261118-155022/session on 29785, provider ninerouter, endpoint http://localhost:20127/v1, exact model cx/gpt-6-luna. No aliases, alternative models or fallback.

- Maximum 100 attempted upstream completions, including errors, uncertain outcomes, tool-loop/Pandawa requests and any retries. No automatic retries at Core, gateway or upstream dispatch layer. A transport-uncertain attempt consumes one and blocks until authoritative reconciliation; never replay it.
- Proposed interpretation requiring explicit confirmation: 512 maximum OUTPUT tokens per completion including reasoning tokens if billed/limited as output. Input limit: [Owner-approved numeric input cap per request, all modalities and tools included]. If historical 512 instead meant input plus output, use that stricter combined meaning; do not infer either interpretation.
- Maximum 100000 aggregate input plus output tokens across all attempts. Cached tokens count once as input; reasoning counts once within output. Any separately billed categories must be explicitly defined without omission/double counting. Unknown usage blocks remaining dispatch. Provider contract must support this accounting before approval can execute.
- Maximum cost: [amount and currency], all categories/fees included, based on [authoritative account price schedule/version]. No unlimited-cost interpretation and no guessed pricing.
- Valid only from [UTC start] until [UTC end, no more than implementation's 24-hour maximum], expiring sooner on revocation or completed verification. Resume does not extend expiry; recovery does not inherit authority.
- Computer-Use only [application executable, exact window identity, permitted reads/clicks/typing], under existing per-action permission and foreground/interaction-lease checks. No full-desktop or cross-window authorization. Owner must physically designate/confirm the target where required.
- This does not authorize provisioning a service, transferring credentials or restarting Core. Those require a separate specific approval with impact.

## Smallest safe path

1. Owner chooses/provisions independent freshness/admission infrastructure or accepts that current platform cannot satisfy the stated rollback threat. Do not weaken the threat model implicitly.
2. Obtain provider-enforced input/output/spend and no-retry contract. A certified context-window ceiling could be conservative only if it includes every charged input and fits the aggregate authorization; the static 272000 default exceeds 100000 and is not sufficient evidence anyway.
3. Fill and explicitly approve missing authorization fields. Pin broker/gateway/runtime identity; run isolated crash/rollback tests against the actual mechanism.
4. Only then present restart preflight, request separate approval, reload, verify grant readback and execute one bounded Core inference. Continue to usage, Pandawa and window-scoped Computer-Use only on actual evidence.

No restart, paid request, new permission, credential read/export/migration, canonical modification, commit/push, deployment, release or DAMAR Control work occurred.
