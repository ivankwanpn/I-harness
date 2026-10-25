# Task 1 — retained live batch continuation

Status: **DONE_WITH_CONCERNS — candidate committed for fresh full-range review; required session gate is not green.** Root explicitly authorized freezing this candidate with the unresolved close-boundary concern. No integration, push, tag, version change, or release was performed.

## Frozen candidate

- Sole product writer/runtime: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`.
- Branch: `codex/retained-batch-continuation-20261025`.
- BASE: `e8fc3d1d63a4cae991d5673d5d0720af71c05ac1`.
- HEAD: `a6c234c8ae12b020f1124105561c66ac1a73ec09` — `fix(core-agent): continue fully settled retained tool batches`.
- Complete review range: `e8fc3d1d63a4cae991d5673d5d0720af71c05ac1..a6c234c8ae12b020f1124105561c66ac1a73ec09`, one commit, 12 connected source/test files, 751 insertions and 41 deletions.
- Evidence root: `D:/I-harness-main/.superpowers/sdd/2026-10-25-retained-batch-continuation/task-1/`.
- `final/source-manifest.txt` SHA256: `bd46e50c0b16be73ba7934c55fe5c482a535877aa1851965898f0116f3105ecd`.
- `final/BASE..HEAD.patch` SHA256: `89a7e9181174ce72d2b0c5e366a8ab43ee64526f42fc3c8d056523741103328a`.
- `final/HEAD-git-blob-manifest.txt` SHA256: `aa44d47123a426fb7990faf6f73095d6677a1527a884306d5f84e30ffcc441b1`.

The manifest contains working-tree byte hashes for every committed file; the Git blob manifest records the corresponding committed objects. `final/commits.txt`, `final/BASE..HEAD-files.txt`, and the complete patch freeze the review range. Product version remains 0.1.13-rc.1 and Session format remains 12.

## Implementation and ownership

The managed Agent now creates an internal invocation capability under its actual `withFactAction` action. Only its tool batch uses a separately issued actual managed settlement source. The exact source object remains in the existing drain set until its bound original close succeeds; close failure leaves it available for the original owner cleanup retry. Generic `trackSettlementSource` and its other clients are unchanged. The existing synchronous IC-B ownership transfer and drain order remain: batch finished prerequisite, original record/reference settlement, original pin release, then successful actual source release. The invocation source stays live while the Agent loop continues.

`tool-batch/live-continuation.ts` privately binds an opaque token to the exact options object, original batch, request scope, invocation/action/view, registered source, and original thrown object. Options identity is captured before `resolveBatchFacts` spreads options. Source preparation, successful-close marking, reservation, consumption, and release are distinct operations. `join.ts` marks only after its captured original close succeeds and still throws the original checkpoint error. The turn's catch is outside `handoffBatch`; a wrapper aggregate has a different object identity and cannot qualify through its cause.

Checkpoint provenance records every raw marker/flush or privately retained dispatch occurrence, including `undefined`. It does not infer provenance from an error's code, message, flags, or cause. A permanent disqualification bit covers raw occurrences, outer/refusal/record/finalization/post-tool/telemetry/reference failures. Slot completeness requires every slot recorded and the committed cursor equal to batch length. Actual registered execution metadata is checked for nonsynthetic results and dispatch rejections, including the case where a canceled real effect subsequently receives a synthetic failed fill. Unknown effects cannot be made eligible by that fill.

The handler reserves once before awaiting readiness. It checks original invocation, external signals, already borrowed reviewer allowance, and exact owner readiness before and after the existing readiness await. LC09 was authorized by root during implementation: capture the existing `assertReady` function from the already `isManagedFactOwner`-validated owner at Agent construction, bind it to that same owner, require it for continuation, and recheck exact view identity. A no-op host readiness callback cannot bypass another real source hold. No owner-wide drain, invocation-source close, new action, reborrow, or deadline renewal is performed by the gate. The accepted main generation is not asserted or reopened.

The original review generation's `check` plus `generation.assertOpen` are retained at the actual `forChild` mint. The private helper validates exact consumed binding/view/action and the original signal/check without minting new authority. Reviewer tools remain unchanged, including tools-free reviewer composition.

No public index export, `AgentDeps` field, `ExecuteToolCallsOptions` field, event, format, native interface, backend, or LLM authority seam was added. Private execution dependencies shadow caller fields. The public unmanaged/nondurable batch remains on its prior throwing behavior.

## Causal RED and connected GREEN

`named-red/` is the qualifying BASE RED. The actual JSONL-backed service builds the parent Agent and actual child assembly/CodeMode mount. Independent controlled parent and child clients request one foreground `spawn_agent`, then one `code_exec` containing `text(await tools.owner_probe({}))`; the real nested producer returns literal `{probe:"once"}` and runs once. The backend wrapper first awaits the original child `code/output` append, retains its actual committed outcome and exact batch key, and returns unknown once. Reconciliation uses the actual backend and same original key.

A bounded original-handle gate keeps that key unknown only until the existing outer dispatcher rejection boundary observes the actual recovery error, then permits reconciliation. It does not substitute a receipt, publish facts itself, synthesize a recovery input, rerun the producer, or start native work. This prevents automatic original refresh from outrunning observer rejection. It proves the selected live continuation mechanism; **historical003's initial trigger remains unknown**.

The qualifying RED failed because the child's final assistant text remained empty instead of `child final`, despite the genuine retained output having landed and reconciled. `named-red/vitest.txt`, `command.txt`, `HEAD.txt`, `source-hashes.txt`, `fixture.json`, copied original physical journals/results, and `independent-journal-summary.json` preserve that run. The original RED test source was reconstructed and verified byte-for-byte against its recorded SHA256 `f0f9b3cb21d8beadee4a37d870ac303cf3cf19d65be2062bde1357983b352742`; it is saved as `named-red/original-test-source.ts`. The verification is recorded separately. Two earlier fixture setup failures (approval configuration and disabled child CodeMode) remain separately under `red/` and `causal-red/`; neither is presented as the causal RED.

The connected GREEN proves parent final and child final with one child admission, promotion, input, nested producer/call/dispatch, output, and completed terminal. The original outer `code_exec` result still has execution outcome `failed`. Before the next child request, the exact original source is observed closed, its actual invocation action remains open with an un-aborted signal, the view matches the original, and the document is ready. The rejection boundary observed the original hold, and the second child request contains the actual recovered result. `final/session-named/fixture.json` retains these checks and both clients' messages.

Copied raw JSONL frames are independently summarized under `final/session-named/independent-journal-summary.json`. Independent artifact byte inspection is recorded in `final/independent-output-artifact-check.json`: the one original output artifact is 22 encoded bytes, parses to literal `{"probe":"once"}`, and its SHA256 matches the committed reference (`5d09c8107ddb76601dd2225e96c27586d08402ff18908970196a0a7e59b00407`). Later final-byte named GREEN evidence is also retained under `final/session-final-bytes/`.

## Verification results

All Vitest commands ran sequentially in the affected package CWD with `--maxWorkers=2 --minWorkers=1`; configuration directories were isolated under task evidence. Full raw commands, environment location, output, and exit files are retained under `final/`.

| Check | Result | Raw evidence |
|---|---|---|
| Core named continuation suite on exact final bytes | 33/33 pass | `core-final-bytes-named.txt`, exit 0 |
| Session connected named suite on exact final bytes | 1/1 pass | `session-final-bytes-named.txt`, exit 0 |
| Required core focused gate: new suite, execute-tool-calls, retained-boundaries, recovery-settlement | 87/87 pass, 4 files | `core-focused.txt`, exit 0 |
| Required session focused gate: new suite, retained-code-output, retained-hook-recovery, retained-hook-stop, guardian-generation, code-mode-children-close-boundary | **19/20 pass, 5/6 files; failed existing close-boundary numeric oracle** | `session-focused.txt`, exit 1 |
| Core `node ../../node_modules/typescript/bin/tsc --noEmit` | Pass | `core-final-bytes-tsc.txt`, exit 0 |
| Session `node ../../node_modules/typescript/bin/tsc --noEmit` | Pass | `session-final-bytes-tsc.txt`, exit 0 |
| Staged and complete BASE..HEAD diff check | Pass | `staged-diff-check-exit.txt`, `BASE..HEAD-diff-check-exit.txt`, both 0 |
| Public type/index and generic source diff | Empty | `public-and-generic-source-diff.txt` |

Staging exposed two extra trailing blank lines at EOF in new tests. Only those blank lines were removed; the earlier tested manifest is preserved as `tested-before-eof-cleanup-source-manifest.txt`. Both named suites and both type checks were repeated on the exact committed final bytes. The prior focused gate outcomes, including the failure, remain intact and are not replaced by a later green run.

The 33 core controls include real managed continuation; missing readiness; unrelated holds/source fault/wrong actual view; Stop and readiness refusal; the AGENT_BUSY run/followup/compact lease; raw Error/FACT-shaped/undefined occurrences; raw-before-retained and later raw-after-retained precedence; actual unknown registered outcomes, including canceled real dispatch plus synthetic fill; post-tool and telemetry failures; missing/synthetic unknown slots; exact token/batch/options/scope/prepared identities; one-use reservation; original source-close retry; original transferred instruction-pin failure; persistent unknown/conflict/absent result commits; outer commit failure that later settles; independent live source preservation; no-op callback refusal and ready positive; missing owner readiness; standalone compatibility; and actual unstarted handoff aggregate exclusion. Guardian controls use actual mint/borrow composition for valid, copied, foreign, reused, closed, expired, and revoked allowances, without reviewer tool expansion or new grants. Existing guest Stop coverage passes in the required focused gate.

## Unresolved required close-boundary gate

The unchanged existing `code-mode-children-close-boundary.test.ts` failed in the focused candidate run at its original `['1','2','3']` numeric assertion, receiving `['1','2','2']`. No assertion or deadline was changed.

One bounded BASE-source control temporarily overlaid the eight modified tracked core source files with their exact BASE versions in the **same authorized runtime checkout**, ran only the unchanged named test once, and restored original candidate bytes in `finally`. That control passed 1/1. The before/after candidate hashes match the frozen manifest (`final/restored-manifest-check.json`). `close-boundary-base-control/` preserves the command and result. This one pass does **not** establish source independence or dismiss the candidate failure.

One current-source diagnostic then used an external read-only subscription setup, retaining the same test oracle and deadline. It failed again, receiving `['1','2']`. The initial diagnostic setup import failure is separately preserved; it executed no test. The subsequent bounded diagnostic and its subscription timing limitations are explicit under `close-boundary-current-diagnostic/`, including `setup.ts`, `vitest.config.mjs`, raw output, and `receipts.json`. No repeat-until-green run was performed.

The diagnostic records the following exact ordering:

- Normal child `child-081e82f6-b608-4b7b-9609-83bfb2c0758a`, second cell `57b6dbfe-5421-4899-bc31-04aa1d823021`: `tool/result` seq 63 reports `status:"running"`; `turn/end` seq 78 precedes numeric output seq 79, store `turn=2` seq 80, and completed terminal seq 81. Its third cell later emits 3.
- Teammate `child-a1e5def2-3dc3-4ec1-8242-5ba56a0c3640`, second cell `55e3de54-64d7-458a-bfbb-1b16b8896d3f`: `tool/result` seq 63 reports `status:"running"`; `step/failed` seq 71 and `turn/end` seq 74 precede its later list-dir output seq 75. There is no second-cell store. On restore, that cell becomes interrupted at seq 78. The next cell emits 2 and commits store 2, so the final original oracle fails.

These are genuine live guest observations and late facts, with no privately retained checkpoint in this diagnostic. The new exact-error continuation handler is therefore not exercised by that run. The ordering points to a separate completion-precondition/close-qualification concern; a direct changed-source cause has not been demonstrated, and this report does not declare it an old-test waiver.

The actual status and cell ID are present in the diagnostic's real `tool/result` envelopes. The unchanged fixture pushes controlled model requests into its local `requests` array but branches only on the final message's role, without inspecting status or cell ID. The external diagnostic did not persist that local request array, so **direct runtime confirmation of status/cellId in the failing fixture's next controlled request is not retained**. The separate connected continuation fixture does persist and assert its next actual child request. This distinction must be retained in followup investigation.

## Limits and handoff

This candidate is ready for fresh independent review of the complete range, with the required session gate explicitly unresolved. Root will route the distinct close/completion concern as a connected followup unless review demonstrates a direct cause in this range. No whole C2/R4B, historical003-cause, native stability, platform, release, or all-gates-green claim is made.

No native tool jobs, external provider traffic, recursive agents, push, tag, release, or product edits in any other checkout were performed. The controlled model transport is in-memory test transport behind the genuine built-in client and execution composition. `.task3-evidence/` remained unread, unrun, and untouched. At handoff the only reported untracked checkout item is that protected directory; all 12 connected source/test files are committed.
