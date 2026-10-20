# R4A — Process-crash recovery qualification

Approved execution sequence, promoted by root on 2026-10-21 after Desktop Task2 acceptance through ae5fbf63. Fresh independent plan review and scoped re-review addressed all findings before dispatch. This is design readiness, not a claim that the physical controls have run. Root pins the clean acceptance BASE in the task brief. Use subagent-driven-development with one GPT6.1Sol writer and a fresh GPT6.1Sol reviewer; continue after acceptance within the already authorized ContextEngine redesign.

## Goal and scope

Prove what a fresh host can and cannot know after the original ordinary-tool or nested Code Mode tool producer has executed and the process is killed at four storage/publication boundaries. Recover only from the original journal/artifact evidence. Do not recreate a settlement source, replay a body/getter/hook/guest, synthesize successful completion from an orphan artifact, or add a recovery journal.

This is one part of completion-handoff Task A5, not whole A5/A6 acceptance. Body/index/manifest/pin/catalog crash cuts, quota/deletion policy matrices, 100MiB page-I/O, 100-child fan-in, packaged entry coverage and R4B/C/R5/R6 remain separately qualified.

Product0.1.13-rc.1, Session10 and decomposition27/43 remain unchanged. One fresh GPT6.1Sol writer and one fresh GPT6.1Sol reviewer. No recursive agents, live provider/account/profile, new dependency, push, merge, tag or release. Tests use task-owned empty settings and gate-level IH_CONFIG_DIR before import/subprocess startup.

## Current source seams

- Existing physical-crash source reference: `packages/session-executor/test/physical-crash.test.ts` and `test/helpers/crash-generation.mts`. Its tsx CLI and stdout/process.exit cut are not copied as hard-kill proof.
- Shipping producer: `createSessionService` with the original `createOpenAICompatibleClient` pointed at an exact controlled loopback SSE endpoint. Normal mode emits one fixture tool call. Code mode emits actual `code_exec`, whose guest calls that same fixture tool.
- Do not import `test/controlled-model.ts` into a plain Node helper: it imports Vitest hooks at module initialization. Do not substitute an unbranded model callback.
- Original `createJsonlBackend(...).appendOwnedBatch(id, owner, prefix, batch)` is an assignable public capability. Decode `batch.bytes` using the original `decodeFactBatch`, match the exact fixture result call, and preserve the real owner/prefix/key/bytes.
- `session-persistence-jsonl/src/backend/fact-journal.ts` calls `owner.beforeIssue()` directly before the original `FileHandle.write(batch.bytes, written, remaining, position+written)`. Its catch proves absence only if original rollback truncate AND sync succeed; otherwise it returns unknown.
- `session-persistence/src/coordinator/managed-document.ts` installs the already staged suffix only after the original committed receipt. Its install catch returns `FACT_INSTALL_FAILED`, quarantines the owner and does not observe the suffix.
- `core-session/src/managed/view.ts` supplies actual `stage()` and `install()`. `createManagedSessionState` is already publicly exported. Preserve actual module/WeakMap/owner identities.
- `openManagedDocument` uses the existing `loadOwned`/backend repair/prefix owner. The read-only `snapshot` and explicit result reader are different operations and must not perform that repair.
- `repairFencedTail` repairs an outstanding outer tool call, not an absent nested `code/result`. The Code Mode oracle checks exact nested durable presence/absence and original outer recovery; it never demands a new nested completion.

## Fixture files and process contract

Add a focused parent test `packages/session-executor/test/retained-physical-crash.test.ts`, an original-producer helper `test/helpers/crash-retained-result.mts`, and a small child-only fault bootstrap `test/helpers/retained-crash-faults.mts`. Reuse existing public owners. Test helpers may be split further by a real responsibility, not duplicate storage implementations. The package's current tsconfig includes only `src/**/*.ts` and `test/**/*.ts`; add an explicit task-owned typecheck project including these `.mts` helpers and preserve the actual typecheck receipt. Do not claim ordinary package tsc covers them.

Parent launches exactly the child whose handle it retains:

```ts
const child = spawn(process.execPath, [
  "--experimental-test-module-mocks",
  "--import", "tsx",
  helperPath, fixtureRoot, sessionId, endpoint, cut, mode,
], {
  cwd: repositoryRoot,
  windowsHide: true,
  env: { ...process.env, IH_CONFIG_DIR: isolatedConfig },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
```

Use an IPC nonce plus exact session/mode/cut matching, process.send's callback, and a pending operation at the cut. Keep the child alive with its IPC listener; a pending Promise alone does not keep Node alive. Parent waits for the expected structured message, calls only that retained `ChildProcess.kill("SIGKILL")`, and awaits `close` before constructing any new owner. Capture stderr/exit/setup failures. Require a successful kill/close, not a spontaneous normal exit masquerading as a crash. Record the tested OS's actual exit disposition; Windows need not return a literal POSIX SIGKILL signal field. Finally/timeout must clean up only the owned handle and local server. Do not scan process names or unrelated PID trees.

Never call service/coordinator/store close before the crash; it would drain and change the observed cut. This qualifies process crash on the tested OS, not power-loss persistence.

The test-only IPC oracle carries the actual batch key/ref, source mode, cut counters and the original result frame bytes/digest when applicable. It does not become product state or authorize a caller. Product reads receive only their original authorized session and complete ref.

## Task 1 — Establish the actual producer and distinguish setup failures

1. Create the isolated workspace/config and exact loopback endpoint. Reject every unexpected URL/method. In crash cases return the minimal real OpenAI-compatible SSE tool call, then permit a final text response only after a later explicit input is intentionally admitted. The separate no-cut positive setup is explicit: allow exactly one tool-call SSE and one terminal-text continuation SSE within that same initial submit (two requests), prove body/getter/hook/guest once and close it normally. This setup exception must not permit a second request in a crash case before the cut or new explicit input.
2. Use the actual service's ordinary tool path with Code Mode off and actual Code Mode guest path with mode `only`. The Code Mode SSE call is `code_exec` with arguments `{"code":"const value = await tools.fixture_result({}); text(\"guest-fulfilled\");","yield_time_ms":60000}`. Set a bounded cut deadline of20000ms within the existing physical test's30000ms per-case horizon; reject a premature outer running result as a missed cut. Use the original supported yield option, not a changed product timeout. Discover nested cellId/callId/name/parentCallId from the actual durable code/call and code/cell facts; do not guess the generated nested invocation ID. A no-cut setup control must prove this same guest/tool route fulfills once.
3. The fixture tool returns a fixed1MiB JSON body through a getter counted once; its body records one append-only test effect in the same task-owned ledger in every process. Register it honestly as a writing fixture and explicitly configure fixture approval. Count original tool body, getter, name-qualified post-execute hook, target fact issue/receipt and guest fulfillment separately; outer code_exec hooks are separate.
4. Use the shipping automatic result store in producer AND fresh host: no supplied `contextOutput` instance, no fixture-defined authorization predicate. Supply the actual coordinator storageRoot, same existing task workspace and isolated settings path, with no project-binding document. The authentic selected result batch's envelope provides its complete ref. Inspect original operation/manifest/pin records read-only at `contextWorkspaceLocation` to confirm the referenced operation is genuinely committed before announcing a cut. This is a test oracle, not a new scope/grant/capture or runtime store registration. Missing/extra artifact operations are observed through exact operation inventory; do not infer capture counts from child counters alone.
5. For the install cut only, initialize builtins and actual core module first, register the Node native mock, then dynamically import persistence/executor. No early static import may bind the original factory before interception:

```ts
const actualCore = await import("@i-harness/core-session");
mock.module(import.meta.resolve("@i-harness/core-session"), {
  cache: true,
  namedExports: {
    ...actualCore,
    createManagedSessionState(...args) {
      const state = actualCore.createManagedSessionState(...args);
      return wrapOriginalStageOnly(state, faultState);
    },
  },
});
```

`wrapOriginalStageOnly` delegates actual staging and preserves the exact actual view, bindOwner and all other capabilities. Only the selected result's install throws; every other stage/installation remains original. Assert real managed ownership/source identity still passes before enabling the cut.

Node's native module-mock plus tsx combination is source-scoped but not yet executed. Its first actual control is a separate setup/no-cut gate under that exact child launcher: prove factory/stage wrapper interception, shared actual managed view/owner/source brands, real successful stage install, original committed receipt and normal observation BEFORE arming the fault. A loader/import/wrapper failure is fixture setup failure, not a product RED. If this mechanism fails, report the precise failure and smallest test-only alternative to root before altering production owners.

## Task 2 — Execute five physical cases in both producer modes

The four semantic cuts have five physical cases because a backend unknown return can leave either a torn frame or a complete frame:

| Case | Exact cut and original evidence | Fresh expected fact evidence |
| --- | --- | --- |
| Before result issue | Artifact finish truly committed; intercept selected append before calling original backend or beforeIssue | No selected original result frame; original dispatch remains known |
| Partial frame / unknown | Original write writes17bytes and original sync fixes that partial tail; fail write and same-handle rollback truncate; original backend returns unknown | Torn tail, no selected original completed result |
| Complete frame / unknown | Original complete write and sync run; throw controlled sync receipt error and refuse same-handle rollback truncate; original backend returns unknown | Original complete frame exists once despite unknown caller disposition |
| Committed receipt withheld | Original append returns committed after write+sync; wrapper parks before returning it to coordinator | Original complete frame exists once; no local install before crash |
| Local install failure | Original backend receipt returns normally; original staging was real; selected install throws and owner returns FACT_INSTALL_FAILED | Original complete frame exists once although original local view/observer did not publish it |

Prototype injection is child-local. Open a task-owned probe to obtain the genuine FileHandle prototype. Arm the exact original target batch.bytes object only while that selected original append executes. Intercept write only when its buffer identity matches; all other writes call native methods. Track the actual handle after match, and limit sync/truncate faults to that handle. Restore nothing in a running survivor; the child is killed and fresh reader imports are unpatched.

For partial write, actually call native write with17bytes and native sync before throwing. For complete/unknown, identify the original full-frame handle at write, call native sync before the controlled throw, and refuse rollback. Describe this as lost durability evidence after successful native sync, not a real disk sync failure. Assert the original backend returned unknown with the same original key, then send IPC and PARK THE APPEND WRAPPER BEFORE RETURNING THAT OUTCOME TO THE COORDINATOR. Keep that original Promise pending until hard kill and assert zero same-key reconcile calls. Otherwise normal source.close/drainSettled can truncate/install the result before the kill. These two cases prove backend-unknown/caller-disposition-withheld; they do not claim an owner-observed-unknown state. Never replace the backend implementation with a fabricated unknown return.

For local install, keep the selected original stage's install failing until hard kill so a subsequent same-process drain cannot erase the cut. Announce successful cut only after confirming genuine backend committed evidence, the original outcome's `code: "FACT_INSTALL_FAILED"` and zero selected observer publications. `committedFactSeqs` may throw the more generic FACT_RECOVERY_REQUIRED while preserving that original `.outcome`; a generic submit rejection alone does not prove this cut. An observer throw is a different phase and cannot stand in for install failure.

Every case must match exactly one intended original result, preserve the same operation/key, and show body/getter/hook once. At a cut inside a nested tool, guest continuation must remain unfulfilled. Unexpected extra model/tool/guest work fails the control.

## Task 3 — Fresh read, explicit owned recovery, then a new explicit input

After waiting for child close:

1. Capture exact pre-recovery session bytes and artifact metadata/pin state as test evidence. Instantiate entirely new backend/coordinator/service objects with their original automatic result store; no child runtime handles or capture/source reconstruction. Preserve child IPC counters as historical evidence, then install separate fresh-host counters before constructing/reading the new service. Register the same fixture tool using the SAME effect ledger; attach name-qualified fresh hooks through actual `service.onAssembly` before submit. Count fresh assemblies, body/getter/hooks and newly created artifact operations independently. A dead child's frozen counter cannot prove fresh-host zero work.
2. First use `coordinator.snapshot` and actual `service.readResultPage`; do not use `load()` (it repairs), `openManagedDocument`, or the executing `context_output_read` tool for this phase. Verify no session write/upgrade/repair, artifact capture, new pin/grant, assembly, model request, tool/hook/getter or guest work. Read authorization remains original; a known full ref is not permission. Preserve full pre/post session bytes and original operation/manifest/pin contents. Allow original task-owned lock lifecycle and metadata/profile/settings reads; this is not a claim of zero filesystem activity. Add an unrelated-session/full-ref negative control with zero artifact body I/O, distinguishing expected metadata checks.
3. Inspect the real journal prefix: torn case retains only the prior valid prefix; complete unknown/withheld/install cases contain exactly the selected original frame/key/envelope/ref once. Do not classify every unknown return as absence.
4. Explicitly open the new owned document. Only now may original recovery truncate the torn suffix and append its existing conservative recovery/closer facts. Record original header boundary, valid-prefix length and exact frame bytes/key/digest. Assert exact original complete prefix bytes at their original coordinates after repair; inspect appended recovery frames separately. Torn17bytes may disappear. Do not assert whole-file equality or inode identity across the original atomic repair replacement.
5. For missing ordinary result, expect original dispatched-unknown/replay:false recovery, not success inferred from the artifact. For missing nested code result, expect its absence and original outer unknown handling; do not fabricate nested completion. A durable nested result remains exactly once even if outer code_exec completion never reached disk.
6. Verify the genuine committed artifact through original page reading and its independent fixture digest/bytes; the orphan-artifact check is separate from the conversation outcome. No artifact scan may manufacture a result fact. Tests may use the ref already received in the IPC oracle, not reconstruct authority from paths.
7. Repeat close/reopen and preserve original-result counts exactly: missing remains missing, committed remains once. Recovery-result counts remain stable, without a second body/capture or second recovery result. Do not interpret old owner-incarnation receipts as new owner execution permission.
8. Finally admit a new explicit input through the actual service and controlled endpoint. It should be usable where original recovery permits it; the server returns a text response without re-requesting the old tool. Count exactly the new request increment, fresh tool/getter/name-qualified hook counts0 and total effect-ledger entries1. A newly mounted Code Mode may write the original code/cell interrupted marker for a previously open saved cell; record this existing owner behavior separately from guest continuation/nested result and do not forbid every event during intentional assembly creation. Do not resubmit the old consumed admission as a recovery strategy.

Use this result-count oracle, scoped to actual original call identities:

| Producer and physical case | Original selected result before and after owned recovery | Conservative recovery result |
| --- | --- | --- |
| Ordinary before-issue/partial | Original frame0 throughout | One outer tool/result with original unknown/replay:false payload, no fabricated artifact envelope |
| Ordinary complete-unknown/withheld/install | Same original frame/key/ref1 throughout | No replacement unknown for the already completed original call |
| Nested code before-issue/partial | Nested original code/result0 throughout | Outer code_exec unknown once if its completion is absent; no synthetic nested result |
| Nested code complete-unknown/withheld/install | Same nested original frame/key/ref1 throughout | Outer code_exec unknown once if its completion is absent |

Assert semantic event counts and physical selected-frame counts independently, keeping ordinary callId separate from nested cellId/callId and outer parentCallId. A single broad result count could conceal either fabricated success or duplicate nested completion.

Cold-read zero-work means zero increments after the original fixture is quiescent/dead. Original counters before crash are expected and must remain visible. Do not reset the oracle in a way that hides a duplicate effect.

## Verification, review and handback

Tests precede any concrete owner fix. New qualification tests are not automatically RED: when the existing owner already satisfies a cut, describe the result as qualification. If a real defect appears, preserve exact physical evidence and isolate its original owner before proposing the smallest complete repair. No new recovery registry, timeout increase or skipped assertion.

Run sequential stable-source gates: the new physical-crash matrix; existing physical-crash test; relevant retained-result-flow, retained-hook-recovery and retained-hook-stop tests; directly affected original fact journal/managed source tests; affected package type checks. Broaden only for a concrete changed owner/failure. Local test wrapper/code paths are not packaged validation; packaged matrix remains A6 unless deliberately qualified with a fresh copied runtime and explicit maps.

Capture complete tracked+untracked relevant source manifests before/after each gate, exact commands/exits/stdout/stderr, setup failures and mutation/restoration receipts. Build no unrelated renderer/runtime repeatedly. No generic exception swallowing that converts unresolved cleanup into passing results.

Writer self-reviews, locally commits coherent test/necessary original-owner changes, writes a precise delivery and immutable evidence/report, excludes mutable progress from seals and freezes. Fresh reviewer checks spec, code quality, real cut provenance and process/owner cleanup. Root verifies evidence, decides any concrete findings through the same writer/reviewer loop and records acceptance before moving to the remaining A5/A6 work.

## Preflight rulings

2026-10-21 root incorporated the fresh plan review's two P1 and four P2 findings before dispatch. Use original automatic source authority; park genuine unknown below coordinator; instrument both live processes/operation inventory; distinguish original and recovery rows; fix actual Code Mode lineage/yield; qualify native mock setup and explicitly typecheck `.mts`. These are test-design corrections, not unverified production fixes. If these rulings are wrong, the qualification can reject valid behavior or miss a real cut, so retain setup/raw evidence and require the independent task review to check the actual measured seams.
