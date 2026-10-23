# P4 Agent compaction/policy qualification — implementation report

The bounded TEST-ONLY implementation is committed and ready for fresh independent Sol review. The final two-file gate passes 58/58 tests, with package typecheck exit 0. No product defect was patched and no whole-Agent or release acceptance is claimed.

## Exact range and ownership

- Physical writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`.
- Branch: `codex/agent-compaction-qualification-20261024`.
- BASE: `444e356fc9b1c8771eff2360d1705aaec37f8b5d`.
- HEAD: `cd83f7f18821e748aee088d4fded6852ad706ba9`.
- Review the full range: `444e356fc9b1c8771eff2360d1705aaec37f8b5d..cd83f7f18821e748aee088d4fded6852ad706ba9`.
- Commit: `test(core-agent): qualify compaction policies with eligible local summaries`.
- Only changed files: `packages/core-agent/test/agent.test.ts`, `packages/core-agent/test/model-policies.test.ts`, new `packages/core-agent/test/fixtures/summary-model.ts`.
- Existing shared `test/fixtures/agent.ts`, production Agent/reduction/summary/Session code and P2/P3 files remain unchanged. No dependency installation, profile/provider/account, schema/version, remote or recursive-agent operation.

Read the promoted P4 plan, integrated master/spec, baseline triage family D and accepted IC-A/IC-C source contracts. Root clarified the only newly reached contract ambiguity described below.

## Baseline: seven exact failures retained

The initial unchanged-source run was 55 tests: 48 pass, 7 fail. `evidence/baseline-tests.json` retains every stack and full name; `baseline-focused.raw.txt` retains the five actual `output-unknown` diagnostics (four policies and manual Agent). The seven failures were:

1. `agent abort rejects immediately when the signal is already aborted` — expected historical `/aborted/i`, received stable `FACT_CANCELLED`.
2. `agent compaction seam auto-compacts at a step boundary when under pressure` — expected obsolete summary event from sole current human input; false.
3. `agent compaction seam explicit agent.compact() appends the compaction events` — false compacted result; actual summary blocked `output-unknown`.
4. `createAgent per-model compaction policies applies the resolved provider/model threshold and retention when the agent runs`.
5. `createAgent per-model compaction policies compacts the same fixture with the equivalent global threshold and retention`.
6. `createAgent per-model compaction policies refreshes the policy key on a direct metadata rebind`.
7. `createAgent per-model compaction policies refreshes the inherited policy descriptor before the next logical step`.

Policy cases 4–7 stop at missing legacy marker/shadowedSeqs assertions. Actual declared-summary eligibility was absent; the original fixtures could not establish subsequent retention or rebind behavior. The old automatic fixture has no eligible older completed source; the active input is protected by Session state and selection, independently of summary eligibility. New sole-active-input and exact source-selection controls exercise that distinction.

## Changes and assertion rationale

The new focused summary helper follows the already-used compaction `prepareTextFixture` pattern. It invokes the real `prepareModelRequest` fallback against captured request data and preserves validation, measurement, pricing/output facts and real derivatives. It declares only this authored local script's ordinary-text capability, including through `withOutputCap`. It never manufactures complete protocol coverage, native proof, a supported cap, a fit assessment or provider-domain certification. Main clients remain optional stream-only clients; their budget assertions explicitly require `neutral-only`, unknown cap support and unavailable admission.

The explicit 20000-token summary budget and automatic/main fixture windows are synthetic configured test budgets. Main automatic window changes from 1000 to 10000 to hold seven realistic older completed exchanges while retaining the existing 0.1 soft trigger and original 300-character human input. No current input is shortened to make reduction succeed. Summary input size is actually counted by shared preparation; larger real input must produce a larger measured value/different fingerprint. The helper test executes the actual selected derivative and verifies its original captured messages and requested cap reach the local script. Nothing here is an upstream tokenizer or provider-capacity result.

Seven older balanced groups contain an older user task, assistant read call and complete original result within each closed physical step/turn. Tests capture original projection addresses before reduction and deep-copy raw archive facts. Replacements must have exact complete item/source coverage, correct insertion point, one checkpoint and intact original archive; replay counters stay zero. Existing prune is explicitly disabled so checkpoint replacement/retention, rather than a different valid reduction route, is the observed mechanism.

| Owner case | Replaced historical assertion | Current behavior qualified |
| --- | --- | --- |
| Immediate aborted API | `/aborted/i` wording | Exact `code: FACT_CANCELLED`, zero model invocation, zero effects, zero new Session events |
| Auto compaction | Any `compaction/summary`, first projected summary, generic reply substring | One actual `compaction/replacement` covering older groups 0–5, latest group 6 retained whole, active current input excluded from summary source and present once in actual next main request, exactly one summary call, strict measured token progress, truthful `reduced-over-target`, actual reply and neutral compatibility |
| Manual compact | Nonempty shadowed list and terminal `[start,summary,end]` legacy order | Public `compact` with actual completed-task seq explicitly protected, exact coverage of all seven older groups, exact shadowed source seq list, one replacement event, ready reduction under the large synthetic window, archive intact and actual same-session followup request containing checkpoint + previous task/reply + new task exactly |
| Per-model/global | Legacy shadowed user seqs `[0,1,2]`, old user-only tail `[3,4,5,6]` | Identical exact complete-group source coverage (groups 0–4), original groups 5–6 retained whole, matched original call/result IDs and no execution/replay, exact next request, strict projected reduction |
| Direct rebind | Update metadata before any observed logical turn | First actual turn under unlisted policy has no summary/rewrite, direct public metadata update, second actual logical turn uses selected policy with the same exact coverage/tail/request assertions |
| Inherited rebind | Only eventual legacy marker | First actual request under unlisted descriptor has no summary; replace inherited identity/model descriptor; second actual logical request uses selected policy with exact coverage/tail/request assertions |
| Absent/unlisted selections (four cases) | Merely no compaction plus count 9 | Global threshold 0.8 preserved, zero summary preparations, exact unchanged 21-message seeded history + current input in actual request, original raw history retained, zero effects; final projection count 23 follows the real three-message call/result groups |

The policy threshold ratios 0.05/0.8 and retainTokens=400 are unchanged. Retention no longer counts unrelated stepless user records: measured complete-group cost requires retaining the two newest seeded read groups. Tests independently bound one group's projected cost below 400 and the two-group tail at/above 400, including the small subsequent exchange in rebind cases. The two policy variants assert the same exact sources, not simply the existence of a marker.

Three new controls are included in the 58-test final gate:

- `agent compaction seam keeps sole current human input protected without preparing or calling a summary`: actual active Agent auto path does not rewrite the only human input or prepare a summary; subsequent explicit-protection manual call returns `no-eligible-source`, with zero summary preparations/invocations and exact task/reply projection.
- `agent compaction seam refuses unknown summary output before transport while the neutral main client remains usable`: real unknown summary returns `output-unknown`, invokes no summary stream, leaves Session facts unchanged and allows a same-session main followup with exact original history and unknown-capacity compatibility.
- `agent compaction seam measures actual local summary input and preserves explicit text eligibility through cap derivation`: larger measured input, different identity, derivative text capability and unchanged input/neutral validation facts, actual derivative stream/request capture.

The existing no-compact case additionally asserts truthful neutral-main unknown capacity.

## Retained newly reached RED and root ruling

`iteration-1.raw.txt` retains initial test-construction mistakes: duplicate read registration, assuming four rather than actual three projected messages per group, and allowing tool-schema fixed input to dominate the tiny sole-input target. These were repaired in test setup only.

`iteration-2.raw.txt` retains the deciding manual-protection and target assertions. Initially, the test assumed that a completed turn's human input remained automatically active. Actual manual compaction included that completed input, and an eligible summary could reduce the sole completed input. Production `conversation/state.ts` clears active turn at `turn/end`; accepted IC-A contract C2 explicitly protects **genuine active human inputs**, not all completed human inputs forever. `history/replacements.ts` enforces the same boundary.

Root inspected source and approved the correction: preserve the last completed task by calling the existing public `compact(undefined, { protectedSeqs: [actualTaskSeq] })`; retain active-input protection on the actual automatic path. This is a corrected test oracle, not a product-defect fix or a relaxation of protection. No production edit was made. Root also confirmed that automatic strict reduction plus actual compatible continuation may truthfully remain `reduced-over-target`; no ready/certified-fit claim is fabricated when protected input/schema/tail prevent that soft target. Those original RED receipts remain available for the independent reviewer.

## Final commands, binding and limits

All runtime and type commands use physical package CWD `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main/packages/core-agent`, sequential execution, Vitest workers 2/1. Exact command/exit/output index: `evidence/command-index.md`.

- Final `pnpm exec vitest run test/agent.test.ts test/model-policies.test.ts --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile.json=.../final-tests.json`: exit 0, **58 passed, 0 failed**, no skipped. Agent 50, policies 8.
- Final `pnpm exec tsc --noEmit`: exit 0, no diagnostics, once after stable source.
- `git diff --check`: exit 0.
- Final commit-only path set is exactly the three owned test files. Final status contains only pre-existing untracked `.task3-evidence/`.

Evidence files:

- `baseline-tests.json`, `baseline-focused.raw.txt`, `iteration-1.raw.txt`, `iteration-2.raw.txt`, `iteration-3.raw.txt`, `final-tests.json`, `final-tests.raw.txt`, `final-typecheck.raw.txt`.
- `baseline-final-comparison.json` includes the exact original failed names/stacks and every final assertion name/status.
- `pre-final-source-binding.json` and `final-source-git-binding.json` record physical paths, base/HEAD, branch, source SHA256/Git blobs, unchanged tested-byte comparisons, and workspace import link targets. All recorded blobs match final tested bytes, including unchanged shared helper and relevant production owners. Imported package links resolve inside this same checkout.
- `full-range.patch` includes the full BASE..HEAD diff, including the new fixture; `owned-before-commit.patch` retains the precommit tracked diff.
- Existing `.task3-evidence/` was never written by this task. `pre-final-task3-hashes.json`/`final-task3-hashes.json` additionally prove unchanged files across the final gates/commit; this is not misrepresented as a hash inventory taken before the first baseline run.

Remaining failures in the affected two-file gate: **none**. Limits: controlled nondurable local models and heuristic synthetic budget measurements only; no managed durable host/provider/native proof, no live accounts, no new claim about open/unknown-effect reduction guards beyond already accepted IC-C, no P2 recovery/Stop or P3 native qualification, no full-Agent/full-version/release result. No further runtime broadened solely for this test-only packet.

Stopped after implementation/commit/report for a fresh independent Sol review of the full range.
