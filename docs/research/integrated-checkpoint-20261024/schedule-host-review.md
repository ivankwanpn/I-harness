# Spec compliance — ✅ Task 3 compliant

- **Review range:** `bbca3c79ada44271ea17b2fa041a91b41676b3b2..65fe3b4acf7895d43232fd1ca543a06fc5a8b06b`; reviewer GPT-6.1 Sol. **Task quality: Approved.** No Critical or Important finding.
- **Scope:** Reviewed the supplied complete diff once. The only product hunk is `packages/session-executor/src/assembly.ts:1035`; the remaining changes are managed-host qualification in `packages/session-executor/test/schedule-delivery.test.ts:218`, `:288`, `:431`, and `:450`. No driver, P2 lifecycle, instruction context, schema/version, shipping start, clock, subscription, registry, or model-wake change appears in this range.
- **Identity gate:** `assembly.ts:1036` rejects null/nonobject payloads; `:1039` requires exact `payload.session === session` before `payload.signal` is read at `:1040` and before `tick()` at `:1041`. Matching `sessionId` is never consulted. Both ignored and accepted paths resolve to undefined, preserving the waterfall seed.
- **Child controls:** `schedule-delivery.test.ts:221` mounts a real child plugin scope; `:222` creates and opens a distinct managed child Session; `:225` supplies either the child ID or the parent's forged matching ID. `:248` emits through the real scope, and `:249`–`:255` pin intact waterfall payload, zero child signal reads, zero parent dispatch/admission/backend dispatch, zero scheduled fact calls, and zero model requests. The own parent run at `:258` then dispatches once; a second actual step at `:267` sees the claimed reminder without redispatch/admission duplication.
- **Signal ownership:** `schedule-delivery.test.ts:234` delegates to the original managed `beginAction`, and `:237` delegates to the original grouped `scheduled` port. `:263` compares the signal actually supplied to that scheduled action with the signal observed on the actual own-step payload. This proves original pre-step signal propagation rather than merely checking signal shape or the caller's controller.
- **Preserved host behavior:** Existing controls pin idle/no model work (`schedule-delivery.test.ts:286`), pumped second-turn visibility (`:297`), original occurrence IDs and adjacent grouped durable dispatch/admission (`:330`), next-step claim/source/no-internal behavior (`:386`), inherited-prefix exclusion (`:413`), and every-batch identity/shared acceptedAt (`:508`, `:531`). Added suffix ownership at `:431` leaves the inherited record active while dispatching only the owned suffix. The production grouped-fact handoff is unchanged by the supplied diff.
- **Actual cold reopen:** `schedule-delivery.test.ts:460` accepts the first overdue occurrence and leaves the remainder active. `:464`–`:465` dispose the first assembly and close its coordinator. `:468` constructs a fresh JSONL backend and fresh coordinator over the original storage root; `:470` creates a fresh assembly and `:472` checks the different Session identity. The durable snapshot at `:477`–`:483` contains exactly the two original occurrence dispatches/admissions and an empty active fold. The two resumed model requests at `:484`–`:486` carry the previously accepted reminder and then the pumped remainder. This is coordinator/backend cold reopen, without claiming a separate OS-process restart.
- **Unknown publication:** The existing real backend wrapper calls actual `appendOwnedBatch` before returning an unknown result and retains the original batch key (`schedule-delivery.test.ts:85`–`:89`). The case at `:349` pins private dispatch/admission and zero model requests, reconciles that exact key at `:361`, then reopens the owned assembly and consumes the reminder once. It reuses the same coordinator at `:363`; it is not counted as the new cold-reopen proof.

## Strengths and causal evidence

- **Real persistence, not array acceptance:** The fixture creates a real JSONL backend and coordinator (`schedule-delivery.test.ts:81`–`:82`), observes the result of the original backend append (`:86`–`:87`), seeds the document via coordinator append/snapshot (`:155`–`:156`), and opens the managed view (`:157`). The recorder arrays observe committed batches; they do not produce schedule acceptance. The new signal probe also preserves the original fact operations (`:235`, `:239`).
- **Causal RED retained:** `evidence/task-3/03-red-child-effects.txt:39`, `:59`, `:79`, and `:99` show both child identities reading the getter once and causing one parent dispatch, one parent admission, and one backend dispatch. Exit 1 is retained at `:123`. This is stronger than the earlier signal-only short-circuit at `02-red-child-identity.txt:39`. The matching RED copies contain the old unguarded handler (`red-assembly.ts:1035`) and the soft side-effect assertions (`red-schedule-delivery.test.ts:238`–`:242`); their independently read SHA256 values match receipt 03.
- **Honest oracle correction:** `05-managed-qualification.txt:35` and `:67` retain the failed assertion that the emitted pre-step signal must equal the `agent.run` caller signal, with 2 failed/8 passed and exit 1 (`:76`, `:80`). That failure is a test assumption, not a product bug: the unchanged Agent wraps the turn in a managed action (`packages/core-agent/src/agent/create.ts:39`, `:89`, `:108`), and managed `beginAction` composes the supplied signal with its cancellation signal (`packages/session-persistence/src/coordinator/managed-document.ts:303`–`:310`). The revised oracle at `schedule-delivery.test.ts:263` still requires reference equality with the actual original own-step signal passed to the schedule handoff; it was not weakened to `instanceof` alone. Assembly SHA256 is identical in receipts 04, 05, and 06.

## Focused checks outside the diff

- **Named risk: scope emission or undefined-return assumptions could make the child control artificial.** Read unchanged `packages/core-plugin/src/scope/listeners.ts:79`–`:99`: plain listeners are awaited; only non-undefined returns seed a waterfall; the resolved payload bubbles through `parentEmit`. Read unchanged `packages/core-agent/src/agent/turn.ts:61`: real steps emit the actual Session and current turn signal. These checks support the ownership gate and waterfall assertions.
- **Named risk: correcting the signal oracle could accidentally accept a replacement signal.** Read unchanged Agent `create.ts:39`, `:89`, `:108` and managed document `:303`–`:310` to trace caller-signal composition, then checked the final test's delegating scheduled-port probe against the emitted payload (`schedule-delivery.test.ts:234`–`:263`). The assertion still traces the original emitted signal at the handoff boundary.
- **Named risk: the added tests could use fake durable acceptance or label a reused coordinator cold.** Inspected only the relevant fixture/control ranges from the frozen final evidence copy: `schedule-delivery.test.ts:78`–`:177`, `:279`–`:429`, `:493`–`:584`. The new cold case is distinct from the existing same-coordinator restart/reconciliation cases. The diff does not contain the fixture definition, so that targeted inspection was necessary.
- **Named risk: direct child-scope controls could be the only child qualification.** Read unchanged `packages/session-executor/test/retained-child-scope.test.ts:13`: it runs a real managed assembly, launches an actual held child through `spawn_agent`, changes project context, then invokes `followup_task` and checks fresh source ownership. Its frozen receipt is retained separately; it is a complementary launch/followup control, not an additional overdue-schedule assertion.

## Evidence receipts and final source binding

- **Read-only verification:** No tests, git diff/status commands, background programs, or subagents were run during this review. No product or Git state was modified. Only this report was written. All source references above resolve against frozen checkout `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`; receipt and evidence-copy references resolve under this packet's `evidence/task-3/`.
- **Runtime receipts:** Read all numbered receipts 01–11, including failures. Receipts 01–08 record exact commands, package CWD, UTC start/end, source SHA256s, and numeric exits. Package CWD is `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main/packages/session-executor`. Tests are sequential and use `--maxWorkers=2 --minWorkers=1`.

| Receipt | Recorded command/result |
| --- | --- |
| `01-baseline-schedule.txt:1` | `pnpm exec vitest run test/schedule-delivery.test.ts --maxWorkers=2 --minWorkers=1`; 6/6, exit 0 |
| `02-red-child-identity.txt:1` | Same schedule path with `-t "ignores a bubbled"`; 2 failed/6 skipped, exit 1; initial signal-only RED retained |
| `03-red-child-effects.txt:1` | Same targeted command; 2 failed/6 skipped, exit 1; actual managed/backend effects retained |
| `04-green-child-identity.txt:1` | Same targeted command; 2 passed/6 skipped, exit 0 |
| `05-managed-qualification.txt:1` | Full schedule command; 2 failed/8 passed, exit 1; caller-versus-composed signal oracle failure retained |
| `06-final-managed-suite.txt:1` | Full schedule command; 10/10 at `:25`, exit 0 at `:29` |
| `07-final-child-control.txt:1` | `pnpm exec vitest run test/retained-child-scope.test.ts --maxWorkers=2 --minWorkers=1`; 1/1 at `:28`, exit 0 at `:32` |
| `08-final-typecheck.txt:1` | `pnpm typecheck` / `tsc --noEmit`; exit 0 at `:15` |
| `09-final-diff-check.txt:1` | Empty-output `git diff --check` has actual command/CWD/timestamps and numeric exit 0 |
| `10-commit.txt:1` | Exact two-file staging and commit recorded, both exit 0; commit `65fe3b4a` |
| `11-final-git-binding.txt:3` | Full HEAD, branch, range stat/name list, clean status and range whitespace check recorded with exit 0 |

- **Independent file-hash check:** Read `final-source-audit.json` and independently computed SHA256 of both RED copies, both final copies, and the three physical final source/control files. RED copies match receipt 03: assembly `C431A2928EBE314B68A2D7B922F68DF9E62A91052172479DE2FF82E3D27A670C`, schedule test `49A481347CCA076612B175AB80FF082931FA0EF0C26B6B8664A16C5344505418`. Final physical assembly and evidence copy both equal `A32BB4ACE084A3DEBB4A08ECCF35398E36DD9252AD75EAE249C88468F4A5F9D2`; final physical schedule test and evidence copy both equal `0EAE96CC32E406B176C9208FC4DDFDFAED5E0732D85AC4624A3F7313CEC0A730`. The retained-child physical hash equals its receipt's `0B9B580E41CB0E4C872E3744C18AD7D1821C021B56638F7A6D3CBA8E5C3A0AF3`.
- **Saved Git binding:** `final-source-audit.json:7`–`:9` records assembly HEAD/canonical physical blob `0c7c3a4e7ac3cbfb11d284795fa3d54949fffae9`; `:16`–`:18` records schedule-test blob `44d1c7ba6feb17c2b34c72006bb92da0a6461856`. Both are marked matching and agree with the supplied diff index. The reviewer did not rerun Git to regenerate these receipts.

## Critical — Must Fix

- None found in the assigned Task 3 range.

## Important — Should Fix

- None found in the assigned Task 3 range.

## Minor — Nice to Have / retained existing noise

- **Existing warning, non-blocking:** `evidence/task-3/07-final-child-control.txt:22` reports that general child role tools `code_context_search`, `code_context_status`, and `code_context_index` are absent from the parent registry. The held-child/followup control passes, but its stderr is not pristine. The implementer's report discloses this at `task-3-report.md:55`. No new warning is attributed to this handler change; tool-catalog cleanup belongs to its existing owner and does not justify expanding this packet.

## Cannot verify / acceptance boundaries

- **Whole version and still-open service recovery:** This Task 3 diff and its focused receipts do not qualify MAIN integration, full Task 6, CLI/Gateway-wide consumers, the separate still-open service recovery management gap, release readiness, or runtime idle deadline delivery. These remain with their existing owners; `task-3-report.md:70` states the boundary accurately. No such completion is inferred here.
- **Historical executions:** Test results and HEAD/clean-tree observations are assessed from the retained raw receipts, not independently rerun. Physical final source/copy hashes were independently checked; the saved canonical Git-blob binding is used as supplied. The failed intermediate 02/05 revisions have recorded hashes and failing assertions; only the fuller causal RED 03 and final source revisions have separate full source copies in this evidence directory.
- **Scope of cold restart:** The new test proves a closed coordinator followed by fresh backend/coordinator/assembly reconstruction over the same JSONL journal. It does not launch a fresh operating-system process or simulate power-loss timing. The older cases at `schedule-delivery.test.ts:363` and `:568` reuse a coordinator and are not described as cold restart in this approval.
- **Version/schema:** The complete supplied range does not touch product version or Session schema. This review does not repeat the separate whole-version audit; product `0.1.13-rc.1` / Session `12` is not changed by the reviewed hunk.

## Assessment — Approved

- **Spec compliance:** Approved for the reserved Task 3 shipping schedule owner filter and its focused managed-host qualification.
- **Code quality:** Approved. The guard fixes the demonstrated cross-owner signal/admission bug with a narrow identity check, keeps undefined waterfall returns, and preserves the original managed handoff. Causal RED, original-own-step signal tracing, true backend/coordinator reopen, unknown-key reconciliation, and source-bound final 10/10 + 1/1 + typecheck-exit-0 receipts support this scoped decision. No broader recovery or release claim is made.
