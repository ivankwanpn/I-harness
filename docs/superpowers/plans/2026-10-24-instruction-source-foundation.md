# IA Scoped Instruction Source Foundation Implementation Plan

> Use subagent-driven-development with a fresh GPT6Astra implementer and independent review. Root approved this scoped implementation on 2026-10-24 under the integrated delivery plan. Continuous execution is already authorized. Design/source baseline is41ad97d3; record actual implementation BASE at dispatch. This plan itself runs no tests.

Normative: [instruction design](../specs/2026-10-13-v0.1.13-instruction-context-design.md), [mutation rulings](../../refactoring/v0.1.13-instruction-mutation-gates.md), [integrated rebase](../../research/v0.1.13-integrated-20261023/instruction-rebase.md), [integrated delivery](2026-10-23-v0.1.13-integrated-delivery.md). Only IA is authorized by this implementation packet. IB observation production/settings, IC current-context/request, ID child wiring, IE/IF mutation/Code Mode and UI remain later packets. No implementation of request acknowledgment, execution permission, shared producer cancellation or model calls belongs here.

## Deliverable and ownership

One implementer owns only `packages/instructions/src/` and `packages/instructions/test/`. Preserve current package dependencies, package public exports and production callers. New modules are internal staging imported directly by package tests; promote their public exports only with the actual IB/IC caller, never add fake production consumers to satisfy reachability.

| File | Responsibility |
|---|---|
| existing `src/{index,files}.ts` | Keep existing exported legacy APIs and behavior; add only an honest legacy/staging comment if useful. No second shipping path and no covert caller switch. |
| new `src/contracts.ts` | DTOs, observation port, exact constructor/service API below. No filesystem or Session imports. |
| new `src/discovery.ts` | Explicit roots/globals, bounded Git/root discovery, candidate slots, lexical/canonical identity and alias scopes. |
| new `src/reader.ts` | Bounded async open/stat/read/recheck/close; UTF8-safe prefix, file identity and content digest. |
| new `src/snapshot.ts` | Deterministic render, global24k budget, dependency/semantic fingerprints, frozen snapshot. |
| new `src/service.ts` | Activation set, cache, injected observation reconciliation, dirty-generation loop, subscriptions and joined close. |
| new `test/helpers/instruction-fixture.ts` | Owned temp roots, real files, controlled observation port, held-event/reader instrumentation helpers. |
| new `test/{discovery,limits,dependencies,source-lifecycle}.test.ts` | Causal cases below; retain existing `instructions.test.ts`. |

Do not create empty discovery/snapshot subdirectories or split tiny helpers merely to match old proposed layout. A functional cohesive module is sufficient; extract only if implementation needs a separately owned/testable unit. No assembly/settings/fs-watch/core-session/provider/package-root edits.

## Approved internal API

All paths are absolute host-supplied paths. Runtime validate, copy and deeply freeze data input/output records; readonly TS types alone are insufficient. Root ruling IA3: the live observation port/lease is a capability, not a JSON data record. Capture original method references and receiver without freezing or cloning its mutable owner state, calling getters, or adopting later method replacement. Scope/targets/events/snapshots are validated detached data. Close must join active reads even if lease close rejects and preserve the cleanup failure; no remaining handles are silently skipped. Invalid constructor arguments throw `InstructionConfigurationError` with `code='INSTRUCTIONS_INVALID_CONFIG'`; ordinary filesystem/source failures become bounded snapshot status, not an unhandled service crash.

```ts
type InstructionKind = 'AGENTS.md' | 'CLAUDE.md'
type SourceState = 'loaded' | 'shadowed' | 'truncated' | 'unreadable' | 'outside-scope'
type SourceReliability = 'ready' | 'pending' | 'unavailable'
type CandidatePresence = 'absent' | 'regular' | 'invalid' | 'unreadable'
interface InstructionScope {
  readonly cwd: string
  readonly roots: readonly string[]
  readonly globalSources: readonly string[]
  readonly enabled: boolean
  readonly maxBytes: number // nonnegative safe integer; host default is24000
}
interface InstructionTarget { readonly path: string; readonly kind: 'file' | 'directory' }
interface InstructionSourceStatus {
  readonly path: string
  readonly scopeRoot: string
  readonly scopeDirectory: string
  readonly kind: InstructionKind
  readonly state: SourceState
  readonly bytes: number // exact rendered contribution including its header
  readonly contentHash?: string // SHA256 of bytes actually read, not whole huge file
  readonly hashScope?: 'full' | 'prefix'
  readonly message?: string // <=512 UTF8 bytes, no source body
}
interface InstructionCandidateDependency {
  readonly slotId: string
  readonly path: string // lexical, normalized absolute candidate path
  readonly scopeRoot: string
  readonly scopeDirectory: string
  readonly canonicalPath?: string // real file path only when resolution succeeded
  readonly kind: InstructionKind
  readonly presence: CandidatePresence
  readonly selected: boolean
  readonly contentHash?: string
  readonly hashScope?: 'full' | 'prefix'
  readonly observedSize?: number
  readonly reliability: SourceReliability
  readonly pendingIds: readonly string[] // sorted opaque observation IDs
  readonly fingerprint: string
}
interface InstructionApplicableDependencies {
  readonly target: InstructionTarget
  readonly scopeKey: string // authorized root+Git boundary+ordered globals identity
  readonly candidateSlotIds: readonly string[] // broad-to-narrow, includes absent slots
  readonly fingerprint: string
  readonly reliability: SourceReliability
  readonly complete: boolean // false for truncation/limit/invalid boundary/read failure
}
interface InstructionSnapshot {
  readonly revision: number // local monotone diagnostic revision
  readonly fingerprint: string // semantic text + scope identity; no observation counters
  readonly text: string
  readonly bytes: number
  readonly sources: readonly InstructionSourceStatus[]
  readonly candidates: readonly InstructionCandidateDependency[]
  readonly applicable: readonly InstructionApplicableDependencies[]
  readonly reliability: SourceReliability
  readonly complete: boolean
}
interface InstructionWatchInterest {
  readonly directory: string // lexical parent to observe missing candidates/aliases
  readonly candidates: readonly string[] // candidate paths and .git boundary markers
}
interface InstructionPendingWrite { readonly id: string; readonly paths: readonly string[] }
interface InstructionObservationState {
  readonly revision: number // monotone within one injected port lifetime
  readonly available: boolean
  readonly pending: readonly InstructionPendingWrite[] // complete current pending set
}
interface InstructionObservationEvent extends InstructionObservationState {
  readonly kind: 'changed' | 'reset' | 'availability' | 'pending'
  readonly paths: readonly string[] // changed lexical/canonical paths; reset may be []
}
interface InstructionObservationLease {
  update(interests: readonly InstructionWatchInterest[]): Promise<InstructionObservationState>
  close(): Promise<void>
}
interface InstructionObservationPort {
  subscribe(listener: (event: InstructionObservationEvent) => void): InstructionObservationLease
}
interface InstructionService {
  prepare(targets: readonly InstructionTarget[]): Promise<InstructionSnapshot>
  snapshot(): InstructionSnapshot // frozen memory-only read
  invalidate(paths?: readonly string[]): void
  subscribe(listener: () => void): () => void
  close(): Promise<void>
}
interface InstructionServiceOptions {
  readonly scope: InstructionScope
  readonly observation: InstructionObservationPort
}
function createInstructionService(options: InstructionServiceOptions): InstructionService
```

Deliberate signature rebase: `prepare` accepts host-normalized target descriptors rather than guessing whether a nonexistent path is a file or directory. This removes an actual ambiguity in the old `prepare(paths)` sketch. Later native descriptors map directly; instructions_get must normalize/validate its arguments through the host before calling it. No `mode`, authorization, model fingerprint acknowledgment or write allowance is accepted by this source service.

Scope is immutable for this service lifetime. Policy/root membership changes create a replacement service and close the old one through the future Session owner; IA does not add a second mutable settings/membership owner. Before replacement settles, later consumers must treat old closed service as unavailable. `globalSources` never defaults to home; an empty array means none. Host construction of native defaults/migration belongs to IB.

## Discovery, identity, limits and rendering decisions

1. `prepare([])` activates cwd as a directory; subsequent prepare adds target scopes monotonically for this service lifetime. Deduplicate by lexical normalized target kind/path; same real file through different authorized lexical scopes retains both applicability entries. Source body bytes can share a canonical cache. Initial snapshot revision0 has empty text/sources and unavailable/incomplete unless disabled/zero, which is ready/complete empty. No filesystem I/O during construction.
2. Validate absolute cwd/roots/globalSources, unique normalized roots and finite integer maxBytes. Reject invalid configuration rather than silently clamp. Roots empty is allowed (global-only); cwd/targets outside authorized roots yield bounded outside-scope diagnostics and no local body reads. Target kind is host input, not authority.
3. For each target pick the narrowest authorized lexical root containing it, then reject realpath escape outside that root. Bound ancestor walk at128 directories and never walk beyond that root. Find nearest confirmed Git marker within this walk; `.git` directory is supported, as is a regular `.git` file with a bounded<=4096-byte single `gitdir:` path to an existing directory. Such pointer metadata is boundary detection only, never authority to read instruction content outside the root. Malformed/unreadable marker makes boundary incomplete/unavailable instead of silently widening. If no marker exists within the authorized root, the root itself is boundary. A root narrower than a containing Git checkout remains the boundary.
4. For a nonexistent target/candidate, resolve its nearest existing ancestor canonically and append missing lexical components; retain distinct candidate slot identity without claiming a present canonical file. Recheck canonical containment after open before reading. Recheck source path/file identity after awaited reads. Observed source replacement during a read invalidates the build; no claim of filesystem atomicity against unobserved external writers.
5. Candidate slots count BOTH AGENTS and CLAUDE, including absence and shadowed entries; limit256 unique lexical policy slots across globals/ancestors/activated targets before content reading. Canonical duplicate bodies do not erase distinct lexical applicability slots. Overflow yields complete:false, bounded diagnostic and unavailable affected dependency view; no unbounded sources/errors arrays. Max depth128 excludes file content. The renderer never pretends capped discovery was complete.
6. GlobalSources is an ordered allowlist of exact paths named AGENTS.md/CLAUDE.md. Group explicitly listed siblings in the same lexical directory at the first listed position; AGENTS wins over CLAUDE within that group. **Do not probe an unlisted sibling.** Thus native default host supplies both paths; a migrated exact CLAUDE path remains exact unless configuration explicitly adds AGENTS. This preserves explicit global authority and records priority absence for configured pairs. Global paths authorize only the named file; a symlink target outside its lexical parent is outside-scope. Global scopes are labelled global, with scopeRoot/scopeDirectory set to that configured parent.
7. Local directories always create both slots. AGENTS absent permits CLAUDE; empty regular AGENTS wins. Invalid/unreadable AGENTS wins precedence as an error and prevents fallback. Shadowed content is not read. Absent slots appear only in candidates/applicable, not a fictitious “loaded” source row.
8. SlotId is SHA256 over versioned canonical JSON of source class(local/global), normalized lexical root/directory, filename and applicable global-group identity. Windows case folding is for actual case-insensitive identity, not blind POSIX lowercase: verify canonical paths with real temporary Windows files and keep display casing. Component boundaries prevent prefix confusion. Changing global order changes relevant scopeKey; unrelated target activation does not.
9. Candidate fingerprint hashes slot identity, canonical identity/presence, selection, content hash/hashScope/observedSize and reliability/pendingIds. Applicable fingerprint hashes scopeKey plus ordered candidate fingerprints. Do not include the port’s global observation revision, local snapshot revision, wall time or unrelated source dependencies. Absent AGENTS and present fallback are both dependencies; adding AGENTS changes the view even if CLAUDE bytes stay identical. Shadowed file content need not be read, but shadowed slot identity/presence still changes on observed writes.
10. Snapshot semantic fingerprint hashes rendered text and its ordered effective scope labels only. It stays unchanged for irrelevant events/diagnostic-only changes; snapshot revision increments when any published DTO field changes. Reliability/dependency changes may increment revision without changing model text fingerprint. Actual request freshness must later consume the applicable dependencies as well as semantic text; fingerprint alone is expressly not an execution permit.
11. Async reader opens only selected regular candidates. Use FileHandle.read with a bounded byte buffer; never readFile(full). Consume at most remaining rendered budget plus UTF8 boundary/lookahead allowance<=4 bytes per read source; headers/separators/marker are reserved before content reads. Individual read buffers are capped at64KiB even for an explicitly configured larger budget. No bytes need be read for a source with no remaining content allowance. Hash full bytes only when EOF is confirmed; otherwise hashScope:prefix. observedSize is stat metadata, not evidence of whole-file hashing. Cache must never use aggregate maxmtime/sum-size. The24000 figure is the approved default, not an invented configuration ceiling.
12. Render deterministic headers containing lexical source/scope, then content, broad-to-narrow. UTF8-safe truncation never splits a code point; Buffer.byteLength(text,'utf8') equals snapshot.bytes<=maxBytes. Marker `\n(truncated)` and headers count. If budget cannot fit a header/marker, emit only the valid bounded prefix that fits, report truncation in metadata; never exceed maxBytes to display a warning. Zero/disabled prepare does zero filesystem and observation I/O, returns empty ready/complete state. Truncated dependencies are complete:false but can remain reliability:ready (read evidence is current); later mutation consumers must not equate reliable with complete.
13. Transient read failure may reuse cached last-known-good rendered text with unreadable state, reliability:unavailable and complete:false. Deletion, canonical escape or revoked lifetime never reuse stale body as effective rules. Source bodies are not copied into diagnostic messages. No Markdown imports or foreign globals are expanded.

Root ruling IA1 approves host-normalized file/directory descriptors to avoid guessing nonexistent targets. IA2 approves exact configured globals and pairing only explicitly configured siblings; IB supplies both native default candidates and preserves migrated exact selections. Neither labels nor descriptors grant source authority.

## Exact observation and lifecycle semantics

- The injected port is required, with no built-in watcher/fallback. First enabled prepare synchronously calls subscribe before any disk await. update replaces the lease’s interests and resolves only when those interests are observed and all pre-resolution events are accounted for. It returns complete current availability/pending state. Initial/new-target discovery first enumerates lexical candidate and .git marker interests up to the authorized root, then awaits update, then repeats discovery/read under that established coverage; pre-watch discovery values are never published as current. This closes creation/replacement during watch installation. Keep .git interests above a found Git boundary within the allowed root so boundary replacement is observable. Later IB/E7 supplies this real guarantee; IA tests supply a deterministic implementation.
- Subscribe listener must not throw into the observation owner. Port state revision is a finite monotone safe integer. Reject decreasing/contradictory same-revision state as unavailable; duplicate identical revision is harmless. Higher revision with irrelevant paths only updates observed cursor, never all dependency fingerprints.
- A changed event invalidates intersecting candidate slots by exact candidate, observed parent replacement, canonical alias or boundary metadata. Missing preferred candidate creation is therefore caught. reset dirties all active dependencies. available:false makes affected service views unavailable until update/reset reconciliation succeeds. Pending set deltas dirty only overlapping dependency views; unrelated tokens do not poison independent scopes. Before returning from an observation/invalidate callback, synchronously publish the affected in-memory dependency views as pending or unavailable/incomplete and notify subscribers; snapshot() must not continue to report ready stale evidence while waiting for prepare. This invalidation publication performs no I/O and does not change semantic text unless the source is known removed/outside-scope.
- Pending IDs are observation only. Service never creates/releases native leases, allows a writer to bypass itself, cancels a producer or waits indefinitely for pending writes. prepare returns pending reliability when relevant known writes exist. A later state removing the token dirties those paths even if the write failed; the next prepare re-reads actual disk. IA does not implement mutation permission.
- Every observation/invalidate increments a private dirty generation for affected slots synchronously. prepare serializes one build; concurrent calls add targets before awaiting the shared/requeued work. At capture, copy dirty generation/pending state; after each awaited read and before publication validate relevant generation. Changes during read force another build, up to3 consecutive invalidated builds; then publish flagged unavailable/incomplete with retained safe text, keep dirty for next prepare. This bound avoids starvation; it does not clear unprocessed dirtiness.
- snapshot() does no I/O. invalidate(paths) does no I/O; absent paths means all active slots. Subscribers receive publication/reliability-change notification, never source text payload, and must inspect snapshot(); deduplicate unchanged published DTOs. Calling unsubscribe twice is harmless. Listener failures are isolated.
- close is idempotent: synchronously fence new prepare/invalidate, publish unavailable/incomplete empty effective text, detach listeners from external events, close observation lease once, join active bounded reads and close file handles. prepare after close rejects `code='INSTRUCTIONS_CLOSED'`; already-running prepare also rejects closed rather than returning a trustworthy stale snapshot. snapshot remains readable final closed state; subscribe after close returns no-op. Do not cancel external native work.
- Cache is per service for IA, keyed by canonical identity + captured candidate dependency evidence. An unchanged clean prepare reuses bytes with zero stat/read; changed slots re-read even when size and mtime are identical. IA does not introduce a process-global cache registry; later one source owner may share physical reads without sharing Session active target/ack state.

### Task 1: Scoped instruction source foundation and causal qualification

1. **Contract/discovery RED first.** Add fixture helper with short mkdtemp-owned Windows roots and explicit observation injection. Tests import the intended internal module; initial module scaffolding may compile, but meaningful RED must exercise wrong policy/bounds, not just missing symbols. Preserve causal failing receipts at exact source. Implement discovery/identity and inspect output manually.
2. **Reader/render/cache RED→GREEN.** Use real files, counted FileHandle.read/stat/open spy wrappers in tests (restored after each), and controlled held read promises. Production constructor has no test-only I/O callback. Verify bounded requested read lengths and actual reads, not merely short final strings. Implement reader and snapshot.
3. **Service/dependency/lifecycle RED→GREEN.** Controlled port emits changes/pending/reset while real filesystem content changes. Implement dirty loop, cache invalidation, applicability and close. Include genuinely unchanged negative controls.
4. **Package gate and fresh review.** Run only stated instructions tests/typecheck plus diff audit, with bounded workers and isolated test home. Reviewer inspects complete changed package range and controls; root accepts IA foundation only. No provider/assembly/release completion claim.

| Test file | Required positive and negative controls |
|---|---|
| discovery.test.ts | AGENTS-only, CLAUDE-only, both, empty AGENTS, invalid directory candidate no fallback; broad→narrow rules; cwd/target outside root; narrower root; noGit; genuine .git directory and worktree .git file; malformed marker; disjoint authorized roots; sibling scope not global. |
| discovery.test.ts | Explicit global pair winner/missing preferred; exact CLAUDE-only allowlist does not discover sibling AGENTS; configured global order/dedupe; ambient HOME/.claude/.codex sentinels never read; scoped canonical aliases and Windows junction escape; case/separator equivalence without merging distinct scoped targets. |
| limits.test.ts | CJK/emoji boundary for budgets0,1,marker/header thresholds and24000; real multi-MiB file proves read calls bounded; headers/marker exact bytes; no full-file hash claim for truncation; zero/disabled constructor/prepare/snapshot cause no filesystem or observation calls;256slot and128depth boundaries, finite diagnostics. |
| dependencies.test.ts | Same size+same mtime rewrite followed by event changes rendered bytes; clean repeated prepare causes zero stat/read; add absent AGENTS shadows CLAUDE; unlink reactivates fallback; same-text winner change alters dependencies; unrelated root event/activation leaves prior target fingerprint stable when shared render budget remains sufficient. Creation during initial/new-target watch installation is observed by the mandatory post-ready reconciliation. |
| dependencies.test.ts | Pending relevant token immediately invalidates reliable view; second consumer cannot treat it ready; unrelated token leaves independent view ready; settle after successful/failed/partial disk write re-reads actual outcome; reset/recovery performs one reconciliation, stale/contradictory revisions fail unavailable. |
| source-lifecycle.test.ts | Hold read, change source+emit, release: publish final new bytes, never obsolete reliable snapshot; repeated invalidation reaches bounded unavailable with dirty retained; concurrent prepares union targets; close during held read joins/rejects and closes handles/lease once; late event cannot resurrect; subscriber throws/duplicate unsubscribe; transient read failure flagged LKG then recovery, deletion/escape clears. |

On Windows, use real junctions where permitted; permissions-based unreadable tests may use controlled open EACCES because Windows ACL behavior differs, but keep an actual invalid-directory candidate control. A platform case cannot silently skip while reporting coverage: record explicit unavailable fixture capability and retain it as acceptance debt. Test cleanup validates exact resolved fixture root remains under owned temp parent before recursive Remove-Item/rm; never remove a computed unvalidated path.

## Commands and review gate

Run from the implementation worktree after product authorization, sequentially. Use a newly created short fixture-owned path for IH_CONFIG_DIR and clean it only through validated ownership. Existing legacy tests can discover ambient home; their results remain explicitly legacy and must not be misrepresented as source-service isolation. New service fixtures use only explicit paths.

```powershell
pnpm exec vitest run packages/instructions/test/discovery.test.ts packages/instructions/test/limits.test.ts packages/instructions/test/dependencies.test.ts packages/instructions/test/source-lifecycle.test.ts --maxWorkers=2 --minWorkers=1 --no-file-parallelism
pnpm --filter @i-harness/instructions test -- --maxWorkers=2 --minWorkers=1 --no-file-parallelism
pnpm --filter @i-harness/instructions typecheck
git diff --check
git diff --name-only
```

Before each RED/GREEN/gate receipt record Git HEAD, dirty diff identity, exact changed test/source hashes and command/exit. Reviewer confirms no files outside instructions changed, no dependency or runtime callers switched, public legacy behavior preserved, no full reads/unbounded walks/polling, immutable DTOs, causal absence/priority invalidation and close/pending races. Public unreachable staging exports must not be added; no monorepo gate waiver/reseed. If normal instructions suite encounters an existing ambient legacy failure, preserve exact failure and isolate its cause; do not weaken new isolation checks or claim package pass.

Root self-review accepted this exact API/observation contract and the IA1–IA3 clarifications; one fresh implementer and independent review are required. IA’s output is a tested internal source foundation only. IB must provide the real shared observation/migration owner; IC/ID must wire the single service to actual current request/child owners before any user-facing instruction-support claim.
