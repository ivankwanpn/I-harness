# Existing-session binding observation: connected owner report

Status: implemented, verified, committed and frozen for root's fresh independent review. This report does not stand in for that review or root integration.

## Immutable source and scope

- Assigned sole product checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`.
- Branch: `codex/existing-binding-observation-20261025`.
- BASE: `d053cbde7eac352dc3b48d1bc9ad537d3e431ff1`.
- HEAD: `fdaba3188235faee9def0ac80e0daf8a80dd87ad`.
- Commit: `feat(persistence): observe existing session bindings under shared ownership`.
- Connected range: BASE..HEAD, four files, 485 insertions and 12 deletions. Three product files and one new test file only.
- Tracked checkout is clean after the commit. The preexisting protected untracked `.task3-evidence/` remains unread, unrun and untouched; it was not staged. No other checkout's product files were edited.

Changed files:

1. `packages/session-persistence/src/coordinator/types.ts`: exact request/observation interfaces and optional coordinator method.
2. `packages/session-persistence/src/index.ts`: public type exports and the actual method under the unchanged F0 capability gate.
3. `packages/session-persistence/src/coordinator/binding-observation.ts`: explicit fork/existing-read discriminant, closed read request capture, and a shared acquisition/callback/retirement engine. Bootstrap exemption checks the fork discriminant before comparing invocation data. Read cleanup diagnostics carry frozen captured `sessionIds`; original fork diagnostics retain `invocation`.
4. `packages/session-persistence/test/existing-binding-observation.test.ts`: 50 actual-owner tests covering E00–E17.

There were no edits to the original 56-test `binding-observation.test.ts`, JSONL product/tests, ownership, mutation, lifecycle, documents, managed documents or journal code. Existing seams cover both scope kinds through the same indexes and original handles. No backend defect requiring scope expansion was found. Product version, Session12, SemanticSeedV1 and persisted formats are unchanged.

## Contract and implementation

`withExistingSessionBindingObservation({sessionIds,signal?}, run)` is reachable through `createSessionCoordinator` when locking is enabled, `readDocumentObserved` exists, and the existing supported Windows/Linux facade condition holds. Unsupported/unlocked facades omit both optional observation capabilities. This was run on Windows only; Linux execution is not claimed.

The read request has no target or invocation. It captures own enumerable data descriptors before any await, rejects proxies/accessors/extra or undefined fields, requires a plain dense 1..64 distinct safe-ID array, and uses the original intrinsic AbortSignal brand/state/listener handling. Neither custom array iteration nor shadowed signal methods/getters execute.

The common owner registers a whole scope before acquiring, sorts real existing-session pins followed by exact derived binding-document leases, records late successful acquisitions before guarding, reads actual backend profiles under short session operations, strictly reads only derived binding keys, and calls the callback outside those lanes. Captured metadata/binding JSON is detached and deeply frozen. Getters guard the scope first and reject unrequested IDs. Managed headers never supply metadata and ordinary `getDocument` is not used.

Local metadata/binding writes, deletion, retirement and close use the original synchronous revocation and whole-lifetime joins. Nested AsyncLocalStorage self-waits fail before pending admission. An existing-read self-bootstrap/resume conflicts without issuing backend birth work or revoking its valid scope. External bootstrap/resume revokes and joins it before actual B2 work. Only a fork scope can retain its exact captured-invocation exception.

Cleanup still retires before disposal awaits, releases document locks then temporary claims, attempts independent original disposers, and retains original debt/handles for coordinator close. It preserves independent persistent adopters. A before-native-action release failure retries the same held handle; a consumed-native unknown remains unresolved rather than accepting a no-op release or replacement owner as proof.

## Setup failures and causal RED/GREEN

All raw outputs are preserved under `task-1/`.

- `00-source-capability.txt`: the new method/types were absent at BASE. That is capability setup evidence.
- `01-original-f0-baseline.txt`: original F0 baseline, 56/56 passing.
- `02-new-capability-setup-gap.txt`: E00 reports `undefined` instead of function before implementation. This is expressly **not** semantic RED.
- `03-first-connected-focused.txt`: first connected implementation, 102/102 passing (46 new + unchanged 56 F0).
- `04-first-typecheck.txt`: test typing setup errors only: optional-method Vitest spy inference, frozen generic header typing, and heterogeneous callback return inference. Corrected by narrowing the actual supported JSONL fixture method, typing the actual header as metadata, and an async operation wrapper. No assertion was weakened and no product behavior was changed to conceal these errors.
- `05-callback-revocation-semantic-red.txt`: real causal E16 failure. A genuine active callback aborts its signal and throws its original Error. The inherited catch normalized the Error to `SessionBindingObservationError('unavailable')` because the scope had become revoked. This violated the new API's original-callback-error contract.
- The bounded fix tracks whether the callback itself is still pending. Existing reads preserve its literal thrown value after revocation; a callback that returns data after revocation still fails the final guard. The original fork path retains its established normalization behavior. Root was notified of this causal finding before the fix; no backend or extra seam was changed.
- `06-callback-green-focused.txt`: 103/103 passing after the E16 fix (47 new + original56).
- Self-review strengthened actual corrupt-header/identity-file controls, cold concurrent temporary-claim cleanup, barrier-finally cleanup, and signal method/accessor coverage. `11-final-focused.txt` passes 106/106 and `12-final-persistence-typecheck.txt` passes. Those changes were test-only after the product fix.

Earlier verification shells used fresh temporary backend/lock roots but did not explicitly override `IH_CONFIG_DIR`. This evidence-isolation setup gap was recorded, and the entire required final command sequence was rerun sequentially with `IH_CONFIG_DIR` set to `D:/I-harness-main/.superpowers/sdd/2026-10-25-existing-binding-observation/task-1/isolated-config`. Logs13–17 supersede earlier runs as final isolated verification. No user profile, provider, production runtime, release, push or host build was used.

## Final isolated verification

Every command below ran after the frozen source commit, sequentially, with the package as its actual CWD. Vitest used `--maxWorkers=2 --minWorkers=1`. Logs include exact source, CWD, command, isolated config path, full raw output and exit.

| Receipt | Actual package CWD suffix | Exact command | Result |
|---|---|---|---|
| `13-isolated-focused.txt` | `packages/session-persistence` | `pnpm exec vitest run test/existing-binding-observation.test.ts test/binding-observation.test.ts --maxWorkers=2 --minWorkers=1` | exit0, 106/106; new50 + original56 |
| `14-isolated-persistence-regressions.txt` | `packages/session-persistence` | `pnpm exec vitest run test/ownership.test.ts test/strict-document.test.ts test/load-gate-coverage.test.ts test/managed-fact-batch.test.ts test/semantic-bootstrap.test.ts --maxWorkers=2 --minWorkers=1` | exit0, 39/39 |
| `15-isolated-persistence-typecheck.txt` | `packages/session-persistence` | `pnpm typecheck` | exit0 |
| `16-isolated-jsonl-regressions.txt` | `packages/session-persistence-jsonl` | `pnpm exec vitest run test/document-observed-read.test.ts test/delete-owned.test.ts test/bootstrap-physical.test.ts test/retained-format-ownership.test.ts --maxWorkers=2 --minWorkers=1` | exit0, 100/100 |
| `17-isolated-jsonl-typecheck.txt` | `packages/session-persistence-jsonl` | `pnpm typecheck` | exit0 |

Total final required tests: 245/245. No unrelated failures or assertion waivers remain. The original JSONL strict-read suite supplies the EACCES/EIO, missing/inaccessible root and post-read tombstone controls without a backend change. No shared managed/journal behavior was edited, so the assigned affected range was sufficient; no additional unrelated suites were repeated except to close the recorded config-isolation gap. `git diff --check BASE HEAD` is clean.

## E00–E17 qualification map

All new tests call the real optional facade and actual JSONL backend. Native wrappers call original `acquireSessionLock`; they only record, position or inject failures around real handles. Temporary-only controls create sessions through the backend; persistent-owner controls create/open/adopt through the coordinator.

| Control | Actual checked behavior |
|---|---|
| E00 | Optional support through actual facade, successful callback, unsupported strict backend and lock-disabled omissions; original F0 capability tests unchanged. |
| E01 | Valid plain request; invalid empty/65/duplicate/unsafe/sparse/extra/symbol/undefined/old target/invocation selectors, request/array proxies, accessors/subclass/custom iterator and fake signal; zero caller traps, native calls, profiles or binding reads on invalid input. Exactly64 actual files give exactly64 session +64 document acquisitions, no target. |
| E02 | Actual current title/parent/workspace/nested model and binding, stale preopened managed header distinct, detached deeply frozen data, unknown-ID rejection, all after-return getter/guard failures; request ID mutation held at real document acquisition cannot redirect capture; one actual profile/strict-read per captured ID and zero ordinary reads. |
| E03 | Actual archive (also with stale managed document), removed session file, corrupt header, rewritten wrong-identity header, and preserved raw injected profile error; callback never enters. |
| E04 | Title and archive mutation revoke synchronously before yielding, backend remains unchanged while callback held, new intersecting observation conflicts, mutation joins, ABA cannot revive old scope, fresh scope captures current metadata. |
| E05 | Strict and ordinary local matching binding writes revoke/join before effects, unrelated-key write progresses, old scope stays revoked after binding ABA; malformed actual binding retains raw SyntaxError. Existing strict backend tests preserve all I/O/root/tombstone failures. |
| E06 | Real owned deletion revokes synchronously; file and absent tombstone remain while callback held; listener runs after actual file removal/tombstone; local and fresh-coordinator subsequent observations classify deleted. |
| E07 | Both ownership release and managed-document close revoke immediately, remain pending while callback held, fence a later adopter, then allow ordinary reopen and fresh observation. |
| E08 | Abort and close at each of four cold native acquisition-return cuts (two actual sessions plus two bindings); no callback entry/late leak. Active close/abort, preaborted shadowed state, signal method/accessor overrides, and original disposal single-flight/result withholding are checked. |
| E09 | Matching updateMeta, strict/ordinary binding put, profile/load/loadOwned/open/format, delete/retire/close, overlapping read/fork callbacks refuse self-wait while current; disjoint nested callback retains outer protection and unrelated-ID/key work progresses. No timeout is treated as success. |
| E10 | Cold read itself owns actual leases; a second coordinator's metadata write, binding write and observation conflict with zero mutation. First remains current; after release the foreign operations succeed. No persistent fixture lock obscures the cause. |
| E11 | Literal existing-empty request uses actual header bytes/digest/prefix. Self bootstrap/resume conflicts without prepare work or file effects; external bootstrap/resume synchronously revokes, waits and returns actual ready B2 receipt; bootstrap-first pending header rejects read immediately. |
| E12 | Original F0 56 tests unchanged and passing, including target-only profile trap, exact invocation bootstrap/join/unknown recovery/resume and capture refusal. Mixed disjoint nested read inside fork still allows only real fork target and retains both protections. |
| E13 | Partial later document acquisition failure releases obtained temporaries, leaves persistent source owner held, preserves sorted real acquisition order and unrelated progress. Failing overlapping cold read releases its own pin without retiring the first active temporary scope; first release then relinquishes cold owner. |
| E14 | Real native document release throws before action. Exact raw failure plus original callback result/frozen captured IDs survive aggregate, no fabricated invocation; dependent persistent source retained. Explicit close retries the same handle and completes. |
| E15 | Real native document release consumes raw handle then throws. Original failure/result/IDs survive; repeated closes retain unresolved debt and dependent original source without extra acquisition or release/no-op. Irrecoverable coordinator is removed from normal afterEach; fixture-only original raw handles are explicitly released in finally. |
| E16 | Literal callback result and original Error identity, final guard rejection after revocation, original Error thrown after active abort, callback-plus-cleanup aggregate, and all independent original disposers attempted. |
| E17 | Genuine managed metadata fact admission commits, event count increases and observation remains current. This explicitly demonstrates that this owner does not freeze the managed view or implement host witnesses. |

Native counters printed in final focused raw output:

- E01 exact64: 128 actual acquisitions,64 existing sessions and64 derived binding reads.
- E08 each abort/close cut1..4: acquired=released=cut, live=0, callbacks=0. Across those eight cases,20 actual acquisitions and20 releases.
- E14: one new native document acquisition on top of the persistent source, two release attempts against that same handle, final held=false. No owner replacement.
- E15: two total native acquisitions (persistent source plus observed binding), one raw release attempt, consumed binding held=false while dependent source held=true; repeated close does not call raw release again or acquire a new lease.
- E16 independent cleanup test asserts two initial disposer attempts despite first failure and three total after exact-handle close retry.

## Frozen evidence and later obligations

`task-1/base-to-head.patch` contains the entire connected range. `task-1/source/` contains exact copied current source plus the unchanged original F0 and strict backend tests; `source-sha256.json` records worktree SHA256 and Git blobs. `commit.txt`, `frozen-source.json`, `frozen-status.txt`, `diff-check.txt` and `evidence-sha256.json` bind the source/evidence handoff. Raw setup failures, semantic RED/GREEN and earlier outputs remain present; none were overwritten by final receipts.

The future host consumer still has to open the actual ManagedDocument outside this callback, establish actual READY through its existing owners, reconcile immutable seed identity with current observed metadata, retain broker/project/host/Stop authority, derive typed full-commitment local visibility and exact inherited anchor/extent visibility through approved pure helpers, and guard actual view/events identity/count before and after async predicate/body/search work. This task implements none of those policies or facts.

Public fork receipt lookup remains its separate original-invocation route before source profile/busy/fence/flush work; this ordinary existing-read callback cannot replace it. No public fork caller, SDK/CLI/Gateway/Desktop rollout, ContextOutput host adapter, C2/instruction-ID, D2/B3 or R6 completion is claimed. Root's separate ContextOutput task and MAIN integration remain outside this committed owner range.
