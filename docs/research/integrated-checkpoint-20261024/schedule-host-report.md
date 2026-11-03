# S1 Task 3 shipping schedule qualification report

Status: owned implementation committed and frozen for fresh independent GPT-6.1 Sol review. This packet completes the assigned Task 3 implementation and focused qualification; root review/integration, full Task 6 and release acceptance are not claimed.

## Authority and Git binding

- Sole writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.
- Branch: `codex/schedule-host-qualification-20261024`.
- Assigned and observed clean BASE: `bbca3c79ada44271ea17b2fa041a91b41676b3b2`.
- Committed HEAD: `65fe3b4acf7895d43232fd1ca543a06fc5a8b06b`.
- Full review range: `bbca3c79ada44271ea17b2fa041a91b41676b3b2..65fe3b4acf7895d43232fd1ca543a06fc5a8b06b`.
- Commit: `fix(schedule): restrict shipping ticks to owning session`.
- Exactly two committed files, 132 insertions and 1 deletion: `packages/session-executor/src/assembly.ts` and `packages/session-executor/test/schedule-delivery.test.ts`.
- Final `git status --porcelain=v1` was empty, exit 0. Final range `git diff --check` exited 0. Raw observation: `evidence/task-3/11-final-git-binding.txt`, UTC 2026-10-23T23:08:50 (Hong Kong 2026-10-24 07:08:50).
- Root's MAIN checkout was not changed or executed. No other assembly functionality, P2 generation construction, input lifecycle, IC-B, schedule library, version/schema, remote, release or live profile/provider was changed. No subagent was spawned.

## Narrow implementation and causal evidence

The sole production change is the schedule `agent/pre-step` handler. It first rejects null/nonobject payloads, then requires exact `payload.session === session` before accessing `payload.signal` or ticking. A child with the parent's matching `sessionId` remains a different Session and is ignored. Both accepted and ignored paths return undefined, preserving the waterfall payload. The existing grouped `action.facts.inputs.scheduled(dispatchEvents, admitted)` handoff is unchanged.

The new parameterized test mounts a real child plugin scope below the real managed parent assembly and opens a distinct managed child Session. The child scope emits the event through the real bubbling mechanism, once with its actual child ID and once with the parent's forged matching ID. A signal getter records any premature read. Before the fix, both cases read that getter once and publish a parent schedule dispatch/admission to the real managed view and JSONL backend. `03-red-child-effects.txt` records all four failing assertions per case, exit 1; the parent model remains idle. The matching RED source copies are `red-assembly.ts` and `red-schedule-delivery.test.ts`.

After the exact identity guard, both child cases have zero signal reads, zero parent dispatch/admission/backend schedule writes and zero model requests. A subsequent actual parent `agent.run` delivers once; another actual parent step claims the reminder without redispatch. The parent waterfall receives the original Session object and pre-step payload. A test probe delegates to the original managed `beginAction` and original grouped scheduled fact port, recording only the supplied signal, and verifies that the schedule action receives the exact actual own-step signal. It does not substitute persistence or append arrays as acceptance.

The first attempt to strengthen the own-signal assertion incorrectly expected `agent.run`'s caller signal to be the actual pre-step signal. `05-managed-qualification.txt` preserves that fixture-assumption failure (2 failed, 8 passed, exit 1). Investigation found the Agent/document action signal composition (`AbortSignal.any`), so the test now compares the real scheduled action signal with the actual emitted own-step signal. No additional production change was made. The initial minimal RED (`02-red-child-identity.txt`, 2 failed, 6 skipped, exit 1) and subsequent fully observable RED were both retained; their differing source hashes are explicitly recorded in each receipt.

## Managed behavior qualified

- Idle remains zero schedule delivery and zero model requests; the shipping assembly still explicitly ticks only at its own pre-step. No `start()`, timer, subscription, registry or background model wake was added.
- Parent own-step dispatch plus admitted identity/ordering remains one adjacent managed backend batch, with the existing occurrence ID and `steer`/system metadata.
- Existing next-step claim and actual pumped second-turn model/user visibility controls remain passing, including absence of `internal` and the claim path's plugin marker.
- The existing inherited-prefix exclusion control remains. A new owned-suffix control proves the inherited overdue record stays active while only the suffix record dispatches under its original occurrence input ID.
- Existing all-overdue-every grouping retains one admission, shared `acceptedAt`, original `schedule-batch@<acceptedAt>` and progression of both records.
- New real JSONL cold reopen closes the first assembly and coordinator, then constructs a fresh backend, fresh coordinator and fresh assembly over the same storage root. Before shutdown one overdue occurrence is accepted and another remains due. Reopened Session identity is different; the accepted occurrence has one total dispatch/admission, the remainder is dispatched/admitted once, both original occurrence IDs survive, and the final durable fold is empty. The two real resumed model requests observe the claimed first reminder and then the pumped remainder.
- Existing unknown-publication control remains passing: unknown dispatch/admission stay private and model requests stay zero; reconciliation uses the original recorded batch key, then owned assembly reopen consumes the accepted reminder once with one total dispatch/admission. This existing case reopens through the original coordinator; the separate cold-reopen case above explicitly creates a fresh coordinator/backend.
- Existing actual held-child/followup test passes against the frozen source. The newly added causal tests intentionally construct a real child plugin scope directly; the separate existing child test exercises actual child launch/followup ownership.

## Commands and raw receipts

Every numbered runtime receipt includes exact command, package CWD, UTC start/end, numeric exit and the actual source hashes at that run. Tests were sequential in this one checkout with `--maxWorkers=2 --minWorkers=1`. No Tasks 1–2 test was rerun. The existing independent Tasks 1–2 review and frozen 70/70/typecheck evidence remain authoritative for their library scope.

Runtime CWD for rows 01–08: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main/packages/session-executor`.

| Receipt under `evidence/task-3/` | Exact command | Observed result |
|---|---|---|
| `01-baseline-schedule.txt` | `pnpm exec vitest run test/schedule-delivery.test.ts --maxWorkers=2 --minWorkers=1` | Existing managed baseline 6/6, exit 0 |
| `02-red-child-identity.txt` | `pnpm exec vitest run test/schedule-delivery.test.ts -t "ignores a bubbled" --maxWorkers=2 --minWorkers=1` | 2 failed, 6 skipped; child signal read; exit 1 |
| `03-red-child-effects.txt` | same targeted command as 02 | 2 failed, 6 skipped; signal + parent dispatch/admission/backend side effects; exit 1 |
| `04-green-child-identity.txt` | same targeted command as 02 | 2 passed, 6 skipped; exit 0 |
| `05-managed-qualification.txt` | same full managed command as 01 | Fixture own-signal identity assumption failed: 2 failed, 8 passed; exit 1 |
| `06-final-managed-suite.txt` | same full managed command as 01 | Final frozen source: 10/10, exit 0 |
| `07-final-child-control.txt` | `pnpm exec vitest run test/retained-child-scope.test.ts --maxWorkers=2 --minWorkers=1` | Final frozen source: 1/1, exit 0 |
| `08-final-typecheck.txt` | `pnpm typecheck` (`tsc --noEmit`) | Final frozen source: exit 0 |

`07-final-child-control.txt` contains a warning that the general child role declares absent parent tools `code_context_search`, `code_context_status`, `code_context_index`. The child runs without those tools and the test passes. This packet does not claim pristine stderr for that control or repair unrelated tool catalogs.

`09-final-diff-check.txt` preserves the real empty-output `git diff --check` command with header and numeric exit 0. `10-commit.txt` records exact owned staging and commit commands/exits. `11-final-git-binding.txt` records full HEAD, branch, complete BASE..HEAD names/stat, clean status and range diff check. These Git commands ran in the assigned checkout root, not MAIN. No historical command/source binding was invented or replaced by a later passing run.

## Final source identity

Final source was frozen before `06`, `07` and `08`; no source changed after these checks. The two final source copies were taken immediately before `06`. `final-source-audit.json` confirms both copy hashes match the physical files, and canonical physical Git blobs match HEAD.

| File | SHA256 of physical file and evidence copy | Git blob at HEAD |
|---|---|---|
| `packages/session-executor/src/assembly.ts` / `final-assembly.ts` | `A32BB4ACE084A3DEBB4A08ECCF35398E36DD9252AD75EAE249C88468F4A5F9D2` | `0c7c3a4e7ac3cbfb11d284795fa3d54949fffae9` |
| `packages/session-executor/test/schedule-delivery.test.ts` / `final-schedule-delivery.test.ts` | `0EAE96CC32E406B176C9208FC4DDFDFAED5E0732D85AC4624A3F7313CEC0A730` | `44d1c7ba6feb17c2b34c72006bb92da0a6461856` |

## Remaining acceptance boundaries

Fresh independent Sol review and root integration remain required. Root owns MAIN and the whole Agent integration gate; this packet did not rerun those obligations or claim their outcome. P2's separately recorded service recovery management gap remains outside this packet. This result qualifies the existing shipping step-bound schedule consumer and the specified managed controls; it does not establish shipping idle deadline delivery, external cron, automatic model wake, CLI/Gateway-wide qualification, whole Task 6, full-version acceptance or release readiness. Product 0.1.13-rc.1 / Session 12 remains unchanged. Branch and checkout are preserved with no push, merge, tag or release; writer is stopped for review.
