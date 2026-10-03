# IH Search Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement task-by-task. The user authorized ongoing development and parallel agents; disjoint ownership below takes precedence over a serial worker preference. Do not ask the execution-choice question again.

**Goal:** Complete the approved grep/ripgrep improvements and human multi-root content-search/navigation with genuine cancellation, bounds and honest partial results.

**Architecture:** Opt-in streaming extends sandbox-aware Exec. Model enumeration, fixed no-spawn descriptor readers and fixed rg stdin matchers run as first-generation siblings through current scoped Exec. Human search uses current project binding and pinned bytes, with a separate readonly external reference scope. Both use shared query/result/engine contracts; GUI navigation retains editor/draft identity.

**Tech Stack:** Node >=22.18, TypeScript, private shipped ESM helpers, actual bundled rg15.0.0/PCRE2, React/Electron, existing SDK v3, Vitest/Playwright. Explicit `ignore` and `picomatch` dependencies for bounded pinned project policy; no arbitrary flags or new model alias.

**Spec:** [approved design](../specs/2026-10-03-search-optimization-design.md).

## Implementation decisions

- Latest user policy: external reference projects may be read, but not modified. Dedicated absolute referencePath and external-read/external-preview are read-only, never add workspace/write roots or use absolute ProjectFileRef.path; project aliases resolving outside return readonly/external. Save retains strict original canonical write-root/actual edit-handle containment. Revise earlier outside-read-denial fixtures to actual successful readonly reads plus unchanged bytes and failed outside writes; identity races/nonregular files still fail. Renderer reference view cannot create editable drafts or save.
- Actual confined Windows helper cannot launch rg descendants. Task2 orchestrates first-generation enumeration rg, no-spawn fixed Node fd reader and fixed rg stdin matcher through the same current scoped Exec. The parent does no filesystem stat/read; no provider relaxation or host fallback. Content relay counts bounded input32MiB/perfile1MiB, while enumeration/matcher raw JSON and runner control/result caps stay separately1MiB. Current policy applies to every sibling. Readers reserve allowance before awaiting and use at most four workers; the model matcher is serialized to share the existing stdout/stderr stream allowance. Human matchers use at most four fixed children.
- True Latin1 can expand a physical1MiB snapshot to UTF8 stdin of at most2MiB. Exec's raw stdin transport bound supports this deterministic derivative and rejects the next byte; physical/read/result/raw limits remain unchanged. The model shell schema gains no raw input option.
- CodeMode runtime.ts may be minimally changed only for actual owned stop/drain completion, with a failing regression; existing CPU/authority constraints remain.

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
  revision?: string; encoding?: string; readonly?: boolean; external?: boolean
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

A schema/validator normalizes options once. Legacy pattern/path/include remains supported. Preview/range and stats fields require validation before renderer use; unknown fields do not acquire authority. The used private engine export serves the model transport and human reader. Lines are one based; columns are zero based UTF16 code units with exclusive ends. Embedded U+FEFF remains visible; only a whole-file BOM is stripped.

## Task 1: Opt-in bounded Exec streaming

**Files:** modify packages/exec/src/index.ts, packages/session-executor/src/scoped-exec.ts; add packages/exec/test/stream.test.ts and covering scoped-exec tests. Preserve existing spill/exec/windows-command/enforcement/shell-promotion fixtures.

**Produces:** the exact ExecStreamRunOptions overload, byte stats/stopReason and bounded raw stdin input; existing run/capture/background/promotion APIs remain compatible.

- [x] Write actual registered Exec red cases: Buffer chunks split inside UTF8/CRLF are forwarded unchanged; a crossing combined stdout/stderr chunk admits only remaining bytes; callback stop/error halts the owned tree and awaits close; pre-aborted signal does not perform test side effect; timeout is distinct from abort.
- [x] Run the new test file and record the missing-contract failures before source changes.
- [x] Implement opt-in stream collector, stop idempotence/drain, stderr admission/classifier preservation and rejection after cleanup. Add raw byte stdin mutually exclusive with legacy input; reject incompatible promotion options.
- [x] In bounded mode create the POSIX owned process group and ensure confined wrapper children remain owned; Windows await taskkill/close without visible helper windows. Use a real small child/grandchild fixture with exact owners and failure cleanup.
- [x] Implement explicit scoped forwarding overloads while preserving commandFor current policy/cwd. Test provider-required denial, actual confined argv, and current-policy changes; no host spawn fallback.
- [x] Run focused exec files + shell promotion compatibility + relevant types. Freeze exact scope/hashes and hand off for review.

## Task 2: Shared search options, matcher, model helper and tools

**Files:** packages/fs-search/src/index.ts, search-types.ts, options.ts/options.mjs, engine.mjs, model-search.ts, fixed reader.mjs and declarations, package.json; packages/fs-search/test/*; session-executor scoped/mount tests; code-mode runtime stop-await correction. Coordinator owns dependency/lock mutation and build-dist reader asset copying.

**Consumes:** Task1 stream overload. **Produces:** SearchQuery/SearchResult and private fixed-byte matcher; real model grep/glob use current scoped Exec and ToolExec.abortSignal.

- [x] Write red cases through the mounted registered tools, retaining current defaults/legacy args/explicit excluded subtree convenience. Assert no-match completed, invalid regex on zero candidates, exit2 partial matches, options and --no-config behavior.
- [x] Build schema normalization/caps, allowed-flag generation and parser tests using actual bundled rg plus small deterministic chunks: Unicode/BOM/UTF16/CRLF/trailing whitespace/Base64/multiline/PCRE2/context/literal/case. Do not substitute JS regex or raw byte offsets.
- [x] Implement first-generation bounded rg--files through scoped Exec without whole-tree modified sorting; use a fixed no-spawn Node reader with bounded JSON control input. Preserve explicit path conveniences under current provider policy and disclose discovery ordering.
- [x] Open/read descriptors only in confined reader helpers, with shared reservations before awaiting,1MiB/file and32MiB aggregate. Relay bytes to fixed scoped rg stdin, serialized for the shared raw stdout/stderr allowance. Private source task identity maps every record; enumeration/matcher raw1MiB and runner control/result raw1MiB remain independent from file relay.
- [x] Test file growth/replacement, cap versus proven EOF, simultaneous reads exhausting the last allowance, JSON amplification, split buffers, EPIPE/backpressure and all-child cleanup on limit/cancel/error. Preserve partial output and truthful counters even if terminal summary cannot arrive.
- [x] Await every separately owned scoped command on stop/limit/error; the reader starts no descendants. Preserve both tool names and current standing policy, with no model-side filesystem callback outside confinement.
- [x] Run the complete fs-search file set, model mount/current-policy/cancellation regressions and covering types; verify helper shipping inclusion. Freeze/report for independent review.

## Task 3: Pinned human search service and native ownership

**Files:** new packages/desktop-gateway/src/project-content-search.ts and search-policy/preview modules; project-files/types/host/router integration; new packages/desktop/src/main/project-content-search.ts plus IPC/shared bridge integration; backend/native tests. New files keep scan/preview/job ownership separate from large existing modules.

**Consumes:** shared query/result/options and fixed stdin engine. **Produces:** `desktop-project-content-search` capability and content-search/cancel/search-preview routes, exact project refs and bounded readonly preview. Main owns jobs; Gateway owns its search controller/child lifetime.

```ts
type ContentSearchSelection = {workspaceId:string; sessionId?:string; projectId?:string}
// Search request: selection, requestId, query:SearchQuery, optional workspaceIds
// OR referencePath:absolute. These scopes are mutually exclusive.
// Cancel request: selection, requestId. Verify captured window/selection owner.
// Preview request: selection, ref:{workspaceId,path}, line, encoding,
// expectedRevision?, requestId?. External read/preview uses top-level absolute path.
// Search response matches carry project ref:{workspaceId,path} OR
// reference:{path:absolute,readonly:true}, readonly:true, external:true.
// root summaries use actual current member labels and coverage, not new authority.
// Preview: {readonly:true,text,startLine,encoding,revision,changedSinceSearch,
//           truncated,reason?,external?}; <=32KiB UTF8 and UTF16 text.
```

- [x] Write real-file red/green cases for two roots, intended outside aliases/reference files read readonly with failed outside saves, unexpected identity replacement before reading, withdrawn membership at startup/return/open, and cancellation after withdrawal.
- [x] Retain3000 entry/depth32 pinned traversal and compare each opened read handle to the observed target before open. Intended external reads are marked readonly; SAVE separately requires the original trusted canonical write root and actual edit-handle containment. Aggregate budgets/deadline and reserve four reads across roots.
- [x] Add explicit ignore/picomatch dependencies once. Load bounded pinned project ignore files with defined precedence/negation; test nested rules, ignored parent, escaped spaces, hidden files, includes/excludes and incomplete rules. UI policy is project-local; do not claim host-global engine behavior.
- [x] Register native search/read/preview jobs before startup and retain captured runtime/subjob handles. Separate cancel uses original owner, including optional client viewer requestId. Current membership is checked before publication/open. Project/session ownership mutations drain affected captures before ACK, including an already-stopped job still draining; unchanged scopes continue. Shutdown/unmount/replacement/errors cancel and drain.
- [x] Create centered readonly decoded previews with startLine/encoding/snapshot SHA/change/truncation. No extra input probe byte is read. Invalid/incomplete bytes disclose replacement decoding even in a nontruncated view; dirty drafts/revisions are not mutated.
- [x] Host/router/IPC capability wiring forwards exact contracts; no duplicate model request or automatic engine inference. Close all owned search services in host/native shutdown.
- [x] Run backend/native tests/types and current project-file/membership regressions. Freeze/report for independent review.

## Task 4: Desktop content-search UI and range navigation

**Files:** new ProjectContentSearchPane.tsx/search text helpers; ProjectExplorer/ProjectFilesPane/SourceFileEditor/editor CSS; transient ref/navigation/App/Workbench/ReviewPane integration; renderer tests. Preserve the latest approval popup and Settings-only sandbox UX.

**Consumes:** Task3 serializable routes/ref/results. **Produces:** discoverable filename/content selector, content query/options/Stop/results and one-shot exact file/range navigation.

- [x] Write red UI cases for explicit submit, actual Stop request, stale selection/replaced query cancellation, loading/error/partial/limited metadata, honest ignore/advanced controls and unavailable capability.
- [x] Add filename/content switch while preserving the existing filename flow. Simple controls are query, literal/regex and case; Advanced contains supported filters/context/engine/multiline/encoding/maxResults. Explicit submit avoids a subprocess per keystroke. Local result pages never imply stable filesystem cursors.
- [x] Group matches by workspaceId/current root label; show path/line/context/truncation. Capture cancellation owner/requestId until settled, including root removal and unmount. Ignore obsolete replies without treating that as cancellation.
- [x] Add transient navigation target with line/UTF16 range/nonce while draft key stays workspaceId/path. Reveal once per click, clamp positions to displayed text, do not move cursor on edits. Two same.txt roots and repeated same-hit navigation must open correct target.
- [x] Preserve unsaved drafts and disclose disk offsets. UTF16/other previews and separate external reference viewers are readonly with no save/draft ingestion. Reflect startLine/change/warning metadata. Viewer UUID cancellation survives selection changes, and current root ID/path tokens invalidate stale root caches.
- [x] Run complete covering UI/editor/draft/navigation tests and types. No mirror pixel tests; final real-window geometry/keyboard/read-only checks belong to native acceptance. Freeze/report for review.

## Task 5: Integration, acceptance and local delivery

- [x] Read each exact scoped handoff and independently review actual bounds/cancel/authority/partial semantics. Repair only concrete findings and re-review; no blanket refactor.
- [x] Verify model+CodeMode actual mount receives updated grep/glob schema/cancellation/current-policy without mutating registry authority or changing CPU budgets. Add meaningful real mount regressions.
- [x] Actual mixed/only workspace-write Code Mode fixture uses20 files×12rows=240 nested matches; grouping emits ten references in less than1000 bytes, while the full nested trace remains owned. Both human and code_wait stop await real producer termination with no follow-on call/resurrection. No privileged alternate tool, global retention or CPU budget change; no token-saving percentage is claimed.
- [x] Build a distinct portable label `release-search-optimization-2026-10-03`; prove private model helper/fixed engine/rg/dependencies/assets actually shipped and resolve under Electron Node mode.
- [x] Visibly run copied new app using owned config/userData/two-root files and zero remote calls. Verify content hits, options, Stop with no surviving child, quotas/partial, real line/range and unsaved drafts, UTF16 readonly preview, root withdrawal, narrow/wide geometry and preservation of approval/window controls. Capture screenshots/actual RPC/output/process IDLE proof.
- [x] Once all owners/source idle, run fresh `pnpm verify:all` alone and record actual all-project population/types/E2E/reachability. Do not substitute a prefix or prior4322 baseline.
- [x] Update `docs/audit/2026-10-03-search-optimization-acceptance.md` and prior research status/design pointers with actual results/limits/artifact hashes, no invented throughput multiplier.
- [x] Stage exact task file set excluding original configuration, inspect staged diff check exit0 before local source/doc commits, and report final status/protectedSHA/commit/artifact/evidence. No push or PR is requested.

## Ownership and checkpoints

Initial audits are read-only and complete. After this plan, coordinator assigns disjoint runner/tools, gateway/native and renderer ownership with exact contract handshakes. Dependencies/lock and central adapters have one named owner at a time. No parallel source edits to the same file, and no native/build/heavy tests overlap the final all-project gate. Progress survives interruption in `.superpowers/sdd/2026-10-03-search-optimization/progress.md`.
