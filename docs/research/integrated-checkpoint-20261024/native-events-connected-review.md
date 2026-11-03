# Connected N2 task review — BASE through b074656a

Reviewer: independent GPT-6.1 Sol, 2026-10-25.

**Overall task/spec verdict: NeedsFixes / not complete. Quality and integration readiness: NotReadyForIntegration.** The connected native event-owner implementation and its previously reviewed safety corrections have no newly identified unresolved unsafe/lifetime defect in this review. One new P2 finding in the qualification-record generator requires correction. Separately, the actual stage076 consumer failure remains an open integration gate with unproved attribution. Neither a source-only approval nor the substantial passing evidence closes that gate.

This is the final connected review requested for this N2 task checkpoint. It is not a broader whole-version review or release approval.

## Scope, exact candidate and method

HOST: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`, branch `codex/windows-native-events-20261024`.

Full range: `4bb009a50f77c45c0e88d680d1ab9c09ad827c41..b074656a262b28c378f0b18acdbaf99f50c82803`, 25 scoped changed files. Review includes the accumulated Rust event/lifetime changes, C/ABI and controlled-build seams, generated assets/provenance, qualification history/record and generator, and the MSYS acceptance PATH fixture edit. ROOT N2-01 through N2-15 and the existing public protocol/capability/lifetime restrictions remain binding.

The candidate identities independently measured from the review body are:

| Item | SHA256 |
| --- | --- |
| Helper | `300348687570c71e3012545442336f807f8e7f66478d6eaaf1d35e016d70e68d` |
| Normal MSYS template | `334994eec6217a985841b65b3d81553556f406ac6baf7de8893bb123805b8b6d` |
| Experimental qualification record | `0a62f658056ab05ce379583b46c3196716c233c06e661a47b8919a5e8ba1ec49` |
| Original standard069 raw evidence | `6cbfb6605bffd49a53549f47d623c32a51f0cb4fd7abb6c4a3947d542513eb4d` |

I reviewed the connected patch and complete package body using the prior connected/source-fix reviews plus the final deltas and renewed checks of the critical ownership paths. Shipping Rust has no additional source delta from reviewed 3fa59499. All **73 packaged tracked file bodies** match the final freeze's measured worktree hashes. All **30 native manifest source entries** match their packaged source bytes. The manifest binds the measured helper/template/protocol, and the standard069 embedded manifest parses identically to the packaged manifest. The final build-owner manifest's Windows newlines are distinguished from Git-normalized text; this byte difference is not silently treated as a source change or ignored when checking the actual manifest source hashes.

The final evidence inventory has 15,336 entries. I checked its final package/report/patch/freeze and selected decisive raw-result/receipt bindings, and checked the hashes of its four prior manifests. Their prior entries had already been verified during the earlier reviews and are reverified in the recorded116 freeze. I did not redundantly rehash all unchanged historical entries or present a new all15k independent execution audit. Controlled executable identities are taken from the explicit actual-executable bindings and preserved bytes, not the generic HOST-reference field in clone build receipts.

No builds, tests, native runtime, process experiments, product edits, Git mutations or subagents were performed by this reviewer. This report is the only file written for this final review. The protected untracked Gateway diagnostic was not read, hashed, run or touched.

## N2-FR-01 — P2: record derivation accepts an incomplete/replaced standard case set

**Location:** `packages/sandbox-windows-psec/scripts/record-qualification.mjs:36-52`, particularly the partial required-name lists at43-49 and aggregate-only check at52.

The new generator accepts any unique result name whose outcome is pass/unsupported, requires only 17 of the 39 standard pass names, requires the four unsupported names, and then checks aggregate counts. It never verifies that all 43 original standard case identities are present or rejects unknown cases.

For example, remove `psec-job-cancel-timeout` from otherwise valid069 evidence and add `{ name: "replacement-pass", outcome: "pass" }`. Every required-name assertion still passes; names remain unique; totals remain39 pass/four unsupported; helper/source/protocol/environment identity checks are unchanged. The generator consequently writes an `original-standard-control-matrix` record even though a critical original cancellation observation is missing. The same substitution works for unlisted filesystem, isolation, retained-descendant, output-cancellation or network controls. This follows directly from the source; I did not execute the generator or mutate evidence to demonstrate it.

This is a fail-closed derivation gap, not a finding that the currently recorded069 data is fabricated. The actual frozen069 file contains all43 unique original case names with the reported39/0/4 results, and its SHA256 matches the record. Stage079's missing-case refusal does not cover replacing an unlisted mandatory case while preserving the totals.

**Required correction:** validate the exact expected standard-matrix name/outcome map before producing a record. Reject unknown names, reject every missing required name and preserve the deliberate four unsupported outcomes and experimental/incomplete labels. Keep the artifact/source checks, raw-evidence hash, exclusive output creation and historical-record ownership intact. Add a focused negative control that replaces an unlisted critical case with a fresh passing name while keeping totals unchanged; preferably check this invariant for every required case. No generated record should be written for that input. This is a narrow record-owner correction, not permission to change the qualification workload/oracles or public support claims.

## Independent open integration gate — actual stage076 failure

Stage076 invokes the real session-executor execution-runtime, execution-authority and assembly-import tests in HOST with real native work. It records **18 pass / one fail**, exit1. The failing test is:

`binds durable child and nested Code Mode receipts and permits only trusted parent visibility`

Its actual exception is FactRecoveryRequiredError caused by `unsupported-owner` in subagent `retainResult`; the stack reaches the production dispatch and spawn path. I read the raw log and receipt and checked their final-inventory bindings.

This is an actual unresolved consumer result. Unchanged assembly/registry files do not establish baseline behavior, and no causal baseline attribution is present in this review. I do not grade it as an N2 regression, an unrelated persistence defect, a fixture failure or an allowed unsupported route without the missing causal evidence. Root's planned investigation remains necessary. Integration/task completion must stay held until that investigation produces a concrete disposition and any required correction/verification. The four deliberately unsupported PSEC/MSYS standard routes are a separate, already-declared limitation and do not explain this failure.

## Connected native specification and safety assessment

The earlier actionable source findings remain resolved in the final source:

- **IR-01:** reactor-originated automatic EOF publication uses the bounded same-mutex FIFO exchange; the oldest full-queue reply becomes the reactor's current work and EOF appends at the tail. The original event handler processes that item outside the queue lock. There is no blocking consumer publication, unbounded overflow queue or dropped response.
- **IR-02:** settled tree/I/O obligations retire their timer eligibility while original epochs/errors/resources remain available for explicit cleanup retry. Remaining settlement uses the original absolute budgets.
- **QSF-01 / N2-14:** read995 exemption requires an accepted actual CancelSynchronousIo request bound to the original stopped operation, plus explicit abandonment. The gate covers only the non-waiting request/result publication. Late Stop cannot acquire authority from1168 alone; earlier same-operation acceptance survives later1168. Unexpected995 and non995 errors remain errors. Actual operation return, thread-exit/join and resource acknowledgment remain separate.
- **N2-15:** already-cancelled MSYS BridgeDone/native relay-exit transitions advance the original remaining-tree/input cleanup. They do not create a new release requirement, grace epoch, polling loop or fabricated child ROOT. Healthy retain/complete predicates remain intact.

NativeWait keeps callback storage heap-stable, registration tokens distinct from CloseHandle handles, and duplicated waited handles alive until unregister-drain acknowledgment. Callback work is limited to a stable predicate and Inbox wake, with no capacity wait, status delivery, termination or handle close. Failed unregister/close retains original identity for retry; fatal incomplete Running retains its dependent process/Job/wait/worker/policy/PSEC capsule through helper exit.

Exact owned-Job PID snapshots grow with checked bounded storage. Member handles are opened for synchronization/query, checked against the exact Job and creation identity, retained through one-shot native waits, and retired only through acknowledgment. Complete factual zero remains distinct from root, EOF or advisory hints. Total advisory absence is the actual source route here; pinned member exits provide the causal next snapshot. Bounded churn/access/allocation/registration uncertainty remains incomplete rather than a fabricated empty tree. A factual signaled root exit code259 is preserved.

Input/output/control capacities, terminal slots, private Stop priority, condition predicates, output accounting, stop-only synchronous cancellation retries, actual native worker exit before joins and join-all behavior remain connected through the original Running/RunningIo owners. There is no public executor registry or second completion authority. Healthy work has no recurring wrapper timer or retained-work lifetime cap. The source and named idle counters support that scoped conclusion; they are not universal CPU telemetry for every runtime/API.

Launch, security and protocol remain within the closed plan: suspended creation/assignment before resume, inherited handle whitelist/private std detachment, policy/identity rechecks, PSEC refusals, ACL legacy unverified/no-PTY/no-retain-tree restrictions, existing public v1 messages, retained versus root-bound lifetime and no unrestricted fallback relaxation. No ACL direct compatibility rewrite or non-Windows feature is counted toward this task.

## C lifecycle and controlled build seams

The default MSYS bridge retains one joinable lifecycle pthread as the only exact-child kill/reap owner. Control requests record intent and wake that owner; they do not kill/reap a guessed PID or group. The blocked signal set is established before fork/worker creation and carried in lifecycle context. The child restores the original mask and SIGCHLD disposition before exec. Requested-stop blocking reap follows successful exact-child SIGKILL only; healthy queries are causal around sigwait rather than timed WNOHANG polling. Parent-private wake publication/drain uses the same lifecycle lock; publishing storage/descriptors survive joins. Input stop has a separate readiness wake.

Controlled trace/skip-restore/seeded-policy/raw-child macros are checked both in build arguments and C guards, require isolated BridgeOnly trace builds and return before shipping asset/manifest writes. In normal compilation no trace/counterfactual/raw policy branch or extra private observation enters the shipping protocol. The final normal template remains byte-identical334994ee despite the guarded source additions. Pinned LP64 signal and raw-termios declarations/layout checks are consistent with the staged ABI; raw layout/import declarations are themselves guarded.

Final-source110/111/112 mask evidence is now stronger than the earlier invalid fixtures: a nondefault original mask/handler/action mask is queried before fork; actual pre-exec queries match in the positive and fail both obligations under skip-restore. Only the independently demonstrated implicit SIGCHLD self-bit normalization is applied. The real workload executes17 and original owned cleanup completes. Private descriptors close before untrusted exec. Old custom-helper127 and Bash/proc failures remain invalid, rather than being reclassified as proof.

## Assets, record status and fixture correction

Original-owner067 generated the exact default helper/template. Later controlled work used fresh output paths/clones and explicit bindings. Final shipping native113 and smoke114 run on the named source/assets; no post067 Rust changes are hidden in the final append. The native sources in the final package match the manifest, including newly added modules; helper/template hashes and record069's raw embedded manifest agree. Original history is preserved in the new before-native-events history file. No stale artifact hash was manually blessed.

The currently generated record correctly remains `assurance:experimental`, `observationScope:historical-one-host`, `result:incomplete`,39 pass/zero fail/four unsupported. Its raw evidence SHA and observedAt match actual069. Standard qualification's exit2 is not converted into full acceptance. Record family labels cover that standard observation scope; current installed-runtime/policy certification is not claimed. N2-FR-01 concerns the generator's validation contract for future derivations, not those measured bytes.

The only acceptance-test edit removes case-insensitive PATH duplicates and prepends the admitted Git/usr/bin to the fixture environment. It preserves other caller environment entries, workloads and assertions. Production still preserves caller PATH. Recorded096/097 BASE/final bare-versus-absolute and running-module observations identify Rtools versus Git PTY/proc namespaces, including identical cat EXE bytes loading different DLLs. That supplies causal justification for the fixture correction without claiming general cross-runtime compatibility or rewriting product environment behavior. Final advanced suite107 passes all7 original assertions with that admitted-runtime precondition.

ConPTY raw-count failures remain failed. BASE/direct-final byte streams are identical; the bounded VT interpreter handles every actually observed control and rejects unknown/truncated ones, explaining20948 overwrites and producing the same2MiB screen/tail across BASE/direct/public cases. This supports terminal-presentation equivalence for the named100x24 ASCII workload, not byte equality between terminal writes and pipe payload or a general VT emulator claim. The refuted ECH hypothesis remains refuted.

## Evidence coverage and practical limits

The final evidence materially covers the required direct paths: public18/native51/smoke34/MSYS7/integrity11/ACL1/shared exec154, actual candidate MSYS early fallback and cancel-before-new-release repeats, kernel EOF before actual259, late/nested descendants and >63 members, delayed ConPTY delivery, bounded idle counters, callback-drain lifetime, wrong-Job/creation-identity/access-denial controls, registration/allocation/capacity failures and full fatal status-loss containment.

Controlled115 has57 passing tests plus one ignored protocol entry. Its clone identity is distinct from the generic HOST reference executable field. Actual empty-DACL OpenProcess5 is distinguished from injected snapshot/registration/allocation/failure controls. Physical PID reuse, sustained actual OS churn/exhaustion and every combined failure permutation were not forced; bounded source behavior and named causal controls support the stated scope without inventing those observations.

Actual095 closes the status read pipe and injects only termination-wrapper5. At the original five-second fatal bound, process/Job ownership is retained and root/tree/I/O and control-thread exit remain unconfirmed; helper exits1, then the original child signals through process-exit Job containment. This is not resourcesReleased, ROOT or normal EOF success. Earlier callback and close-failure controls preserve original resources until acknowledgment.

Cancellation may abandon output, including when counted discarded bytes are zero. The final early MSYS fallback remains logical root null/error under the inherited two-second grace;071/080 use the actual corrected helper and preserve this classification. New release/EOF/watchdog is not credited as cancellation completion. Unconfirmed queued input IDs retire as unconfirmed at release; they are not fabricated ACKs.

The lost040 aggregate remains an evidence-history defect with explicitly unrecoverable pass detail; only surviving source/log/failure observations are claimed, with later controls providing their own fresh records. Historical054 loose preamble/binary parser limitations remain separate from strict later callers/production decoders. Setup/compiler/fixture failures and invalid premises are preserved. None of those limitations is silently used to make076 green.

## Required follow-up and integration decision

1. Correct N2-FR-01 and obtain focused negative evidence plus same-reviewer review of the record-owner delta. Preserve the exact current candidate/raw/history identities; a generator-only validation correction should not require relabeling historical native runtime evidence.
2. Complete Root's causal disposition of actual076, then verify any necessary correction in its proper owner. Until that evidence exists, no final task or integration approval is given.
3. Re-freeze the final resulting range/record/source identities for the remaining review decision. Keep the four unsupported routes, experimental/historical/incomplete labels and all named evidence limits.

The substantive native event migration has progressed through the required source/lifetime corrections and extensive exact-candidate evidence. That progress does not override the record-owner defect or the unresolved consumer gate. **Do not mark N2/Task6 complete or integrate this checkpoint on this review.**
