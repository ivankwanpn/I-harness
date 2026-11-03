# F1-L1 independent connected owner review

Reviewed range: `f2726707915c940efe64d4ebe2e6b0cc8980f72b..16f7c0bab79792db7fc0f47381c4416b990c55e4` (two commits, 35 changed files). Review target: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`, HEAD `16f7c0bab79792db7fc0f47381c4416b990c55e4`.

The review read MAIN's latest specification, including L1-01 through L1-21, its implementation plan, the task report, and the connected product/test changes in passes. Named unchanged owners consulted were B1 boundary/turn selection, the owned-path helper, and F0's original listener-retirement contract. No subagents, suites, scale runs, product edits, Git mutations, or protected task3 evidence access were used. This report is the sole output mutation. The final source manifest was independently checked against all 38 listed files: no SHA256 mismatch. Reported runtime receipts below were inspected; they were not rerun by this review.

## Verdict

**Spec: changes required. Quality: changes required before integration.** The connected implementation substantially implements the intended owner slice, but the terminal-slot write path can bypass an owned-path refusal, initial directory creation can precede containment validation, and transfer registration does not settle an interrupted listener installation. These are owner-safety/lifetime requirements, not public F1-C rollout work. There is also a small closed-codec defect for `via:null` and explicit qualification gaps below.

This is a code review of the owner task, not acceptance of the version, public fork behavior, or a final all-package runtime qualification.

## What is supported by the code and tests

- ContextStore remains the canonical legacy files/maps/main-SQLite owner and the existing workspace mutation owner supplies the shared turn/quota lane. Derived page/distinct state is placed in that main index rather than a second database or external TEMP spill. Private observation lookup validates actual root/page proof, canonical manifest/owner membership, expiry/revocation, current scope, source identity and typed visibility.
- Strict mode is captured at service construction, registration refuses without it, and ordinary strict-mode noncreator reads deny before generic ownership. The real disabled-transfer/enable/read positive preserves the metadata-grant lifecycle. The public entry exports the specified host-only API/types; no SDK/CLI/Desktop public fork rollout is present. The Gateway production diff only forwards optional B2 facts through its existing wrapper, as L1-13 allows.
- B2 facts are captured from its validated request/stage, deeply frozen, and provided after checkBirth on cold adoption. ContextOutput compares invocation/manifest, semantic seed/source-observation, completed selection and streamed turn-domain metadata, then checks anchors against actual groupCount. B2 still owns seed/completion receipts and the semantic payload cache.
- The structural selector reuses B1 selection/turn/visibility metadata, returns local seq/part coordinates, and composes the actual observing document ID in ContextOutput. The real fixture deliberately differs creator from observing document. The nested positive retains original `source:2` and records immediate parent via, then reads through a cleared intermediate owner.
- Full ref metadata and target source identity are streamed into independent commitments. Pages carry bounded address/commitment fields, obey both entry and encoded-byte limits, and support the rightmost one-child directory. Repeated observations remain rows while actual ref grants/funding are distinct. Empty plans/applications are exact records.
- The tracked ledger uses a real pre-funded rewrite inode and hardlink predecessor; semantic owner arrays stay ordinary JSON above64KiB. The current code checks independent alias/link identity, preserves already-landed canonical owners after response loss, restores the exact reserve, and reclaims verified canonical whitespace before reserve whitespace. The final test commit adds an actual managed `beginResult` after the rename cut at measured held capacity.
- Fixed disposition capacity is tuple-derived and charged as actual file payload. Target revoke precedes owner removal, source clear preserves other targets, exact historical expiry permits original acknowledgement after GC without read permission or owner recreation, and fractional expiry survives the real capture/transfer/cold path.
- The real positives use actual coordinator/B2, broker or unmanaged outer F0, real ContextOutput and actual canonical ledgers. They do not substitute constant successful transfer ports. They cover empty managed closure with nonempty legacy and mixed catalog/member-plus-legacy closure, READY, source clear/close, cold source-free reconciliation and read/search. Warm continuation measures L1/host source re-export/new compile separately from existing B2 immutable validation compilation.
- Shared I/O retirement is optional for existing managed consumers; omitting the new callback preserves their previous close behavior. Legacy consumers retain failed original handles with LeaseRetirement and join them before dependent store release. The affected close tests include late acquisition, safe retry and consumed-fd sticky failure. The native quota fixture changes actual caller attribution using AsyncLocalStorage and delegates the original diskBytes promise; original admission/body/blob/pre/post assertions remain, with no wildcard stat-or-lstat acceptance.

## Prioritized actionable findings

### 1. [P1] Do not turn a rejected inactive-slot path into a writable torn slot

**Source:** `packages/context-output/src/legacy/fork-disposition.ts:63-69` (especially lines68-69); `readSlots` lines46-58; actual clear/TTL callers in `store.ts`.

`readSlots` deliberately checks `ownedPath` and returns `unknown` when an inactive slot is a symlink/junction path or has another path-inspection failure. `terminalSlots` treats every unknown as a resumable torn write: it validates the active bytes, then opens `base + '.1'` with `r+` without any owned-path/file-kind validation. With an already funded valid active slot and an inactive symlink to an outside file of the expected capacity, clear/delete/TTL follows the symlink and overwrites the outside file with terminal disposition bytes. Its final readSlots then rejects the symlink again and reports unknown, after the external write has happened. The same issue applies when the base's parent namespace is redirected and both external slots have valid original bytes. This is a static path proof; no new runtime probe was run.

The trigger requires a redirected/corrupt namespace; the normal writer does not create that redirection. Nevertheless, refusal of foreign paths before effects is an explicit owner boundary, and ordinary explicit cleanup must not damage an unrelated file while reporting failure. Keep unsafe path/identity failures fenced rather than merging them with resumable original torn bytes. Validate both slot paths and the opened files before terminal I/O; any supported torn-write recovery must remain bound to the exact independent funded original slot. Add an actual outside-target containment negative alongside the existing torn-slot positive, and assert the outside bytes remain unchanged.

### 2. [P2] Validate the existing namespace before recursive directory creation

**Source:** `packages/context-output/src/legacy/fork-transfer.ts:109`; same pattern in `legacy/fork-disposition.ts:28`.

Publication first executes recursive `mkdir(directory/pages)` and only afterwards calls `ownedPath`. An already-open service whose `legacy-fork-v1` entry is a symlink/junction to an outside directory creates `<outside>/<invocation hash>/pages` before refusing the path. No earlier transfer-path inventory prevents this: getStore may return the already-open store; source observation preparation without a bootstrap does no transfer inventory; the new binding's first publication reaches this mkdir before requireSpace. `fundSlots` similarly creates its parent before validating containment. Thus blocked transfer/setup can still mutate a foreign namespace.

Create new namespace components only after validating their existing parent chain, and validate each newly created component before descending. Preserve the owned-path refusal through failure handling. Add an actual redirected-namespace control with an already-open store; assert no outside directory or file is created. This is distinct from finding1, which can overwrite existing outside file contents during terminal cleanup.

### 3. [P2] Settle listener installation failure before losing the transfer scope

**Source:** `packages/context-output/src/legacy/fork-transfer.ts:49-54`; comparison: accepted `packages/session-persistence/src/coordinator/binding-observation.ts:190-197`.

Registration invokes the captured intrinsic addEventListener before `scopes.set(token,state)`, with no installation catch/cleanup. If that native installation installs the callback then throws, register returns no token and the service has no scope entry to retire. The original signal retains the callback, which retains state.capture and its actual source view/host closures; service.close cannot find it. Using the intrinsic correctly defeats caller-shadowed methods, but does not settle this possible acquisition failure. F0 already explicitly marks possible listener attachment before calling the intrinsic and includes installation in its settled lifetime.

Register/retain cleanup ownership before installation can issue, then remove the original possible listener on installation failure and retain any unresolved removal debt for service cleanup. Test a throw-after-install intrinsic fault, asserting no source/target capability remains retained and close joins any original cleanup. This finding is conditional on the installation failure cut; no new runtime fault injection was performed, and ordinary native-signal success is not claimed to leak.

### 4. [P3] Reject an explicitly null immediate-via record

**Source:** `packages/context-output/src/legacy/fork-codec.ts:90` (the `if (r.via)` validation branch).

The closed row validator permits an optional `via` property, but truthiness controls whether it is validated. Consequently `via:null` passes data/field checks and skips the required immediate-via object validator. No legitimate row writer emits this value, so this is a closed-record validation defect rather than a demonstrated live grant bypass. Check presence/undefined rather than truthiness and add a literal malformed-row negative. The specification explicitly excludes invalid optional fields and does not define null as an omitted via.

## Evidence qualification and remaining gaps

The following are inspected receipts, not fresh executions by the reviewer:

| Evidence | Source and actual result | Review limit |
| --- | --- | --- |
|054|final-1 ContextOutput:241 pass,1 managed-only deletion regression;10001-observation case itself passed|The failure and later repair are preserved; the scale case is earlier-source evidence.|
|062|final-3 ContextOutput fast gate:241 pass,1 intentionally not rerun10001|Excludes the distinct-scale file.|
|063-068|final-3 six affected package typechecks exit0|Later affected ContextOutput/executor refreshes are separate below.|
|069|final-3 full core-session:52 files,569 pass|Core/B2 facts/selector package sources did not change in the later segment; late ContextOutput dependency changes still were not a rerun of this broad gate.|
|070|final-3 full session-persistence:251 pass,1 semantic-fork-baseline failure, exit1|Public raw archive still contains CONSUMED-PROOF-ONLY. This is expressly retained later F1-C debt; no whole-fork GREEN.|
|071|final-3 JSONL/B2/F0:21 files,264 pass|Earlier broad integration evidence, not final-HEAD rerun.|
|072|final-3 Gateway bootstrap/project/scope:3 files,65 pass|Optional forwarding is unchanged, but this is earlier broad integration evidence.|
|073-074|15 original executor/native/close/grant positives plus2 isolated-config setup failures; corrected setup then actual stat/lstat oracle failure|Both failures remain evidence. They are not silently counted as passing.|
|077|final-4 actual native quota observer correction:4 pass|Preserves causal original assertions; later ledger/read changes were followed by affected ContextOutput gates, not a repeated full executor integration gate.|
|078|final-4 real101 and1001 distinct selected/funded refs both pass|1001 owner487.808s; setup85.100s; total case573.118s. Correctness/funding evidence, not latency qualification.|
|079-082|actual alias/reclamation and capability REDs followed by focused positives|Supports the late product corrections, not the new containment/listener findings.|
|083-086|ContextOutput/executor types exit0; final-5 fast ContextOutput248 pass plus1 skipped10001; real101 late-ledger qualification pass|1001 was not repeated after late guards.|
|087-090|actual stale-body-await REDs; affected positives; ContextOutput types exit0; final-6 fast gate32 files/250 pass/1 skipped10001|The final fast command also excludes legacy-fork-scale.test.ts. It is not a final complete-scale/all-package gate.|
|091-092|final-7 test-only actual managed writer after held rename capacity:1 focused pass; ContextOutput test types exit0|Production files match final-6; this does not repeat broad or expensive gates.|

The earlier10001 control measured44.016s,22170 actual file retirements, peak1 pending/live0, and the rightmost missing-leaf refusal. It is not a measurement of all later instructions at HEAD. The source-final-3 to final-7 manifest comparison confirms later changes in codec, transfer, observed read, ledger, service, store, fixtures/tests and native observer files. The segmented qualifications are materially more precise than a single full-range GREEN assertion.

The reported1001 owner time is a real performance concern: roughly10x distinct refs compared with101 costs roughly45x owner time in that run. The funding path repeatedly invokes full physical inventory, alongside repeated metadata/ledger verification. There is no stated L1 latency threshold, so this review does not invent a performance rejection grade or treat successful correctness controls as latency acceptance. Keep R6 work explicit: measure inventory/metadata/SQLite/B2 validation phases and establish a budget before public caller qualification; preserve the one owner/quota and bounded protocol when improving it.

Two qualification/spec details remain unresolved in the current evidence:

- The final warm test demonstrates unchanged-original continuation and passive missing-work refusal. I did not find an explicit causal final-suite control that closes/changes the actual original source witness after a partial page and proves no further original prefix/suffix publication. The guards are present, but the report's broad changed/lost/closed-witness wording should not substitute for that causal evidence.
- The specification says startup loads/validates original roots/dispositions before transfer-related pruning and corrupt roots must fail relevant recovery/prune. `ContextStore.open` currently rebuilds raw canonical manifests, owners and bodies; transfer graph/disposition validation happens later on observation/reconcile. `captureLegacy` can call `prune`, whose expiry path checks whether expiry.0 exists but does not validate the associated transfer roots first. This is an apparent unqualified startup/prune ordering obligation. I have not assigned a separate data-loss finding without a causal control establishing the affected original state; root should resolve it explicitly or require the targeted corrupt-root-before-prune control rather than infer coverage from read-denial tests.

The current tests also do not qualify the external-namespace and interrupted-listener cuts in findings1-3. Existing hardlink alias negatives are specific to owner ledgers and do not validate disposition slots or directory setup. No runtime was requested solely to repeat already reported suites.

## Handoff

Resolve findings1-3 and the closed-codec correction with focused causal tests, then refresh only affected gates and source manifests. Resolve the explicit startup/prune and changed-witness qualification limits at root. Keep the unchanged public semantic-fork baseline RED as F1-C debt, retain all raw failure/setup receipts, and keep performance qualification separate from correctness/funding scale controls. Public service strict-mode construction, real host read/search/fork wrappers, original-witness routing, packaged/version gates and non-Windows filesystem qualification remain outside this owner review.
