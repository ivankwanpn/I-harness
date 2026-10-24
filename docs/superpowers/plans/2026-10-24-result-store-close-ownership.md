# Result-store close ownership prerequisite

Status: approved bounded repair before F1 fork caller integration. Source preflight: MAIN 03a97a3e; relevant product bodies equal accepted IC-B 4c0ccf41. Authority: integrated delivery and the existing F1/R6 original-owner cleanup obligation. Version 0.1.13-rc.1 and format 12 stay unchanged.

## Observed failure and design

`session-executor/src/lifecycle/result-store.ts` currently removes the last registration/cache entry and sets its release flag before awaiting the original service close. A rejected close cannot be retried by that lease; a new acquire may construct another service while the old owner remains unresolved. Its acquisition catch also loses the configure fault if release rejects.

The actual `context-output/src/service.ts` has a second defect: `closing` remains true after a failed permanent transition, while `transitions` stores a caught promise. A later or overlapping close can therefore resolve without finishing the failed artifact/store close. Fix both owners, not just an outer wrapper/mock.

The existing state machine is sufficient: retain the original store entry through active -> retiring -> successfully retired. Remove each logical registration/count once. The final release closes admission synchronously and retains the original cleanup closure and service. Concurrent release callers join the same attempt and receive its actual outcome. Failed cleanup remains fenced and retryable through that original lease; after success repeated release is a no-op. A fresh acquire must never join a retiring service as an active user or create a replacement until retirement succeeds. It may await an already-running retirement; a failed idle retirement returns an explicit error instead of silently admitting/retrying unrelated work.

Inside ContextOutputService keep the permanent admission fence after the first close attempt, but retain a separate original close flight whose rejection is observable by all waiters. A later explicit close retries unfinished cleanup on the same artifacts/store; clear only the failed flight, not the admission fence. Successful substeps are not repeated unnecessarily. Preserve queued transition ordering and all existing active-job joins. Do not make close call finish/replay new publications or reopen normal operations.

When configure/acquisition and cleanup both fail, preserve both failures and provide the same-owner cleanup retry on the thrown error (an internal closure, never serialized). Do not discard the original configure failure or report admission success. Borrowed contextOutput remains borrowed and its release must not close it. Shared users, reader configuration rules, source/lineage/archive/project/revision checks, result authorization, and deletion semantics remain unchanged. If native writer/handle cleanup itself proves unretryable, report the exact causal failure to root before widening beyond the two owners.

## Task 1: original-owner cleanup implementation and causal controls

Primary product ownership: `packages/session-executor/src/lifecycle/result-store.ts` and `packages/context-output/src/service.ts`. Keep new helpers cohesive and private; no second store/registry, wire API, format, authority, grants or polling. Necessary tests in the two packages only; root owns integration documents. Do not edit assembly.ts or the other instruction-retirement writer's files.

Use the real service, real artifact capture and same native handles with narrow fault injection at an actual cleanup boundary. Preserve RED before production changes. Required controls:

- Last-owner close fails, repeated release retries the same actual owner, no replacement acquire or second registration while unresolved, eventual replacement only after success.
- Overlapping releases/close calls join one pending attempt and all observe the same failure; later explicit retry succeeds. Exact original registration/count is released once.
- Real artifact writer suspension/handle close failure reaches actual ContextOutputService.close; retry finishes the original handles and normal admission stays closed between attempts. A mocked factory returning a permanently successful fake store is insufficient.
- Configure failure plus close failure retains both errors and same-owner retry; successful earlier users/configuration/source behavior remains as before.
- Borrowed owner is never closed; live producer/reader reservations and existing scope-loss/cold-reader checks still pass.

Run affected result-store/read-lifetime and actual result retention controls, context-output close/lifetime controls and complete context-output suite if bounded, then the two package typechecks. Package-CWD Vitest, sequential per checkout, maxWorkers=2/minWorkers=1. Add a true assembly/service close control if necessary to prove the original lease is actually retried by shipping teardown. Do not fix unrelated historical tests opportunistically.

Record immutable raw before/after output, exact source manifests, full BASE..HEAD, all setup/failure receipts and unresolved limits. Fresh full-range review before root integration. Build/copy and final combined consumer validation are root's integration responsibility unless assigned explicitly. This prerequisite does not complete F1, R6 or the full release.
