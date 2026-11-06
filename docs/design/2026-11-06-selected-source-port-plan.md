# Selected source port to the commit log — plan and recommendation (2026-11-06)

> Context: the only legacy subsystem the commit log does not have an equivalent for is the **selected source** layer that powers
> selected-results inheritance with held observations. Item 4 of the current goal asked to port it. This document records the exact
> interface inventory, an incremental plan, and the measured reason not to start it yet.

## 1. What the legacy selected source is

`selectedSources` (a WeakMap in `session-persistence/src/coordinator-factory.ts`) stores, per composed coordinator:

```
acquire(request: { sessionIds: string[] })   // -> binding { observation, release(), revoke() }
cleanupForError(error)                      // -> retryable cleanup handle
retainTask(owner, view, onRevoke)           // -> witness
retainManagedTask(owner, document, onRevoke)// -> witness
```

and `selectedComposers` stores the cold-finalization/capture protocol used by `createSelectedRuntimeCapture`
(`beginCold`, `assertCapability`, `captureSelected`, `prepare`, `targets`, `coldRoute`, `useCold`, ...).

`desktop-gateway/src/context-runtime.ts` consumes it in `acquireSelectedSource`:
`retain(document, onRevoke)` -> `acquire({sessionIds})` -> `observations.retainSelected(...)` -> `bridge.acquireSelectedMetadata(...)`,
plus `projects.retainSelectedBindingRead` for the project scope.

## 2. What the commit log already provides

- `coordinator.retainExistingSessionBindingObservation` / `withExistingSessionBindingObservation` — binding observations over the
  commit-log coordinator (used by fork preparation and process reads);
- `retainManagedTaskSourceRead` / `retainTaskSourceRead` — task-source witnesses;
- `openReadOnlyManagedDocument` — detached document with a session view (fork witness);
- the v3 seed path: `captureSelectedResultsSeed` builds a v3 seed from `coordinator.load`, and `createChildSession` publishes it;
- inherited page reads through the parent chain (`createConversationResultReader`).

## 3. What is actually missing

1. the held-observation `scope` machinery of `coordinator/binding-observation.ts` (`createScope`, revocation, ALS guards,
   `cleanupForError` debt tracking) applied to selected reads;
2. `documents.observations.retainSelected` + `context-output` metadata bridge (`acquireSelectedMetadata`,
   `selectedMetadataCleanupFor`) — the part that turns a binding into `HeldInheritedResultMetadata`/`HeldResultPages`;
3. the cold finalization protocol (`createColdFinalizationFactory`, reservations, `SelectedResultsRoute`) used by
   `createSelectedRuntimeCapture`;
4. wiring into `selectedSources`/`selectedComposers` so `hasSelectedSource(commitCoordinator)` is true.

## 4. Incremental plan (each step testable)

1. `registerSelectedSource(coordinator, owner)` export + an SCL owner whose `retain(document, onRevoke)` is a document-currency witness
   over `openManagedDocument`/`openReadOnlyManagedDocument`. Test: witness revoke/close ordering.
2. `acquire({sessionIds})` over `retainExistingSessionBindingObservation` returning `{observation, revoke, release}`. Test: metadata and
   binding currentness, revocation on close.
3. `retainSelected` equivalent: a held selected observation over the v3 seed pages (reuse `semanticSeedResultRefs` +
   `seed-refs` iterators). Test: page iteration + currency.
4. `acquireSelectedMetadata` bridge: map the SCL observation to `HeldInheritedResultMetadata` for `exportSelectedResultsConversationSeed`.
   Test: re-export a child's seed from the held metadata (this is the nested-fork enabler).
5. `cleanupForError` debt: aggregate the release/revoke failures into a retryable handle. Test: failed close then retry.
6. Cold finalization: reservations over `beginIntent`/`endIntent` (the commit log already records child-birth intents). Test: crash-cut
   between intent and child commit.
7. Wire `selectedSources`/`selectedComposers` in `commit/facade.ts`; `hasSelectedSource` returns true for commit-log coordinators.
8. Switch context-runtime's selected path to prefer the SCL owner; keep the legacy owner for the jsonl coordinator.

## 5. Recommendation (measured, 2026-11-06)

**Do not port now.** The full two-store comparison (Plan 196) shows the default-switch delta is **zero** after three legacy-layout tests were
made store-agnostic (Plan 198); selected-results inheritance already works end to end through the v3 seed and the parent-chain read-through
(Plan 179/186/187). A port would put the most intricate legacy code (scope/revocation/cold finalization) at risk for semantics the product
path no longer depends on.

The one feature that would still benefit is **nested selected forks** (fork of a selected child), which is refused by the v3 export's
projection (`unsupported-history`, Plan 182/183). The cheaper fix for that is teaching `projectSelectedResults` to accept a seeded history
(step 4 is a prerequisite anyway) — not the whole port.

If a future requirement needs strict lineage/revocation witnesses for inherited pages, steps 1–6 are the path, in that order, each with its
own tests.
