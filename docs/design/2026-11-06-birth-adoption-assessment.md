# Session birth/adoption design — assessment (2026-11-06)

> Question: does the session birth/adoption design need a redesign? Judged by product stability, feature completeness and design
> reasonableness (development effort ignored). Evidence comes from the commit-log redesign implemented on
> `experiment/audit-fixes-v0.1.13` and the verification recorded in `2026-11-06-session-commit-log-status.md`.

## 1. What birth/adoption means here

A session is *born* when the host creates it (empty, forked, subagent child, task child) and is *adopted* when a later host reads an
existing store and continues it (restart, CLI, another process). The legacy design spread birth across a staged bootstrap
(header/reservation/seed/completion facts in a journal) and adoption across legacy readers that replay those stages. The question is
whether that split is still the right design.

## 2. What the redesign changed

| Aspect | Legacy | Commit log (implemented) |
|---|---|---|
| Durable point | several staged facts (header, reservation, seed, completion) | **one commit line** (header, seed) in `session.v15.jsonl` |
| Birth failures | partial stages need reconciliation, reservation ownership, rewrite of the header | a torn tail is dropped; a complete line is the session |
| Adoption | readers interpret the staged layout, with route-specific compatibility code | fold the commit prefix into a session view; one scanner, one fold |
| Fork/child | `createSelectedRuntimeCapture` + observations + reservations | seed commit from a captured v3 seed (fork/child) plus `createChildSession` |
| Concurrency | journal lock + staged ownership | `flock` writer lease, append-only commits, sha256 `prev` chain |
| Delete | staged deletion + tombstone | atomic directory rename after a deletion receipt commit |

Verified properties: crash/cut tests (torn line dropped, corrupt tail rejected), fold property tests against a reference fold, scan cache
bounded reads, multiprocess lease tests, restart durability (session, metadata, schedule, batch move), fork/rewind lifecycle on turn and
rewind edges, compaction, CLI. 206 SCL/SDK tests green (host 45, store 38, commit 43, CLI 6, SDK 74), repo typecheck green,
reachability gate PASS.

## 3. Is the redesign justified?

Yes, on all three axes:

- **Stability**: birth no longer has a multi-stage failure surface. There is no "header written but seed missing" state to reconcile:
  either the seed commit exists (session adopted) or it does not (session absent). Fork/rewind/delete were the riskiest adoption paths and
  now have explicit, tested lifecycle rules (fenced exclusive operations, detached read-only witness, task-document seeding, tolerant
  capture settlement).
- **Feature completeness**: every product surface previously exercised on the legacy store now has an SCL host test, including the fork
  children running turns, schedules, todos, rewinds and nested forks. Selected-results inheritance now works end to end as well: the v2
  fork captures a v3 seed, the child is created from it, and inherited pages are read through the source (bounded parent-chain walk,
  scoped to the seed pages). Nested selected forks work too: a selected child's own seed pages supply the inherited metadata the v3 exporter validates
  against. The only remaining semantic gap is the legacy held-observation lineage/revocation witness, which is an implementation layer,
  not a structural property of birth/adoption.
- **Design reasonableness**: the new model has one invariant (append-only commits, one fold) instead of route-specific staged readers.
  The format, scanner and fold are pure and independently testable; the coordinator and facade are the only impure layers. That is a
  simpler design with fewer hidden states.

## 4. What a redesign would still need

1. **Selected source port** (the last functional gap): the legacy `createDocuments(...).observations` layer supplies held inherited
   metadata and an owning result store. The commit log needs an equivalent so a forked child can read its inherited result pages. Four
   shortcuts were tried and reverted (seed-ref fallback, ref hydration, live child, observation); they confirm the layer is the missing
   piece, not the store.
2. **Default switch and legacy deletion**: safe only after (1). The ADR decision (opt-in until then) stands.
3. **Old-format corpus**: formats 6–12 need recorded samples with valid `journal` metadata to extend the dual-run corpus. This is a
   verification gap, not a design issue.

## 5. Recommendation

Keep the redesign and finish it incrementally: port the selected source, extend the corpus, then switch the default and delete the legacy
coordinator. The redesign is not a rewrite for its own sake — it removes the staged-birth failure surface that the audit kept tripping
over, and the remaining gap is bounded and documented.