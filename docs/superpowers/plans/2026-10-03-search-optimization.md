# IH Search Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement task-by-task. The user authorized ongoing development and parallel agents; disjoint ownership below takes precedence over a serial worker preference. Do not ask the execution-choice question again.

**Goal:** Complete the approved grep/ripgrep improvements and human multi-root content-search/navigation with genuine cancellation, bounds and honest partial results.

**Architecture:** Opt-in streaming extends sandbox-aware Exec. Fixed model helpers enumerate/read inside current confinement; the human reader uses current-project membership and pinned bytes. Both use a bounded fixed rg-stdin matcher and shared options/result metadata; GUI navigation retains editor/draft identity.

**Tech Stack:** Node >=22.18, TypeScript, private shipped ESM helpers, actual bundled rg15.0.0/PCRE2, React/Electron, existing SDK v3, Vitest/Playwright. Explicit `ignore` and `picomatch` dependencies for bounded pinned project policy; no arbitrary flags or new model alias.

**Spec:** [approved design](../specs/2026-10-03-search-optimization-design.md).

## Global Constraints

- Work only D:/frontend-test, codex/desktop-workbench, baselineeb7d757c. Preserve original electron.vite.config.ts SHA EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085 unchanged/unstaged. No main/reference edits, remote paid calls, user-data deletion or rejected-temp cleanup.
- Defaults/hard ceilings: timeout30000ms,1000 candidate files,32MiB bounded searched-content reads,1MiB/file,256KiB serialized result hard ceiling (model default32KiB, explicit4..256KiB; human Desktop256KiB),1MiB engine raw and1MiB runner raw independently,4 workers. Existing glob100/grep250 remain default returned limits; maxResults<=1000. Desktop walker3000 entries/depth32. Ignore policy20files/64KiB each. Every later task inherits the exact spec limits and status meanings.
- No broad test repetition or cap/timer increases to make red tests green. Meaningful failure/race/side-effect/owned-process tests, explicit source freezes and actual full-gate counts.
- Root owns spec/plan/progress and coordination. A single task owner handles git index/commits. Workers do not stage unrelated source, mutate the original config or create new agents without coordinator assignment.

## Canonical Interfaces

The implementing coordinator may choose private file placement within the listed responsibility, but these names/semantics are the contract between tasks. Changes require one synchronized plan/report update before consumers adapt.

```ts
// packages/exec/src/index.ts — additive public types consumed by scoped adapter/search
interface ExecStreamRunOptions {
  stream: { maxBytes: number; onStdout(chunk: Buffer): void | 'stop' }
  backgroundAfterMs?: never
}
// ExecResult.stream optional: bytesRead/bytesAdmitted {stdout,stderr},
// stopReason?: 'consumer'|'output-limit'|'aborted'|'timeout'.
// run(cmd, ExecStreamRunOptions): Promise<ExecResult> is a separate overload.

// packages/fs-search/src/search-types.ts — serializable shared query/results
type SearchStatus = 'completed'|'limited'|'cancelled'|'timed-out'|'error'
interface SearchQuery {
  pattern: string; mode?: 'regex'|'literal'; case?: 'sensitive'|'insensitive'
  before?: number; after?: number; includes?: string[]; excludes?: string[]
  hidden?: boolean; respectIgnore?: boolean; regexEngine?: 'default'|'pcre2'
  multiline?: boolean
  encoding?: 'auto'|'utf8'|'utf16le'|'utf16be'|'windows1252'|'latin1'
  maxResults?: number; maxResultBytes?: number; timeoutMs?: number
}
interface SearchMatch {
  path: string; line: number; text: string; textTruncated?: boolean
  column?: number; endLine?: number; endColumn?: number
  context?: { line: number; text: string; textTruncated?: boolean }[]
  revision?: string; encoding?: string
}
interface SearchResult {
  matches: SearchMatch[]; status: SearchStatus; partial: boolean; truncated: boolean
  reasons: string[]; error?: string; diagnostics: string[]
  stats: { candidateFiles: number; attemptedFiles: number; readFiles: number
    completedFiles: number; eofFiles: number; inputBytes: number
    engineRawBytes: number; runnerRawBytes: number }
  filters: Record<string, unknown>; limits: Record<string, number>
}
```

A schema/validator normalizes options once. Legacy pattern/path/include remains supported. Preview/range and stats fields require validation before renderer use; unknown fields do not acquire authority. Private mjs engine methods are consumed by model helper and human reader, not exposed as an unused package API.

## Task 1: Opt-in bounded Exec streaming

**Files:** modify packages/exec/src/index.ts, packages/session-executor/src/scoped-exec.ts; add packages/exec/test/stream.test.ts and covering scoped-exec tests. Preserve existing spill/exec/windows-command/enforcement/shell-promotion fixtures.

**Produces:** the exact ExecStreamRunOptions overload, byte stats/stopReason and bounded raw stdin input; existing run/capture/background/promotion APIs remain compatible.

- [ ] Write actual registered Exec red cases: Buffer chunks split inside UTF8/CRLF are forwarded unchanged; a crossing combined stdout/stderr chunk admits only remaining bytes; callback stop/error halts the owned tree and awaits close; pre-aborted signal does not perform test side effect; timeout is distinct from abort.
- [ ] Run the new test file and record the missing-contract failures before source changes.
- [ ] Implement opt-in stream collector, stop idempotence/drain, stderr admission/classifier preservation and rejection after cleanup. Add raw byte stdin mutually exclusive with legacy input; reject incompatible promotion options.
- [ ] In bounded mode create the POSIX owned process group and ensure confined wrapper children remain owned; Windows await taskkill/close without visible helper windows. Use a real small child/grandchild fixture with exact owners and failure cleanup.
- [ ] Implement explicit scoped forwarding overloads while preserving commandFor current policy/cwd. Test provider-required denial, actual confined argv, and current-policy changes; no host spawn fallback.
- [ ] Run focused exec files + shell promotion compatibility + relevant types. Freeze exact scope/hashes and hand off for review.

## Task 2: Shared search options, matcher, model helper and tools

**Files:** packages/fs-search/src/index.ts, new search-types.ts/options.ts/engine.mjs/model-runner.mjs (responsibility-specific parser modules if needed), package.json; packages/fs-search/test/*; small session-executor assembly/mount tests. Coordinator owns dependency/lock mutation once.

**Consumes:** Task1 stream overload. **Produces:** SearchQuery/SearchResult and private fixed-byte matcher; real model grep/glob use current scoped Exec and ToolExec.abortSignal.

- [ ] Write red cases through the mounted registered tools, retaining current defaults/legacy args/explicit excluded subtree convenience. Assert no-match completed, invalid regex on zero candidates, exit2 partial matches, options and --no-config behavior.
- [ ] Build schema normalization/caps, allowed-flag generation and parser tests using actual bundled rg plus small deterministic chunks: Unicode/BOM/UTF16/CRLF/trailing whitespace/Base64/multiline/PCRE2/context/literal/case. Do not substitute JS regex or raw byte offsets.
- [ ] Implement fixed Node helper launched by current scoped Exec with JSON control input<=64KiB. Enumerate through bounded rg--files without whole-tree modified sort; disclose candidate discovery and parallel-arrival ordering. Validate explicit files/directories within helper/provider authority.
- [ ] Open/read descriptors in the confined helper with shared pre-reservation of bytes,1MiB perfile/32MiB aggregate,4 live stdin children. Tag child events with private file identity. Maintain a separate shared1MiB engine raw budget and bounded pending JSON/NUL frames; outer Exec1MiB runner cap remains independent.
- [ ] Test file growth/replacement, cap versus proven EOF, simultaneous reads exhausting the last allowance, JSON amplification, split buffers, EPIPE/backpressure and all-child cleanup on limit/cancel/error. Preserve partial output and truthful counters even if terminal summary cannot arrive.
- [ ] Ensure every helper-owned rg child reaches close before helper completion; parent cancellation must reach helper and descendants. Keep both tool names and current standing policy. No model callback or arbitrary path operation outside confinement.
- [ ] Run the complete fs-search file set, model mount/current-policy/cancellation regressions and covering types; verify helper shipping inclusion. Freeze/report for independent review.

## Task 3: Pinned human search service and native ownership

**Files:** new packages/desktop-gateway/src/project-content-search.ts and search-policy/preview modules; project-files/types/host/router integration; new packages/desktop/src/main/project-content-search.ts plus IPC/shared bridge integration; backend/native tests. New files keep scan/preview/job ownership separate from large existing modules.

**Consumes:** shared query/result/options and fixed stdin engine. **Produces:** `desktop-project-content-search` capability and content-search/cancel/search-preview routes, exact project refs and bounded readonly preview. Main owns jobs; Gateway owns its search controller/child lifetime.

```ts
type ContentSearchSelection = {workspaceId:string; sessionId?:string; projectId?:string}
// Search request: selection, requestId, query:SearchQuery, optional workspaceIds.
// Cancel request: selection, requestId. Verify captured window/selection owner.
// Preview request: selection, ref:{workspaceId,path}, line, encoding, expectedRevision?.
// Search response matches extend SearchMatch with ref:{workspaceId,path};
// root summaries use actual current member labels and coverage, not new authority.
// Preview: {readonly:true,text,startLine,encoding,revision,changedSinceSearch,
//           truncated,reason?}; <=32KiB displayed text around requested line.
```

- [ ] Write red real-file cases for two roots with same.txt, root swapped to outside link before capture/during scan, leaf replacement before read, withdrawn membership at startup/return/open, and cancellation after withdrawal.
- [ ] Implement pinned directory walk retaining3000 entry/depth32 ceilings and compare pin finalPath to catalog's stored canonical path BEFORE accepting root. Read only same pinned regular file bytes and recheck containment. Aggregate candidates/bytes/results/deadline/4 workers across roots.
- [ ] Add explicit ignore/picomatch dependencies once. Load bounded pinned project ignore files with defined precedence/negation; test nested rules, ignored parent, escaped spaces, hidden files, includes/excludes and incomplete rules. UI policy is project-local; do not claim host-global engine behavior.
- [ ] Register native per-window/request job before startup; capture real runtime/subjobs. Add separate cancel RPC that uses captured ownership even after membership withdrawal. Recheck current members on start/publish/preview/open. Cancel/drain on shutdown/unmount/replacement/request errors; SDK60s timeout is not a cancel implementation.
- [ ] Create readonly raw-byte decoded previews with startLine/encoding/snapshot SHA and changed-since-search. Input limit does not allow an unbudgeted extra byte. Dirty drafts/revisions are not mutated by this route; unsupported/invalid encoding and truncated files are explicit.
- [ ] Host/router/IPC capability wiring forwards exact contracts; no duplicate model request or automatic engine inference. Close all owned search services in host/native shutdown.
- [ ] Run backend/native tests/types and current project-file/membership regressions. Freeze/report for independent review.

## Task 4: Desktop content-search UI and range navigation

**Files:** new ProjectContentSearchPane.tsx/search text helpers; ProjectExplorer/ProjectFilesPane/SourceFileEditor/editor CSS; transient ref/navigation/App/Workbench/ReviewPane integration; renderer tests. Preserve the latest approval popup and Settings-only sandbox UX.

**Consumes:** Task3 serializable routes/ref/results. **Produces:** discoverable filename/content selector, content query/options/Stop/results and one-shot exact file/range navigation.

- [ ] Write red UI cases for explicit submit, actual Stop request, stale selection/replaced query cancellation, loading/error/partial/limited metadata, honest ignore/advanced controls and unavailable capability.
- [ ] Add filename/content switch while preserving the existing filename flow. Simple controls are query, literal/regex and case; Advanced contains supported filters/context/engine/multiline/encoding/maxResults. Explicit submit avoids a subprocess per keystroke. Local result pages never imply stable filesystem cursors.
- [ ] Group matches by workspaceId/current root label; show path/line/context/truncation. Capture cancellation owner/requestId until settled, including root removal and unmount. Ignore obsolete replies without treating that as cancellation.
- [ ] Add transient navigation target with line/UTF16 range/nonce while draft key stays workspaceId/path. Reveal once per click, clamp positions to displayed text, do not move cursor on edits. Two same.txt roots and repeated same-hit navigation must open correct target.
- [ ] Keep unsaved drafts through result navigation; disclose disk-versus-draft offsets. Integrate readonly UTF16/other preview without save/revision ingestion or draft replacement; reflect startLine in gutter/range and changed-since-search notice.
- [ ] Run complete covering UI/editor/draft/navigation tests and types. No mirror pixel tests; final real-window geometry/keyboard/read-only checks belong to native acceptance. Freeze/report for review.

## Task 5: Integration, acceptance and local delivery

- [ ] Read each exact scoped handoff and independently review actual bounds/cancel/authority/partial semantics. Repair only concrete findings and re-review; no blanket refactor.
- [ ] Verify model+CodeMode actual mount receives updated grep/glob schema/cancellation/current-policy without mutating registry authority or changing CPU budgets. Add meaningful real mount regressions.
- [ ] Build a distinct portable label `release-search-optimization-2026-10-03`; prove private model helper/fixed engine/rg/dependencies/assets actually shipped and resolve under Electron Node mode.
- [ ] Visibly run copied new app using owned config/userData/two-root files and zero remote calls. Verify content hits, options, Stop with no surviving child, quotas/partial, real line/range and unsaved drafts, UTF16 readonly preview, root withdrawal, narrow/wide geometry and preservation of approval/window controls. Capture screenshots/actual RPC/output/process IDLE proof.
- [ ] Once all owners/source idle, run fresh `pnpm verify:all` alone and record actual all-project population/types/E2E/reachability. Do not substitute a prefix or prior4322 baseline.
- [ ] Update `docs/audit/2026-10-03-search-optimization-acceptance.md` and prior research status/design pointers with actual results/limits/artifact hashes, no invented throughput multiplier.
- [ ] Stage exact task file set excluding original configuration, inspect staged diff check exit0 before local source/doc commits, and report final status/protectedSHA/commit/artifact/evidence. No push or PR is requested.

## Ownership and checkpoints

Initial audits are read-only and complete. After this plan, coordinator assigns disjoint runner/tools, gateway/native and renderer ownership with exact contract handshakes. Dependencies/lock and central adapters have one named owner at a time. No parallel source edits to the same file, and no native/build/heavy tests overlap the final all-project gate. Progress survives interruption in `.superpowers/sdd/2026-10-03-search-optimization/progress.md`.
