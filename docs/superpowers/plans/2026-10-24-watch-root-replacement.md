# Preserve selected watch coverage across directory replacement

> Corrective W1 task within the integrated delivery plan. The IB adapter exposed this real shared-owner defect; it must not add its own backend or routing scanner. Root authorizes one isolated GPT6Astra writer and independent scoped review. No recursive agents.

**Goal:** An exact selected file/directory remains observable when its containing directory is moved/deleted and recreated, including initially missing ignored ancestors and a retargeted junction. The real instruction consumer must reconcile to the new rules without a successful-state polling loop.

**Evidence:** In the IB worktree, `packages/instructions/test/observation-windows.test.ts` first real Windows case selects `.i-harness/rules` plus its exact AGENTS/CLAUDE/.git candidates. Initial write, preferred-file creation and atomic file replacement notify correctly. Renaming `rules` to sibling `retired`, recreating `rules` and writing new AGENTS produces no W1 event and the source remains ready with stale text through its15second watchdog. Two runs recorded the same behavior; retain those failed receipts. IB evidence is under the instruction-observation SDD `evidence/task-1/07-*` files.

**Architecture:** `fs-watch/src/stream.ts` remains the one maintained native owner; `leases.ts` remains the only shared retry/drain/reset owner. Fix actual backend coverage and selection routing there. Exact public selection identity/epoch contracts do not change. IA/W1 previous acceptance remains scoped historical evidence; this newly demonstrated replacement gap must close before IB acceptance.

**Root refinement after measured RED:** Chokidar routing from a drive ancestor performs `alwaysStat` before ignored filtering, creating a measured4.3second startup regression, and ancestor coverage alone still loses rapid same-name replacement. Do not monkey-patch private `_readdirp`. Keep Chokidar on the original selections and use bounded public `node:fs.watch` handles for precomputed strict routing directories, owned and closed by this same stream lifetime. Shallow anchor events only invalidate topology through existing `FS_WATCH_GAP` and the existing lease recovery/reset. They do not enumerate sibling trees, create another service/retry owner, or grant read/execution scope. All low-level handles join the same close/generation barrier. Root authorizes this lower-level handle refinement because the measured maintained-backend alternatives are insufficient; exact real controls remain mandatory.

## Task 1: Stable bounded routing coverage in the existing watcher

**Files:** `packages/fs-watch/src/stream.ts`; a private `routing.ts` if useful to keep traversal/filtering separate; focused `packages/fs-watch/test/root-replacement.test.ts` and existing relevant stream/lease tests only. `types.ts` may expose no new public authority; existing `FS_WATCH_CAPACITY/BACKEND/GAP` errors suffice. No instructions/settings or unrelated current-context product edits.

- [ ] Reproduce the exact failure at BASE using actual `createFsWatchService`, callbacks subscribed before ready, synthetic temp roots and controlled rename/recreate. Retain raw notifications/source identity. A package-level test must prove the W1 failure directly, not merely a final IA timeout; no further repeated broad diagnostic is needed.
- [ ] Determine actual maintained-backend behavior for root/ancestor deletion and recreate. `ignored` currently permits routing ancestors, but `watch(opts.roots)` does not explicitly establish durable routing coverage. Correct the concrete coverage gap; do not just turn a later timeout into permanent unavailable or ask users to restart.
- [ ] Construct a bounded internal routing plan from normalized supplied roots, never from arbitrary event paths. Include the necessary ancestors/anchors so removal/recreation of a selected directory or missing ancestor is visible. Retain original roots for baseline/result scope, selection sharing and consumer identity. Bound per-root ancestry to128levels and total unique internal routing nodes to4096; excess returns typed capacity failure without silent truncation. Deduplicate shared ancestors and use Windows path equivalence correctly.
- [ ] Do not recursively watch unrelated ancestor subtrees. The backend ignore/traversal predicate must permit only supplied-root coverage and the exact routes needed to reach it; unrelated siblings stay pruned. Existing default/user ignore rules still govern selected descendants; explicit selected candidates/markers and their route override ignore segments only for their precise route. An explicit `.git` marker must remain observable without broadly enabling every `.git` tree.
- [ ] Implement the refinement above through public APIs only. For an existing strict routing directory, observe relevant precomputed immediate route children without an ancestor readdir baseline. Missing route creation or matching/ambiguous topology signals enter existing gap recovery and rebuild the plan from the original normalized selection. Native error/close callbacks must be attached before readiness; late retired callbacks cannot revive a stream. Measure low-level handle counts and startup against the original selection; no private library traversal hooks or inflated readiness timeout substitutes.
- [ ] Native directory/junction topology changes affecting a selected root must yield a relevant bounded invalidation/change/reset through existing W1 semantics, then actual future changes beneath the recreated selection continue to arrive. It is insufficient to report one removal then permanently lose the recreated tree. Never treat event path as new read/execution authority.
- [ ] Preserve original `add/change/unlink` ordering and no-loss error/overflow behavior. If reconnect is genuinely necessary, use the existing single lease error/recovery owner, with a reset barrier and original close joining; do not add a healthy rescan interval, second retry timer, native watcher registry or per-consumer backend.
- [ ] Initial readiness covers the required routing anchors and original selection; startup/baseline is still best effort and consumers still reconcile after ready/reset. New anchor startup records must not masquerade as selected file contents or authorize new scopes. Early close, failed close and reentrant reset retain current generation fences and no backend overlap.
- [ ] Require actual Windows controls for ignored-parent selected-directory move/recreate, delete/recreate, initially missing multi-level route appearing later, selected exact file replaced with its parent, junction retarget, and unrelated sibling changes. Observe candidate content through event-driven resnapshot and one-shot watchdogs; no delay-based assertions, stat polling, or assuming exactly one native event per write.
- [ ] Include a held/injected backend control proving routing selection/filter bounds and late old-generation callbacks, plus real replacement followed by another ordinary write to prove persistent resumed coverage. Explain injected versus real backend evidence; do not claim untested Linux/macOS behavior.
- [ ] Run fs-watch full suite/typecheck after source stabilizes. Reuse unchanged settings36qualification; no settings product change. Commit the scoped repair and report full BASE..HEAD/source/commands/raw results/limits. Root applies only reviewed repair to IB checkout, whose writer then reruns the concrete previously failing real consumer and final owned suite once.

```text
pnpm --filter @i-harness/fs-watch exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/fs-watch typecheck
git diff --check
```

## Root preflight rulings

| Interface pair | Decision |
|---|---|
| W1 backend / IB adapter | Routing anchors stay in W1. IB's four public selections and1024root bound remain unchanged; internal physical coverage is an implementation concern, not additional authorization. |
| Backend / lease service | Existing lease owns restart/reset. A maintained backend fix should preserve public service; no second drain or success polling. |
| Selection / defaults | Exact route traversal differs from broad ancestor subtree watch. Test ignored ancestors and unrelated siblings with actual backend. |
| Earlier acceptance / new evidence | The newly demonstrated real gap reopens only this coverage obligation; do not rerun every old unrelated gate or represent prior evidence as full directory-replacement proof. |
| Current-context / repair checkout | IC-A is accepted before checkout reuse. Preserve its original branch/immutable diagnostic; watcher writer does not alter its files or evidence. |

Cost of the routing-bound decision: sufficiently large/deep selections may now be explicitly unavailable rather than claiming coverage. Ordinary same-scope shared consumers must still work; no hidden eviction of accepted work. The integration consumer must actually recover after replacement before this defect is called fixed.
