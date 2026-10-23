# P2 recovery terminal settlement — final implementation packet

The authorized P2 implementation and its P2-05/06/07 refinements are committed and source writing has stopped for a fresh independent review of the **entire BASE..HEAD range**. Actual service.submit/runAdmitted borrowed-generation closure, initially RED at receipt63, now passes through unknown acceptance → committed and unknown acceptance → absent with concurrent service/coordinator close, retry, original generation termination, and actual warm/cold continuation. This is an implementation handoff, not whole-version, event-runtime, instruction-runtime, or release acceptance.

- Sole writer/runtime HOST: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`
- Branch: `codex/recovery-terminal-settlement-20261024`
- Exact BASE: `ca54230bdc11fb3f40a66b300ee53b6c5676793f`
- Exact HEAD: `fc11339411e73c6d7efb5972f70304341b791039`
- Full review range: `ca54230bdc11fb3f40a66b300ee53b6c5676793f..fc11339411e73c6d7efb5972f70304341b791039`
- Original commit retained: `23be7d67fedbb115588c9d59186e6786d2894fec` — `fix(agent): settle original recovery outcomes through Stop`
- Extension commit: `fc11339411e73c6d7efb5972f70304341b791039` — `fix(agent): retain original acceptance through deferred settlement`
- Full range: **41 files, 1764 insertions, 106 deletions**. The extension stages exactly 31 owned files; original18-file commit was not amended.
- Evidence directory: `D:/I-harness-main/.superpowers/sdd/2026-10-24-recovery-terminal-settlement/evidence/task-1/`. Receipt numbers below identify its numbered raw logs. `delivery-commands-index.json` contains all82 log names, SHA256, CWD, commands and numeric exits.

The original model handoff continued in place, retaining its nine partial files, RED/GREEN01–04, all later receipts, failed setup attempts, source snapshots and original commit. No reset/switch/reclone/new worktree, child agent, package install, remote/version/release operation, live provider/account, or MAIN product/Git/runtime write occurred. Controlled loopback HTTP and temporary profiles were used. The independently owned P3 deep-context/reasoning/effect files were not edited.

## Implemented contracts and exact owners

### Original terminal recovery and error classification

`recovery.require()` returns the closed not-applicable/required/blocked result. Only the exact blocked error returned by that original call is exempt from response saving-failure wrapping; it is created after the blocked fact and barrier succeed and retains the real rejected-provider cause. Copied fields or arbitrary aggregate members grant no classification or execution authority. Save failures continue to aggregate the actual original and secondary errors.

`RecoverySettlementFact` derives from the existing event type, explicitly removes state/seq/ignorable and permits blocked/resolved only. Memory, managed persistence and delegated Agent sources use the existing metadata fact group/capture journal. Runtime validation rejects nonterminal states, envelopes, seq/ignorable spoofing, accessors/proxies/classes and extra unsafe data. No schema/event/storage format/new journal was added.

Recovery and its consuming admission closure are per response. Their genuine delegated source is registered synchronously before admission/first await, with no borrowed-primary-source fallback. The helper retains one original resolution capture and at most one already-decided blocked correction, original raw outcomes and real faults. It observes before reconciling issued uncertainty; it never automatically retries absent records or replaces captures. A failed barrier before resolved issuance publishes blocked only. A committed resolved fact followed by failed checkpoint/Stop gets the blocked correction from that original source; uncertain resolution delays the dependent correction. Absence, malformed captures, failed installation and failing barriers remain held truthfully. Successful/empty sources close promptly and all required work is joined.

### Accepted usage and optional derived observation (P2-05)

Accepted usage remains on the existing lifecycle owner and records once even after Stop, acceptance-flush failure or a throwing observer. Budget becomes unavailable/awaiting-projection before further observation/save can fail; failed coordinate reads remove a stale post-response context revision. Finalization preserves the primary acceptance/flush error and aggregates actual secondary completion errors. Acceptance checks cancellation after its awaited flush.

Root's P2-05 correction applies only inside the **optional derived post-response budget snapshot** after actual completed acceptance/usage. Backend-proven absence, like proved not-issued/FACT_CANCELLED, may omit that snapshot. Missing data is not called persisted success, local capacity stays unavailable and the next explicit request prepares again. Unknown/conflict/install failures and unrelated exceptions still propagate through the existing document owner. Required recovery, acceptance and usage never use this exception. Receipt39 is preserved as the deciding contradiction in the original overstrict plan; it is not a required-data waiver.

### Original calls before real batch entry (P2-06)

`unstarted-call-settlement.ts` pre-registers the actual response source before awaits, retaining the completed original batch references. It validates eventSeq against the original session's committed tool/call event, seq, callId and name, rejecting missing or duplicate seqs. On failure before the real executeToolCalls source takes ownership, it captures exactly one known-never-dispatched error result per original call through the existing constructor, with TOOL_ABORTED_BEFORE_DISPATCH. No registry lookup, policy preparation, body/effect execution, model replay, discard or duplicate assistant audit occurs.

The existing result schema has callId/name, not eventSeq. EventSeq is validated and retained internally; results use the existing schema. The model loop already tracks used call IDs across the session, and acceptance records retain precise call seq references. This packet does not invent a result field or an event lookup as acceptance authority.

The handoff callback executes synchronously after executeToolCalls registers its genuine source and before preparation/effect awaits. That batch owner is then exclusive; the pre-entry owner closes promptly, and its close is joined even if execution rejects. Never-issued required results gated behind original uncertain acceptance may finish from their same original captures once the document gate clears. An issued proven-absent result stays held without automatic retryAbsent. Original unknown/install-failed result records retain their handles and errors.

### Captured acceptance and deferred original disposition (P2-07)

`ManagedAction.captureModelExchange` is the capture form of the existing closed assistant + accepted-exchange + optional generation-acceptance group. Ordinary raw accept and captured accept share `modelExchangeGroup` and existing permissions. Agent privately binds the actual action receiver; no generic writer, registry, new journal, JSON observer or replacement action was introduced. Payload is captured once before its first admission await. Stop cannot admit a fresh normal acceptance.

`acceptance-settlement.ts` registers an original source and retains that genuine captured operation. Observe/reconcile addresses only the original handle/key. Known committed/memory-committed cannot get a false step/failed. Known absent/not-issued produces the original unaccepted failure boundary. Unknown/conflict/install failure keeps classification and dependent end boundaries held. WeakSet classification was removed. The deferred continuation joins original never-dispatched results first, then the original failed marker if needed, generation close and step/end + turn/end; it never appends failed after a prematurely closed end. Terminal constructor attempts happen once and any failed captures remain on their existing owners. Later reconciliation can discharge closure only, never dispatch a tool, replay transport or invent calibration.

For memory captures, retained installed outcome is opt-in for this captured acceptance. The installed callback is invoked by the actual stage installation owner, after commit/push and before append observers. If that observer throws, admission still throws the original error while observe reports the genuine memory-committed/nondurable installation. No durable receipt is fabricated and no JSON scan promotes acceptance. Other memory captures retain their prior behavior. Unexpected assertOpen errors are rethrown rather than coerced into an undefined not-issued code.

Receipt71 demonstrated that group lowering inspected an optional generation getter/accepted Proxy before strict validation. `captureFactGroup` now strictly validates exchange-acceptance draft data **before** groupEvents spreads/reads it; receipt72 proves both negative controls invoke zero executable reads while ordinary/captured compatibility remains green.

### Generation prerequisite and cleanup ordering

`AgentGenerationFactory` receives the **same genuine action** plus optional explicit `beforeDrain`. `create.ts` passes a dependency joining the original running operation (whose failure remains with the caller) and its original delegated source closures. `createGenerationLifecycle` forwards this to its registered source's existing pre-drain hook. The real generation source registers synchronously during factory construction; `.open()` does not register a later independent source. Both actual main/child factory assembly sites forward the dependency, as does the genuine test fixture. No monkeypatch, proxy or action identity replacement remains; genuine frozen actions and ownsAction continue to work.

This hook prevents coordinator-driven sibling close from releasing the generation source before deferred acceptance has decided its original generation classification. Invocation cleanup closes preparation, fences ordinary action admission through finish, and then closes the invocation source, which joins delegated settlement before lifecycle drain. A setup failure before invocation-source construction still attempts its actual lifecycle cleanup. Busy lease stays held through this work; P1 setup/receiver/frozen/throwing-factory/error-preservation controls pass. The previous array order changed intentionally from preparation/drain/finish/source to preparation/finish/source/drain; all original primary/secondary errors are retained. The packet qualifies actual shipping factory composition and genuine forwarding fixtures; arbitrary custom factories must honor/forward the provided dependency, and unforwarded custom factories are not claimed qualified.

The actual service's borrowed firstGeneration has an independent ingress owner and does not pass through that factory. Receipt63 proved the real gap. Root authorized only existing `input-preparation.ts` and `literal-input.ts` constructors/close paths. Each passes the same generation beforeDrain dependency waiting for its original close decision. It starts original generation.close synchronously so its required terminal capture exists, then resolves the prerequisite **before awaiting** close/drain. Every setup/catch/success path resolves it, including before a generation exists. Locals track only resources actually constructed; close errors retain primary and secondary identities. Normal action finish fences before required drains. Input preparation close retains original observe/reconcile behavior. No borrowed-authority API or extra execution path was added.

## Causal verification matrix

All runtime commands used owning package CWD, one runtime at a time, Vitest maxWorkers2/minWorkers1. Exact commands/exits are in raw logs and delivery index. Actual Node/local dependency resolution is preserved in receipt35; no reinstall was used. Earlier stable unrelated green packages were not rerun without a relevant change.

| Boundary / required observation | Causal and final evidence |
|---|---|
| Semantic second overflow, tuple/unknown/consumed retry identity | 01 RED;02 GREEN; final78 context-recovery42/42. Actual request adapter counts, one recovery summary, provider cause, persisted blocked/retryConsumed, cold refusal, prior effect once. Adapter tests replace the fetch leaf and are not represented as real network traffic. |
| Required/blocked save and resolved checkpoint Stop/error | 05/13 and final78: real failure identities and aggregate cause retained; required/retry-started/blocked only before resolved issuance, resolved+blocked after committed resolved; accepted output/usage survive; no extra send/effect. |
| Original resolved/blocked unknown/conflict/absent/install failure | 10/27/40 and final78 helper13/13. Real coordinator/backend exact original keys, observe first, no replacement; persistent uncertainty/absence holds; explicit management retryAbsent only where test intentionally calls retained handle; install retry installs once without duplicate append. |
| Closed terminal constructor memory/managed/delegated | 03 RED/04 GREEN; final79 includes memory terminal controls; final80 managed4/4. Captured immutable bytes, held source after Stop, normal metadata canceled, closed/nonterminal/executable invalid data reject. |
| Accepted usage, Stop and optional observation | 06 RED;08/14/40; final78 snapshot22/22 and usage11/11. Plain valid acceptance and actual later observation failure separated from opaque class negative. Primary+secondary identities retained, accepted usage once, unavailable budget, no optimistic revision. |
| Optional derived absence warm/cold | 39 deciding RED;40 and final78 real managed loopback controls. Actual warm explicit-input followup and cold Agent continuation; original acceptance/usage once, no absent-snapshot reissue or prior HTTP/tool replay; unknown/install controls stay held. |
| Original accepted calls interrupted before batch owner | 45 actual loopback RED (Stop and save error);46/49 then final78. Original paired never-dispatched result, original accepted unit closed/unprotected, zero body effects, actual warm/cold request history includes clean pair, original usage once. |
| Multi-call/result uncertainty and batch handoff | Final78 unstarted-call13/13: two original calls; exact original result keys; unknown/absence/install cuts, no replacement; normal handoff and Stop at registered batch entry produce exactly one result, never double or missing. |
| Initial known acceptance absence vs unknown→absence | 51 fixture qualification;52 causal RED (protected legacy fragment); final78 retained captured acceptance controls. Known absent and later absent get failed before end, no forged acceptance, closed unprotected legacy fragment, warm/cold continuation through actual managed owner. Unknown→committed gets accepted exchange and no false failed marker. |
| Original uncertainty + coordinator close, P1 cleanup | 54 causal ordering failure;60 direct coordinator race;62 GREEN and final78 invocation14/14 + managed13/13. Same action/frozen identity, throwing setup, busy/fence, all errors preserved, deferred closure joined before generation-source release. |
| Genuine memory observer installation | 57 constructor4;61 real nondurable Agent observer closure; final78/79. Actual installed callback only, admission throws real observer error, later original closure/later explicit input; no durable receipt claim. |
| Real borrowed service first generation + host/coordinator close | 63 causal RED retained with sources;64 GREEN; final81 context-recovery6/6. UNKNOWN→COMMITTED and UNKNOWN→ABSENT, original accepted-group key/issues once; concurrent service/coordinator close initially held, original retry closes generation exactly once with correct failed/result/end order and error cause; actual reopened warm and separate cold followups contain paired old call, zero prior effects/replay, no protected orphan. |
| Ingress construction and normal completed close | 65 invalid provenance fixture retained;66 GREEN; final81 ingress14/14. Both actual ingress owners, each constructor boundary, assembly/transform failure, stopped and successful already-completed generation; original source cleanup/no deadlock/no skipped errors. Managed-ticket-close1/1 also passes. |
| Strict acceptance constructor executable input | 71 RED getter/proxy reads2/1;72 GREEN96 tests including constructor6/exchange30/attribution60. Final79 whole Session and80 managed constructor qualify final guarded source. |
| Original R5 unaccepted attempts / existing acceptance | Final78 failed-attempt13/13, accepted-exchange13/13, failed-turn-finalization6/6. No audit/discard/replay/permission workaround. |

## Final gates and explicit remaining obligations

| Gate | Exact final or relevant receipt and disposition |
|---|---|
| core-agent whole owner | **78:475 passed /17 failed,492 total, exit1.** All edited owner suites pass: invocation14, recovery42, snapshot22, terminal helper13, pre-entry managed matrix13, usage11, accepted13, failed-attempt13, failed-turn6. |
| core-session whole owner | **79:51 files,566/566, exit0**, after final strict constructor guard and two negatives. |
| session-persistence whole owner | **69:185 passed /1 failed,186 total, exit1**. Constructor final guard checked again by **80:4/4, exit0**. Independent unchanged fork suite was not rerun solely to repeat failure. |
| session-executor affected integration | **81:21/21, exit0**: actual context/service6, ingress14, managed ticket1, including final assertions and final guarded constructor. |
| session-executor generation-actions integration | **70:21 passed /1 failed,22 total, exit1** across context6, generation-actions15 and managed-ticket1. Within generation-actions14 pass/1 fail; separate fork→importSeed obligation below. Final81 reruns affected recovery/close owners, not this unchanged fork failure. |
| core-agent typecheck | **73 exit0** on final product source. |
| core-session typecheck | **74 exit0** on final product source. |
| session-persistence typecheck | **75 exit0** on final product source. |
| session-executor typecheck | **82 exit0** after final fixture typing and result/failed/end/cause assertions. Earlier76 typing failure and77 repair are retained. |
| Diff/stage/source/commit | diff and staged diff checks pass; exact31 extension paths; full41 source raw hashes match source copies and final committed blobs; donor unchanged; tracked worktree clean. |

`delivery-failure-comparison.json` compares exact Agent names against retained P1 baseline: **26→17**, nine resolved, **zero new failures**; final78 names equal67. The 17 observed HOST failures remain abort wording1, legacy Agent compaction2, model policy fixtures4, P3 deep-context5/reasoning3/effect2. Root states these were fixed by separately reviewed P3/P4 packets in MAIN and will run one whole Agent gate after integration. P2 does not import those changes or claim HOST whole Agent green.

Two independent observed obligations remain **unresolved**, with no waiver/baseline equivalence/pass claim:

1. `session-persistence/test/semantic-fork-baseline.test.ts > fork archives only the current summary and typed tail, without consumed proof bodies`: receipt69 still archives `CONSUMED-PROOF-ONLY` in child history (also observed24). P2 does not change fork/seed/history/projection.
2. `session-executor/test/generation-actions.test.ts > promotes the exact raw human input and records command expansion once as a derived observation`: receipt70 fails at `forkSession` → `importSeed`, `committedFactSeqs`, with `Fact admission requires recovery or was cancelled`. Other14 generation-actions controls pass. This is a distinct unresolved integration obligation, not hidden by final recovery/close greens.

## Preserved failed trials and source provenance

The initial report, including the complete original matrix and failed setup explanations, is preserved as `historical-23be-packet-report-with-open-audit.md`. Its opening audit status is historical; this report supersedes it. Original01–44 logs/copies/bindings remain unchanged. Notable failures retained include06 opaque fixture;07 projection-invisible audit fixture corrected08;09 assertion/key timing corrected10;15–18 invalid flush gate corrected to real backend receipt;19 missing execution identity corrected20;25 typed fixture correction26;37/38 custom fetch unsupported before transport, corrected to real loopback39;39 P2-05 contract correction40.

Extension failures remain:45 genuine missing result owner;47 false failed classification + incorrect independent result-absence assumption;48 later-input flush fixture rearmed;51 wrong exchange-vs-legacy-fragment assertion and52 genuine lost disposition;53 TS narrowing repair;54 sibling generation source released before deferred closure;56 old cleanup-order assertion with all errors retained;63 genuine borrowed shipping generation orphan;65 fixture lacked actual actionable human provenance so intended assembly/transform failure was not reached;71 unsafe constructor lowering before strict validation;76 missing PendingInput.admittedSeq corrected by using actual inbox.pending() owner data. No failed log/source was replaced by a green receipt.

Bindings are additive: initial `final-source-binding.json`, `final-sources/`, `commit-source-binding.json`, `full-base-head.diff` bind23be only; `45-audit-source-binding.json`, `52-source-binding.json`, `63-source-binding.json` and their copies retain causal boundary versions; `p207-final-source-binding.json` and `p207-final-sources/` bind67-era tree; `qualified-final-source-binding.json` and copies retain final precommit fixture/guard qualification. Earlier final-fixture typing snapshot is also retained. These are historical bindings, not falsely relabeled as final HEAD.

The decisive final handoff artifacts are:

- `delivery-sources/` — exact raw copies of all41 owned files from the final tested tree.
- `delivery-source-binding.json` — fresh raw SHA256/byte count, checkout/branch/BASE, source copy identity and donor hash before staging.
- `delivery-stage-paths.json` + `delivery-staged-verification.json` — exact31 extension stage candidates match actual staged paths; staged check passed.
- `delivery-commit-source-binding.json` — exact full BASE/HEAD,41 raw SHA256 and Git blob identities, verified against committed HEAD and tested source copies; clean tracked status and sole protected untracked donor.
- `delivery-full-base-head.diff` — complete binary-capable full41-file review range.
- `delivery-commands-index.json` — all82 exact raw command receipts and hashes, including nonzero setup/causal gates.
- `delivery-failure-comparison.json` — original26→final17 Agent names, resolved/new lists, final78=67 check; zero new.

Protected untracked Gateway diagnostic remains `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts`, SHA256 **9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68**. It was never edited, executed or staged. The three separately owned P3 tests remain untouched. There are no active runtime commands or detached producers. HOST branch/worktree are preserved; product source writes stop here for fresh GPT6.1Sol full-range review. Root owns integration, outstanding fork obligations and whole-version qualification.
