# S1 library driver Tasks 1–2 implementation report

Status: implementation packet committed and frozen for fresh independent GPT-6.1 Sol review. This report qualifies only the opt-in library driver and its factory tests. Task 3, full S1/Task 6 and release acceptance remain outstanding.

## Git and source binding

- Sole writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.
- Branch: `codex/schedule-deadline-driver-20261024`.
- BASE: `8493641c0d3a196e88f070e0d54885d65e7fb06b`.
- HEAD: `c86df70b0a2e00e444426075354875212065c4da`.
- Full review range: `8493641c0d3a196e88f070e0d54885d65e7fb06b..c86df70b0a2e00e444426075354875212065c4da`.
- Commit: `feat(schedule): own nearest-deadline driver lifecycle`.
- Exactly two changed/committed files: `packages/schedule/src/driver.ts`, `packages/schedule/test/driver.test.ts` (877 insertions, 73 deletions).
- Final worktree porcelain output is empty. No changes to index.ts, tools.ts, session-executor/assembly.ts or any other package were made.

| File | Git blob at HEAD | SHA256 of verified on-disk bytes |
|---|---|---|
| packages/schedule/src/driver.ts | `f21ab8a062786b586a5de11d1d31f4ef71005899` | `E3D44A3FB5B519AE283BCECD59A0F9F3F8FDDD84C09456F16B815F7BFA0BDB3C` |
| packages/schedule/test/driver.test.ts | `858de647f33e7d2531db5c306e087a2f8da01bd3` | `6263B3A13C09DD571FA8CA58EB00DEBCD8AB34EFC6BE32DCA4FE387FEBA72F77` |

The source hashes were captured before commit after the final suite/typecheck, then matched again after commit. All evidence lives under `D:/I-harness-main/.superpowers/sdd/2026-10-24-schedule-deadline-driver/evidence/`.

## Behavior and compatibility

The existing cohesive driver now owns one optional mutation subscription, one in-flight pass and at most one nearest-deadline timeout. Factory construction and manual ticks do not acquire a subscription. Empty/exhausted state owns no timer; `pollMs` remains source-compatible but is deprecated and ignored. Real deadlines use the required nonnegative/platform-capped delay and unref when available. A capped timeout rereads the actual deadline; backward clock movement rearms without early admission. Explicit clock/resume invalidation recomputes from the current wall clock.

Each pass captures the session list and makes at most one handoff decision for each session. Concurrent ticks keep the existing immediate empty result while marking the snapshot dirty. A running pass rereads the final source state after host awaits and makes one final snapshot/rearm, with no while(dirty) delivery drain. Remaining genuinely progressed overdue work is reconsidered by its next one-shot callback. Stopped manual ticks never autonomously drain a second decision or create a timer. Mutation bursts and host dispatch notifications coalesce; final create/delete state behind a held host delivery determines the next deadline.

Start subscribes before its initial read, shares concurrent startup/result promises and waits for an older held pass before the new generation starts its own pass. Stop fences synchronously, clears the timer and detaches the known subscription. Generation checks protect each later handoff and rearm, including obsolete timer/subscription callbacks. Close is terminal, joins accepted work and startup acquisition, shares its current attempt, and memoizes only success. Ownership is published before invoking synchronous host callbacks so a callback-triggered close also joins the held handoff.

S1-02 is implemented: a failed known idempotent disposer is retained unchanged, restart is blocked until an explicit stop/close cleanup attempt succeeds, and a failed close can be attempted again. A subscribe exception without a returned handle is reported and permanently fences restart/close success; no recovery handle is invented. Failure state uses an explicit wrapper so even `throw undefined` cannot accidentally clear the fence. Adapter documentation requires atomic acquisition or rollback before throwing.

S1-01 is implemented: a failed unchanged active source gets no automatic retry timer. Suppression uses session plus ordered active-record tuples `(id, kind, prompt, scheduledAt, afterSeconds?, everySeconds?)`. Notifications alone do not release handoff/no-progress suppression. Actual active-fold progression, scoped explicit retry, a new nonoverlapping manual tick, or a new start can reconsider it. An older stopped generation's rejection cannot poison a newer start's explicit retry. Healthy sessions/deadlines continue; enumeration/read/fold/decision failures are contained and await explicit invalidation/manual retry rather than generating a retry interval.

Every successful returned handoff is reread against the actual owned fold. All handed-off records must be absent or advanced beyond their handed-off occurrence. A missing source, no append, unrelated append, or partial every-batch advancement cannot stand in for that proof. No-progress is reported as `delivery did not advance schedule state` and suppresses the unchanged resulting state. Rejected handoffs are reported without counting, and a real committed advancement behind a rejection is reread before any overdue remainder is offered. The driver writes no synthetic acknowledgement or dispatch facts.

Enumeration, source reads, fold/decision, host handoff and warning callback failures settle without leaving ownership stuck; warnings are guarded without recursive reporting, and autonomous promises have rejection guards. Driver-scoped errors use `<driver>:`; session errors retain their session prefix. Returned-handoff counts preserve the existing semantics and do not claim durable acceptance.

Unchanged compatibility boundaries: `decideDue` and the fold remain authoritative and were not edited; one-shot precedence, create-order ties, latest anchored every occurrences, one all-overdue-every batch per decision, shared acceptedAt, original one-shot `${record.id}@${occurrenceAt}` identities and original `schedule-batch@${acceptedAt}` identities remain. The host continues to own grouped dispatch/admitted publication and exact unknown-publication reconciliation.

The visible library compatibility change is the removal of automatic retry of an unchanged failed background source. The shipping host still performs only its existing manual pre-step tick, preserving its next-step retry behavior. This packet adds no host start call, shipping mutation adapter, idle admission, model wake, platform monitor, durable store, protocol/version/schema change, remote action or decomposition claim.

## Causal RED/GREEN and final gates

All test commands ran sequentially from the stable package CWD `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main/packages/schedule`, with `maxWorkers=2/minWorkers=1`. The package manager/runtime dependencies already resolved; no install/setup repair was needed. Raw stdout/stderr and numeric exit codes were retained. No baseline/setup-invalid run occurred.

| Order | Exact test/check command | Result / numeric exit | Raw evidence file |
|---|---|---|---|
| 1 | `pnpm exec vitest run test/driver.test.ts --maxWorkers=2 --minWorkers=1` | Causal RED against BASE implementation: 22 failing new cases, existing 11 passing; exit 1 | `task-1-red.txt` |
| 2 | `pnpm exec vitest run test/driver.test.ts --maxWorkers=2 --minWorkers=1` | First implementation GREEN: 33/33; exit 0 | `task-1-green-iteration-1.txt` |
| 3 | `pnpm typecheck` | Initial typecheck; exit 0 | `task-1-typecheck-iteration-1.txt` |
| 4 | `pnpm exec vitest run test/driver.test.ts --maxWorkers=2 --minWorkers=1` | Audit RED: 2 failed / 35 passed, proving old-generation rejection suppresses waiting restart and undefined exception bypasses acquisition fence; exit 1 | `task-1-red-generation-and-undefined.txt` |
| 5 | `pnpm exec vitest run test/driver.test.ts --maxWorkers=2 --minWorkers=1` | Audit RED: 1 failed / 38 passed, proving synchronous callback close settled before held host work; prior two fixes green; exit 1 | `task-1-red-reentrant-close.txt` |
| 6 | `pnpm exec vitest run test/driver.test.ts --maxWorkers=2 --minWorkers=1` | Ownership fixes GREEN: 39/39; exit 0 | `task-1-green-iteration-2.txt` |
| 7 | `pnpm exec vitest run test/driver.test.ts --maxWorkers=2 --minWorkers=1` | Audit RED: 1 failed / 39 passed, proving a missing post-handoff source was silently accepted without advancement proof; exit 1 | `task-1-red-missing-source.txt` |
| 8 | `pnpm exec vitest run --maxWorkers=2 --minWorkers=1` | Final frozen-source GREEN: 70/70 across 4 files, including driver 40/40; exit 0 | `task-1-final-suite.txt` |
| 9 | `pnpm typecheck` | Final frozen-source typecheck; exit 0 | `task-1-final-typecheck.txt` |
| 10 | `git diff --check` (checkout root) | Clean; exit 0 | `task-1-final-diff-check.txt` |

The final full package suite comprises driver 40 tests, schedule 16, tools 12, and site-diagnostics 2. Supplemental qualification cases for partial every-batch advancement, autonomous callback rejection and reusable cleanup already passed when added to the first implementation; they did not require a new production behavior change. All production fixes above were preceded by their failing causal control.

Further source/Git evidence: `task-1-final.patch`, `task-1-final-source-hashes.txt`, `task-1-final-git-range.txt`. The only commit command was `git add -- packages/schedule/src/driver.ts packages/schedule/test/driver.test.ts` followed by `git commit -m "feat(schedule): own nearest-deadline driver lifecycle"`, exit 0. Post-commit range/status/blob/hash commands were reported as exit 0 with the two owned files and a clean checkout. **Evidence correction (2026-10-24):** the original report also cited `task-1-final-git-status.txt`, but that file does not exist; the earlier status observation has no saved raw file. Root subsequently ran a fresh `git status --porcelain=v1` at unchanged HEAD c86df70b and saved `evidence/root-post-review-git-status.txt` with actual observation time, CWD, command and exit 0. Its empty status proves the checkout was clean at this new observation; it is not backfilled evidence of the earlier command.

## Scoped acceptance and remaining work

- Tasks 1–2 library implementation/test gates are green and ready for fresh independent GPT-6.1 Sol review over the entire BASE..HEAD range. The implementer has stopped writing after this packet.
- Task 3 remains reserved to root after P2 source freeze. No session-executor/assembly.ts hook was edited and no managed-host qualification suite was run in this packet. In particular, the exact-session pre-step filter and managed cold-reopen qualification remain to be implemented/reviewed there.
- Array-appending fixture sessions demonstrate library decisions, timing, lifecycle and source-fold observations only. They do not establish managed grouped durability, publication privacy, coordinator reconciliation, actual model admission or idle behavior in the shipping host.
- A wall-clock jump is observable only through supplied clock/resume invalidation or an outstanding real-deadline timeout. An empty driver does not detect clock changes itself; no periodic clock probe was added.
- An arbitrarily never-settling host handoff cannot be made finite or durably classified here. Stop fences later admission immediately; close joins the existing host promise without inventing success or replay.
- No claim is made for shipping idle deadline delivery, CLI/Gateway wiring, full S1, full Task 6, or release readiness. Product 0.1.13-rc.1 / Session12 and shipping manual pre-step policy remain unchanged by this packet.
