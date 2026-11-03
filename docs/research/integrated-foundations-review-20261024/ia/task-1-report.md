# IA task 1 implementation report

Status: implemented, package-qualified, committed, and stopped for fresh independent review. This is internal instruction-source staging only; no provider, assembly, request, child-session, settings, release, or public instruction-support completion claim.

## Source binding and ownership

- Sole implementation checkout: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Branch: `codex/instruction-source-20261024`.
- Full BASE: `41ad97d39fa1f056ef55cd55c7411b501e6ef130`.
- Full HEAD: `43e6ec4f64f3a01855b0790360507c0cf75f64ac`.
- Commit: `feat(instructions): stage scoped observable source service`.
- Review range: `41ad97d39fa1f056ef55cd55c7411b501e6ef130..43e6ec4f64f3a01855b0790360507c0cf75f64ac`.
- Exactly ten added files, all under `packages/instructions/src` or `packages/instructions/test`; 794 insertions. Legacy `src/index.ts`, `src/files.ts`, package exports/dependencies, and runtime callers are unchanged.
- Root-owned untracked `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts` remains untracked and byte-identical: SHA256 `9FB750A75EC847DC97DD95D16E7EC7668B65D919BCB8208805F9A34FB93CEC68`.
- `source-commit-binding.json` records the committed range, final status, diagnostic hash, and zero differences between every package-gate file hash and the committed working files. The only remaining worktree status entry is the root-owned diagnostic.

## Delivered behavior

The five internal modules provide the approved DTO/service contract, explicit-scope discovery, bounded async file reading, deterministic rendering/dependency snapshots, and the injected observation/lifecycle owner. Tests import `src/service.ts` directly; the public package path does not export or consume it.

Discovery retains absent preferred and shadowed fallback dependencies, enforces exact configured global allowlists and pairing, chooses the narrowest authorized root, respects real Git directory/worktree markers, and bounds candidate slots and ancestor depth. Real Windows junction escape and alias fixtures passed. Globals receive explicit global scope labels. No ambient home defaults or Markdown expansion were added.

The service subscribes before the first filesystem await, installs bounded lexical candidate/marker interests, then reconciles under established observation coverage. It publishes pending/unavailable in-memory views synchronously, preserves unaffected dependency views, re-reads observed same-size/same-mtime changes, unions concurrent targets, bounds repeated invalidation to three attempts, and retains dirty work after exhaustion. Clean repeated preparation performs no stat/open/read work.

File content uses bounded `FileHandle.read` buffers and a shared four-byte lookahead allowance; truncation accounts for UTF8, header and marker bytes and distinguishes full/prefix hashes. Last-known-good text is explicitly unavailable after a transient read failure, and deletion/escape drops its cache/effective content. Shutdown fences preparation immediately, publishes empty unavailable state, joins active reads, closes the observation lease once, and preserves lease/file cleanup failures. Subscriber exceptions and reentrancy are isolated.

## Verification and causal receipts

Each named receipt has a `.log` and `.identity.json` containing UTC, command, HEAD, source/test SHA256 hashes and diff identity. Early new-service runs used explicit fixture roots and never invoked legacy ambient discovery. The final package gate isolated `HOME`, `USERPROFILE`, `TEMP`, `TMP`, home-drive/path and `IH_CONFIG_DIR` only in the spawned command process.

| Receipt | Result and significance |
|---|---|
| `red-discovery` | Exit 1: 12 failures / 1 pass against a compiling empty service. Policy, scope, precedence and validation assertions failed. |
| `red-limits` | Exit 1: 10 failures / 1 pass against the empty service. Actual-read/budget and disabled-state controls failed. |
| `red-lifecycle` | Exit 1: all 16 failed against the empty service. Meaningful dependency/publication assertions failed; four held-read cases timed out because the baseline never read, and two expected-rejection assertions also produced unhandled assertion diagnostics. Those timeout/error cases alone are not claimed as causal lifecycle proof. |
| `green-attempt-1` | Exit 0: 40/40 new tests. Real held-read assertions and joins ran and passed. |
| `red-edge-controls` → `green-edge-controls` | 2 failures / 45 passes → 47/47. Proved bounded watch installation for overflowing globals and pending Git boundary dependencies. |
| `red-self-review` → `green-self-review` | 5 failures / 23 passes → 28/28 focused tests. Proved missing Git pointer failure closure, inherited-getter rejection, deletion/LKG eviction, reentrant close identity, and subscriber-triggered concurrent target union. |
| `red-cleanup` → `green-cleanup` | 2 failures / 27 passes → 29/29 focused tests. Proved global labels and preservation of file-handle cleanup failure during joined close. |
| `package-gate` | Exit 0: **58/58**, five files (53 new tests plus five unchanged legacy tests). Command: `pnpm --filter @i-harness/instructions test --maxWorkers=2 --minWorkers=1 --no-file-parallelism`. |
| `typecheck-gate` | Exit 0: `pnpm --filter @i-harness/instructions typecheck`. |

The package test command intentionally passes worker options directly through pnpm without an extra literal `--`; output confirms Vitest receives the bounded worker and serial-file flags. Tests ran from the package selected by pnpm, not historical `.tmp` trees. No monorepo tests, dependency installs, provider calls, live-profile reads, or runtime deployment were performed.

`git diff --check`, `git diff --cached --check`, and the final committed range whitespace check all returned zero. The final package-gate source hashes match HEAD without subsequent product edits.

The isolated gate directory `D:/ia-gate-153fb9cddeca451286cfe94f86166065` was empty after fixture cleanup and removed with a nonrecursive exact-literal `Remove-Item`. An initial compound gate/recursive-cleanup command was rejected before execution by tool policy with only “blocked by policy”; the safer gate omitted recursive cleanup, ran successfully, and the verified empty directory was subsequently removed without recursion. No approval request or global environment mutation was needed.

## Review focus and limitations

- Fresh independent review is still required over the complete committed range. Do not infer integration or release acceptance from the package gate.
- The observation producer remains a deterministic injected fixture. IB must provide the real shared observation guarantee; IC/ID must wire the service to real owners before user-facing support is claimed.
- New-service isolation is explicit and tested with synthetic home/.claude/.codex sentinels. The unchanged legacy suite passed under a synthetic environment; this does not convert the legacy implementation itself into an ambient-isolated service.
- The suite ran on Windows with actual junctions and actual filesystem casing/separator equivalence. No platform-capability skips occurred. Other-platform qualification is not claimed.
- File atomicity against unobserved arbitrary external writers is not claimed. Observed changes, file identity checks, pending states and post-install reconciliation are the implemented evidence boundary.
- Input target activation stays monotonic for the service lifetime; policy changes still require replacement by the future owner. No permission, model acknowledgment, native producer cancellation, or mutation authorization behavior was added.

Implementation work is stopped pending root-owned independent review.

## Fix round 1 — independent-review P1/P2

The first independent review did not accept IA at `43e6ec4f64f3a01855b0790360507c0cf75f64ac`. Both findings were reproduced against that exact committed implementation before product edits. Fix work stayed in the same sole-writer checkout/branch and the original ownership boundary.

- Fix commit: `8475aa3fa1b17270125c22b50d5695e6172ac86d` — `fix(instructions): track canonical boundaries and marker cleanup`.
- Focused fix range: `43e6ec4f64f3a01855b0790360507c0cf75f64ac..8475aa3fa1b17270125c22b50d5695e6172ac86d`.
- Complete IA range for re-review: `41ad97d39fa1f056ef55cd55c7411b501e6ef130..8475aa3fa1b17270125c22b50d5695e6172ac86d`.
- Six existing owned files changed in the fix: 98 insertions, nine deletions. There are still only the original ten added files in the complete range. No API shape, exports, runtime caller, dependency, settings or observation producer changes were made.

**P1:** The service now resolves bounded Git-marker aliases from the already planned, authorized lexical directories. Each mapping requires canonical containment within its authorized root; no mapping is derived from event-supplied prefixes. The mappings are installed before metadata reads and retained for synchronous event and pending matching. The original event path remains data for invalidation only, never source authority. Existing reset handling still invalidates all active views.

The new real Windows junction tests cover canonical marker creation and removal, changed and pending observations, immediate unavailable/pending publication, final narrow/broad policy, pending preparation/settlement, a similarly prefixed unrelated canonical marker negative control, and unchanged fingerprint/reliability for an independent root.

**P2:** The metadata reader distinguishes actual handle cleanup failure from malformed or unreadable marker policy. Its cleanup signal uses the existing service cleanup aggregation, shared with the content reader through the internal contracts module. Both intervening discovery catches preserve that signal. If marker reading and close both reject, their original errors survive together; a concurrent lease failure also survives in the joined close outcome. No additional resource owner or blanket promotion of policy errors was introduced.

Held real marker-read controls cover normal shutdown, marker close failure, marker+lease failure, marker read+close failure, and marker read+close+lease failure. They assert preparation rejects `INSTRUCTIONS_CLOSED`, close remains unsettled until the held read is released, each handle/lease closes exactly once, repeated close returns the same promise, and original error objects remain in the outcome. Existing malformed-marker controls and normal close continue to pass.

| Fix receipt | Result |
|---|---|
| `fix1-red` | Exit 1: **6 causal failures / 24 passes**. Canonical changed/pending tests retained ready evidence; four marker cleanup combinations lost original errors. Normal marker shutdown passed. No timeout/import/setup failure was used as the proof. |
| `fix1-green-alias` | Exit 0: **30/30** discovery/dependency tests after the P1 fix. |
| `fix1-green-cleanup` | Exit 0: **47/47** discovery/dependency/lifecycle tests after P2. |
| `fix1-package-gate` | Exit 0: **65/65** across five files, bounded workers and serial files, isolated synthetic home/config/temp. The unchanged five-test legacy suite is included. |
| `fix1-typecheck-gate` | Exit 0: package `tsc --noEmit`. |

Each fix receipt retains UTC, full source/test hashes, dirty diff and exact command. `fix1-source-commit-binding.json` proves zero final package/typecheck hash mismatches against the new commit, records both full/focused changed-file lists, and confirms the gateway diagnostic is still the only untracked file with its original SHA256. Final staged and committed whitespace checks passed. Git's configured LF-to-CRLF advisory appeared during diff/staging operations; the package/typecheck logs contain no test/type warnings or unhandled errors.

The fix gate used `D:/ia-gate-dba66ac909804202b372af8caa355eed`; it was verified empty after testing and removed by exact-literal, nonrecursive removal. No live-home/profile/provider reads, global environment changes, recursive agents, monorepo gate, or MAIN runtime work occurred.

Status: both reported defects are fixed and causally qualified; **IA acceptance remains pending the same independent reviewer's recheck**. Product work is stopped for that recheck. Original integration and platform qualification limits remain unchanged.

## Fix round 2 — retain failed canonical mapping reconciliation

The fix1 re-review closed the normal canonical-event controls and P2 cleanup repair, but reproduced residual P1: a transient canonical lookup failure was dropped before successful discovery, permitting ready publication without the required mapping. This round changes only `src/discovery.ts`, `src/service.ts`, and `test/dependencies.test.ts`; P2 reader/cleanup code and its tests are unchanged.

- Fix commit: `82d4b7a7c19f2971d7b21afd37c38ab6982bd8d0` — `fix(instructions): retain failed boundary reconciliation`.
- Focused range: `8475aa3fa1b17270125c22b50d5695e6172ac86d..82d4b7a7c19f2971d7b21afd37c38ab6982bd8d0`.
- Complete IA range: `41ad97d39fa1f056ef55cd55c7411b501e6ef130..82d4b7a7c19f2971d7b21afd37c38ab6982bd8d0`.
- Three owned files changed, 71 insertions and seven deletions. Same worktree, branch and scope; no public API/exports, consumer, settings, producer, dependency or authority changes.

The bounded alias resolver now returns failed targets explicitly along with verified mappings. The existing service marks only those applicable target views unavailable/incomplete, even if later filesystem discovery succeeds. It retains prior verified invalidation mappings during uncertainty, retains dirty slot/reconciliation work, and requests a fresh watch-interest update on the next preparation. Only successful mapping resolution under that established observation coverage removes the per-target uncertainty. Independent target views remain ready with unchanged fingerprints; normal ENOENT ancestor resolution remains known absence. Permanent resolution failure returns promptly rather than spinning and stays retryable.

Three new controls exercise the exact residual finding and its boundaries:

1. A real junction with exactly one injected alias `realpath` EACCES, followed by successful real lookups and content discovery. The first result must remain unavailable. A held recovery interest update proves the view cannot become ready before the barrier resolves. After recovery, canonical marker creation invalidates immediately and narrows policy; pending canonical marker removal then restores broad policy. The independent root remains unchanged throughout.
2. Permanent alias EACCES yields bounded unavailable results. A second preparation demonstrably retries both mapping and observation reconciliation instead of returning a falsely clean snapshot; the independent view stays unchanged.
3. An ordinary missing ancestor remains ready/complete with absent candidate dependencies and a clean repeated prepare that does not reinstall interests.

| Fix2 receipt | Result |
|---|---|
| `fix2-red` | Exit 1: **2 causal failures / 14 passes** at fix1 HEAD. The one-shot case incorrectly returned ready; the permanent-failure case performed no retry. The ordinary-absence control passed. |
| `fix2-green` | Exit 0: **50/50** discovery/dependency/lifecycle tests. Existing P2 controls were exercised as part of the requested affected-owner check, without new P2 changes. |
| `fix2-package-gate` | Exit 0: **68/68** across five files, bounded workers and serial execution, synthetic home/config/temp, unchanged five-test legacy suite included. |
| `fix2-typecheck-gate` | Exit 0: package `tsc --noEmit`. |

Each receipt records UTC, exact command, source/test hashes and the diff at the prior HEAD. `fix2-source-commit-binding.json` records zero package/typecheck hash mismatches at the new commit, both review ranges and file lists, and the unchanged root-owned Gateway diagnostic hash. The only remaining worktree status entry is that untracked diagnostic. Staged and final committed whitespace checks passed. The synthetic `D:/ia-gate-2d2b6d7f1a014c37a171d6847763720b` directory was inspected empty and removed nonrecursively by its exact literal path.

Status: residual P1 is fixed and causally qualified; **acceptance remains pending the same reviewer's scoped recheck**. Implementation work is stopped. All original integration/platform limits continue to apply.
