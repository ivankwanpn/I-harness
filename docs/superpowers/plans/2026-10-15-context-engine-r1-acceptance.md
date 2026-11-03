# ContextEngine R1B durable acceptance and provenance implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task as directed by root. One product writer; root supplies fresh independent review. Do not spawn agents from this task.

**Goal:** Persist explicit accepted model exchanges and truthful input provenance, with format3 migration, durable pre-effect acceptance and seed-safe recovery across shipping root/child paths.

**Architecture:** Keep R1A's single core-session semantic projector and current LLMMessage/native sidecars. A non-ignorable semantics fence separates legacy inference from explicit acceptance; existing persistence/execution owners validate and flush records, using derived metadata indexes without a second raw log. All production writer/reader/seed/provenance changes are one atomic review unit, with optional internal commits before final review.

**Tech Stack:** Existing TypeScript, Node, Vitest, workspace pnpm; JSONL persistence only. No added dependency, backend or adapter rewrite.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-r1-contracts.md`, approved redesign/framework and overlap map. This plan incorporates subsequent root rulings; it supersedes any earlier standalone-human default or constructor-fence suggestion.

## Global Constraints

- Work only D:/I-harness-main on the root-selected reviewed R1A HEAD. Root fixes baseline SHA in dispatch after R1A fix gate. Record actual `git rev-parse HEAD` before work; do not read partially written R1A as a fresh baseline.
- Single product writer; no recursive agents, live providers/accounts, install, branch/worktree switching, push/merge/publish, broad unrelated suites or reachability reseed. Root conducts fresh spec/quality review before continuing R1C.
- Product version stays0.1.13-rc.1; session format becomes3. Read/migrate1/2/3; context budget/usage/recovery minimum version stays2. Non-ignorable v3 semantics records must never be dropped.
- Generic standalone run/followup/tier submissions default unknown. Known root application admissions explicitly record human/request; child/system/plugin sources are observations. Provenance is recorded context evidence, never an execution authorization grant.
- Fence is emitted after seed/resume at the first new agent turn, never automatically by createSession. Budget observations do not accept responses. An explicit complete end plus acceptance barrier is required before tool preparation/effects; later post-tool failure cannot revoke acceptance.
- Preserve native block order/sidecars, six-route grouping, truthful canonical unknown/not-dispatched evidence, current provider/tool-call-ID policy and no effect replay. Failed-unaccepted call-ID reuse is recorded for R5 coverage; do not broaden ID policy in R1B.
- Positional checkpoint DTO/rendering belongs to R1D. Snapshot/freshness redesign belongs R1C; attempt allowance/uncertain checkpoint transactions belong R3/R5. R1B IDs are stable inputs to that future owner, not a second retry ledger.
- Maintained modules near150–400 lines, functions normally<=120, facade150–250 or less. No giant closure moved intact, all-locals deps bag, duplicate raw session owner or test-file splitting. S20/CX1 completion credit is not claimed by these partial changes.

## Task 1: Ship format3 explicit acceptance, provenance, recovery and seeds atomically

Read this task as your requirements. Work only D:/I-harness-main on the reviewed R1A baseline supplied by root. All delegated roles GPT6.1Sol; you are the sole product writer and must not spawn agents/reviewers, push/merge/publish, call live providers, use real profiles/accounts, install dependencies or switch branches/worktrees. Product remains0.1.13-rc.1; session format becomes3 as specified. Tests/scripts are not split and existing permission/timeout/assertion/reachability gates are not weakened. Use cohesive150–400line modules, functions normally<=120, no all-localsbag or duplicate rawlog/dispatch/decision owners. Root supplies the plan-scoped report/evidence directory; never reuse or overwrite another phase's ledger.

**Consumes:** reviewed R1A ConversationProjection/ConversationItem and current Session/LLMMessage/ProviderContinuation; existing coordinator serialized mutation gate, write-behind, flush and tool executor dispatch ownership.

**Produces:** exact persisted/public interfaces and behaviors below, real root/child consumers, focused evidence and one reviewable final diff. Internal commits may separate schema/readers, writer/provenance and seeds/consumers, but root must not enable/release or treat an intermediate partial commit as completed R1B.

### File responsibility map

Create:

- `packages/core-session/src/events/conversation.ts`: event/provenance types and shape/version validation.
- `packages/core-session/src/conversation/validation.ts`: incremental reference/fence metadata index and complete-prefix validator. Split shape/index into cohesive leaves if size requires; keep public entry exports narrow.
- `packages/core-agent/src/agent/exchange.ts`: logical/physical step identity, idempotent fence and accepted-response writer.
- `packages/session-persistence/src/seed.ts`: batch seed semantics/fence/reference transform shared by session forks and subagent turn forks.
- `packages/session-persistence/src/coordinator/conversation-index.ts`: writer-owned derived metadata cache, invalidation and prefix-aware staging; no raw event array cache.
- Tests: `packages/core-session/test/exchange-acceptance.test.ts`, `packages/core-agent/test/accepted-exchange.test.ts`, `packages/session-persistence/test/conversation-format.test.ts`, `packages/session-persistence/test/seed-semantics.test.ts`.

Modify:

- Core-session events/types/append/state, inbox, serialization/jsonl, public index; R1A conversation sources/visibility/legacy/project/exchange modules at their existing owners.
- Core-agent agent/types/create/turn/step-input/model-loop/model-step/finalization, executor.ts and exports where the real callers need types.
- Persistence format/registry + validation; coordinator/load/mutations/writable-format/ownership/lifecycle and packages/session-persistence/src/index.ts composition; repair.ts; fork.ts/public index. JSONL index.ts upgrade path; extract `backend/format-upgrade.ts` only if the existing factory would otherwise grow.
- Executor service.ts root/notification admissions and assembly.ts schedule admissions; desktop-gateway/input.ts; apps/cli/src/run.ts; subagent child/lifecycle.ts, tools/followup.ts, followup/drive.ts, fork.ts, child.ts; agent-team scheduler/task-delivery.ts. Existing child assembly/resident flush and isSubagent wiring remains verified.
- Existing named tests below and package README ownership notes. Runtime-context/guard-repeat-tool/skill-mention already have explicit plugin/internal source markers: decode them faithfully; change those producers only if needed to remove a real ambiguous path, not to duplicate equivalent evidence.

Paths in this map are under `packages/` except `apps/cli` and `e2e`.

### Fixed interfaces

```ts
export interface InputProvenance {
  kind: 'human' | 'plugin' | 'child-report' | 'inherited' | 'unknown';
  authority: 'request' | 'observation' | 'unknown';
  scope: 'turn' | 'session';
  producer: string;
  originSessionId?: string;
}
export type ConversationSemanticsEvent = {
  type: 'conversation/semantics'; version: 1; seq?: number;
  mode: 'accepted-exchange-v1';
};
export type ExchangeAcceptedEvent = {
  type: 'model/exchange-accepted'; version: 1; seq?: number;
  exchangeId: string; actionId: string; attemptId: string;
  stepStartSeq: number; assistantSeq: number; callSeqs: number[];
};
export interface AgentInputOptions { provenance: InputProvenance }
// Optional final options preserve existing source callers.
run(task: string, signal?: AbortSignal, images?: ImageInput[],
  inputId?: string, options?: AgentInputOptions): Promise<AgentResult>;
followup(message: string, signal?: AbortSignal,
  options?: AgentInputOptions): Promise<AgentResult>;
```

Persist optional `provenance` on admitted/user-message/subagent-inbox records and optional actionId/attemptId on step/start. `AdmittedInput`, `PendingInput`, `UserMessageInput`, InputSubmit and AgentRunSurface forward them; do not discard provenance in pending/claim/map helpers. A matched admission takes precedence over per-call options; reject a conflicting supplied descriptor, do not overwrite it. Missing provenance after the fence is unknown; legacy human-intent admission inference remains only for the legacy region. Legacy/source IDs retain R1A meanings.

Shapes allow only human→request, plugin/child-report/inherited→observation, unknown→unknown. IDs/producers are nonempty strings<=256 code units, seq references are safe nonnegative integers, callSeqs has no duplicates. Optional originSessionId uses the same bounded string rule. Reject unknown payload fields except the shared event envelope; existing events retain their existing shape policies. Do not set a tiny accepted-record byte limit that rejects valid parallel calls. Accepted IDs are owner-session-scoped; remapped seeds namespace local IDs deterministically without inventing parent seqs.

```ts
export interface ConversationValidationIndex {
  readonly eventCount: number;
  readonly semanticsStartSeq: number | undefined;
  stage(events: readonly SessionEvent[]): { commit(): void };
}
export function createConversationValidationIndex(
  events?: readonly SessionEvent[]
): ConversationValidationIndex;
export function validateConversationHistory(
  events: readonly SessionEvent[], formatVersion: number
): void;
export function validateConversationEventShape(
  event: SessionEvent, formatVersion: number
): void;
export function remapConversationSeed(input: {
  source: readonly SessionEvent[];
  retained: readonly SessionEvent[];
}): SessionEvent[];
```

Shape validator throws an Error with `code:'SESSION_CONVERSATION_FORMAT'` and scalar-safe reason; persistence wraps it as SessionFormatUnsupportedError at public format gates, preserving cause. History validator builds/reuses the same index algorithm, not a second acceptance algorithm. `stage` checks the whole proposed suffix atomically against metadata and staged earlier entries, and commits metadata only once the owner accepts that append. Metadata contains seq→type/index/physical-step/call identity, step failed/accepted facts, exchange IDs, fence and pending refs, never raw text/args/output/native bodies. Complexity O(history) on load and O(new events + referenced calls) per append; no full archive scan/hash on every delta/event or every individual acceptance.

The in-memory Session append owner holds its index in existing event state (WeakMap): build once after external restored/seed arrays are installed, then process suffixes. Truncation/array replacement invalidates/rebuilds; revalidate actual referenced structural fields before accepting a new record, and complete projection/load validation must not silently certify malformed same-length metadata mutation. R1C owns immutable request capture. Commit in-memory index state at the same append visibility point as session.events.push, before observation hooks; a throwing observer cannot leave an index that forgot an already appended event. The coordinator cache is derived under its existing ownership/operation gate, invalidated on loadOwned recovery/replace, ownership release/deletion/close. External append batches validate against a loaded prefix or coherent cached index; ordinary mirrored enqueue does shape-only admission plus incremental prefix validation in the serialized write lane. On failed/uncertain storage append invalidate metadata and reread before another attempt; do not blindly append a duplicate accepted record. No second raw log, background validation writer or independent retry budget. The operation-count requirement below concerns new validation metadata work; existing backend full-file I/O is measured separately and remains CX1/R6 work unless a safe owner-bound optimization is needed here. Do not claim bounded disk I/O merely from incremental validation.

### Step1: Record the exact baseline and RED evidence

- [ ] Read reviewed R1A spec/report, source map and this whole task. Record HEAD, scoped git status and baseline logs in `.tmp/context-redesign-20261015/r1b/`. Root supplies any current unrelated writer status; do not revert it.
- [ ] Reuse same-HEAD recorded package/corpus baselines when available. Otherwise run core-session tests/types, core-agent main-response-fence and existing JSONL context-format once, sequential worker bounds below.
- [ ] Add new tests first. First RED must show missing event/API or failure of the intended new behavior, not an import typo. Use concrete archive sequences and direct assertions, not expected values generated by the new projector/validator.

Concrete acceptance fixture/test shape:

```ts
const events: SessionEvent[] = [
  { type:'conversation/semantics',version:1,mode:'accepted-exchange-v1',seq:0 },
  { type:'step/start',actionId:'a',attemptId:'p',seq:1 },
  { type:'tool/call',callId:'c',name:'read',args:{path:'x'},seq:2 },
  { type:'assistant/message',text:'reading',seq:3 },
  { type:'model/exchange-accepted',version:1,exchangeId:'e',actionId:'a',
    attemptId:'p',stepStartSeq:1,assistantSeq:3,callSeqs:[2],seq:4 },
];
expect(() => validateConversationHistory(events,3)).not.toThrow();
const index = createConversationValidationIndex(events.slice(0,4));
index.stage(events.slice(4)).commit();
expect(index.eventCount).toBe(5);
expect(() => validateConversationHistory([
  ...events.slice(0,4), { ...events[4], assistantSeq:2 }
] as SessionEvent[],3)).toThrow();
```

### Step2: Implement versioned shapes, indexed validation and explicit projection

- [ ] Add schema/exports and format3. Accept1/2/3 in core-session fromJSONL/migrate. Operational context events retain minimum2; remove `formatVersion===CURRENT` gates that incorrectly reject version2 context facts, replacing them with explicit minimum/capability checks. Version1 carrying operational context and version1/2 carrying v3 fields must fail.
- [ ] Implement the index with checks: unique addressable refs, correct event kinds, all refs preceding acceptedSeq and after stepStartSeq, same physical step, call refs in original observation order, matched action/attempt IDs, no prior failure/acceptance for that attempt, no duplicate exchange ID. A dispatch after the fence requires a previously accepted call. Do not require results at acceptance. Post-acceptance step failure is settlement evidence, not revocation.
- [ ] Keep legacy diagnostics/rendering for pre-fence unsafe seq coordinates. Explicit accepted records may reference only uniquely valid addresses. Full-prefix malformed v3 fails closed; it cannot be downgraded to legacy.
- [ ] Project the fence independently of compaction/rewind visibility. Pre-fence uses existing inference; post-fence calls/assistant audit records only gain an explicit exchange via acceptance. Unaccepted failure fragments remain hidden even if repair adds errors. Accepted unresolved exchange metadata remains available while protocol rendering suppresses incomplete call/result bundles as required by existing pairing behavior; once truthful results arrive, preserve exact R1A grouping/native sidecars. No manufactured success.
- [ ] Add tests: before-fence legacy + after-fence unaccepted/accepted; fence hidden by rewind/reset; header3 without fence; duplicate/missing/forward/wrong-kind/cross-step refs; duplicate acceptance; failure before acceptance reject; failure after acceptance retains accepted metadata; reverse result completion; signed/native tool-only assistant.

### Step3: Implement actual producer acceptance barrier

- [ ] In exchange.ts define `ModelAttemptIdentity = { actionId:string; attemptId:string; stepStartSeq:number }`, `ensureConversationSemantics(session):void`, and `acceptModelExchange(deps, input):Promise<number>` where deps is `Pick<AgentDeps,'session'|'flush'>` and input is `{ identity:ModelAttemptIdentity; step:ModelStep; signal?:AbortSignal }`. Return accepted event seq; failure throws before tools.prepare. Helper appends one assistant/message and acceptance using batch.eventSeq refs, and flushes. It does not dispatch tools or mutate binding/native data.
- [ ] At first new turn after restored/seed state, ensure one fence before turn/start/new step; constructor remains empty. First model transport's existing admission checkpoint flushes fence. Allocate logical action once per normal main step; physical attempts/recovery reuse action and mint attempt. A waiting/reopen retry starts a new physical identity even before any output; set IDs once and avoid minting again on matching attempting/recovered notification. Preserve discard-output safety when content exists. Retain actual physical start seq in ModelStep result so acceptance never references an earlier failed step. Do not alter usedCallIds behavior.
- [ ] Reject iterator exhaustion without explicit end using `code:'MODEL_RESPONSE_INCOMPLETE'`; preserve audit/step-failed evidence, zero acceptance and zero tool prepare/effect. Existing refused/truncated errors remain. Always append assistant/message for accepted tool-only/empty responses, attaching original native sidecar, then accepted record and await flush before recovery resolution/tool preparation. Remove the old assistant append from completeModelStep so exchange.ts is the only acceptance append owner; retain its usage reporting/calibration through a narrow caller. Reject text/tool content after end or repeated conflicting end; trailing usage/activity/retry observation metadata alone does not create another response. Keep usage reporting/calibration semantics truthful.
- [ ] Mark lifecycle provider completion consistently with immutable acceptance. No failure path appends a retroactive model rejection after accepted record. Tool approval/finalization/post-tool/save failures preserve acceptance and their real results/unknown states.
- [ ] Test with real core-agent + ToolRegistry mocks: clean end accepts; no-end/error/refusal/truncation rejects; retry after text/calls and before output accepts only last attempt with same action/new attempt; flush records ordering; acceptance flush rejection causes zero prepare/approval/body calls; dispatch flush still precedes body; Stop/post-tool throw preserves accepted fact without another dispatch. Do not test failed-call-ID reuse as newly supported; record current limitation for R5.

### Step4: Upgrade every writable boundary and append-only fenced recovery

- [ ] Register v3 types and identity2→3. Separate batch shape preflight from complete-prefix validation. Complete read/snapshot/load/loadOwned preflight rejects unsupported/malformed histories before backend repair, and validates migrated/recovered prefix again. Direct append/enqueue/write-behind/updateMeta/adoptOwnership/loadOwned keep existing serialized header barrier; external acceptance refs may point into preceding batches.
- [ ] JSONL upgrade accepts expected1/2/current and target3, preserves raw body/unknown metadata through existing atomic header replacement. Test real backend methods; do not create another backend. Version3 header without fence and crash between header upgrade/fence remain readable as legacy prefix. A custom backend missing required writable-upgrade capability fails closed.
- [ ] Fenced repair never inserts records into existing positions. Append missing truthful synthetic result/error facts at new seqs associated with accepted call IDs, then missing closers if needed; closed accepted unresolved tails can receive append-only recovery facts. Unaccepted observations remain unaccepted regardless of added repair evidence. Apply legacy repair only to its legacy region; do not infer unaccepted fenced calls were dispatched from old markers elsewhere. Canonical TOOL_OUTCOME_UNKNOWN + isError:true + replay:false remains unknown. Do not weaken non-dispatched evidence or claim dispatch marker proves body completed.
- [ ] Verify original defined seqs/ref targets and body prefix unchanged after owned recovery; second loadOwned is idempotent; read-only snapshot never repairs/writes. Fault tests cut before/after acceptance, dispatch, result and flush failure. Do not simulate an old reader by running the new reader with a fake constant: actual format4 rejection and durable version3 header assertions are honest compatibility evidence; historical reader execution only if pinned real code is explicitly tested.

### Step5: Wire trusted root and observation sources, including pending producers

- [ ] Add optional Agent per-call options and generic tier provenance. `run/followup` without options records unknown producer `agent.run`/`agent.followup`; generic tier submissions default unknown. Inbox matching admission determines promoted source and images; conflict rejects. Claim/pending/restart preserves descriptor.
- [ ] Provenance region follows its evidence: an explicit descriptor on an earlier admission is retained across a later fence. A pre-fence legacy admission may retain R1A's conservative recorded-human inference when promoted later; a newly fenced admission with no descriptor is unknown. Neither path grants child-local authority when the source admission belongs to the inherited seed. A new message without matching admission/explicit descriptor remains unknown regardless of its user role.
- [ ] Known root application boundaries record `{kind:'human',authority:'request',scope:'turn',producer:<boundary>}`: session-executor service submit (`session.prompt`), desktop live/recovery admission (`desktop.input`), CLI initial/send/followup/steer (`cli.prompt`). SDK/ACP already call service.submit; verify their actual route rather than accepting caller-chosen authority. Root source facts do not imply physical-human authentication or broaden authorization.
- [ ] Service parent notifications use child-report observation for task/team reports and plugin observation for other injected host messages; schedule assembly producer uses plugin observation with preserved synthetic scope/display. Core-agent hook feedback uses plugin observation; existing plugin/internal markers remain observations even without the new descriptor.
- [ ] Child initial publish passes inherited observation with available parentSessionId. Subagent send/followup tools append inherited provenance to durable subagent/inbox; drive forwards it through per-call options, defaulting inherited observation/unknown for old records. Team task-delivery appends child-report observations to lead/member inboxes. No source descriptor is inferred from message text/display title. Existing child/resident flush remains coordinator-backed.
- [ ] Authority table asserts unknown standalone/root explicit human/child inherited/plugin/system/legacy admission/seeded human. Verify pending cold admissions and idle/active steering paths, preserving wire text/images and exact bytes. Current human protection will consume these sources in R1C/D independently of unknown authority.

### Step6: Make seed transformation fence-aware and address-safe

- [ ] Implement batch remapConversationSeed used by completedTurnPrefix and forkTurns. Identify original region before filtering; include one fence before first retained explicit-region event, even if original fence was sliced away and only failed observations survive. Preserve no-fence legacy-only seeds. Validate every retained accepted bundle is complete before child create; partial bundles reject with SessionForkUnavailableError (export and reuse it for the subagent seed helper), never drop acceptance and reinterpret calls as legacy.
- [ ] Build final renumber map after fence insertion. Remap accepted stepStartSeq/assistantSeq/callSeqs, dispatch.eventSeq, summary/reset/title/rewind refs, image admission materialization and source IDs under existing rules. Preserve named remapSeedEvent compatibility facade for remaining actual callers; it must not pretend isolated events can reconstruct missing semantics. Recompute persisted/live header.seedLength from final seed. Seed provenance always inherited; available originSessionId is lineage only.
- [ ] Table tests: empty; legacy-only; all-fenced; mixed legacy→fence→explicit; sliced-away fence + accepted group; sliced-away fence + unaccepted failed group; rewind/hidden fence; partial accepted bundle reject; image admission missing from slice; tool dispatch refs; multiple existing marker remaps. Assert old human admissions do not gain child-local request authority and original parent objects/refs stay unchanged.

### Step7: Final focused gates, structural evidence and root review

- [ ] Run tests sequentially with `pnpm --filter <package> exec vitest run <files> --maxWorkers=2 --minWorkers=1`, saving actual commands/exits. Do not run unchanged broad suites repeatedly. Package-local names below mean `test/<name>.test.ts`; pass the listed files as separate arguments. Package-local file groups:

| Package | Files/gate |
|---|---|
| core-session | full suite + typecheck; new exchange-acceptance and existing conversation/compacted-step/inbox/serialization cases |
| core-agent | accepted-exchange, main-response-fence, failed-turn-finalization, final-save, execute-tool-calls, model-recovery, step-inputs, executor, provider-reasoning-loopback |
| session-persistence | conversation-format, seed-semantics, load-gate-coverage, m4-crash-acceptance, repair, fork, input-persistence, coordinator-order, write-behind |
| session-persistence-jsonl | context-format, jsonl, meta |
| session-executor | admitted-input, event-driven-steering, schedule-delivery, hook-context, default-parent-writer |
| subagent | child, resume, fork-isolation, native-context-role, tools |
| desktop-gateway | input, input-idempotence |
| cli | input-tiers, run-end |
| agent-team | completion-delivery, child-sequence, lifecycle, mailbox |

- [ ] Run changed package typechecks individually, then `pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1` and `pnpm exec tsc --noEmit -p e2e/tsconfig.json`. Add SDK/ACP focused gate only for changed application wiring/type boundary. Six route golden/native grouping remains unchanged; no live transport validation is claimed.
- [ ] Demonstrate validation complexity with operation-count test: a large prefix plus many one-event suffixes visits each newly indexed event once and each accepted call ref once; avoid wall-clock-only assertions. State metadata stores no raw prompt/tool bodies; owner invalidation/reload tests pass.
- [ ] Record before→after file/function sizes, import direction/public consumer paths, only one projector/archive writer/tool dispatcher, exact old owner exits and unchanged pending S/CX counts. Run `git diff --check`; use actual reachability before/after only if moved ownership affects it, never reseed/allowlist. Split cohesive large additions before review.
- [ ] Commit scoped internal/final changes as directed by root; suggested final title `feat(session): persist accepted exchanges and input provenance`. Report RED/GREEN, fixed HEAD, commands/exits, crash/seed/source matrix, real remaining limitations and exact file map. Root supplies fresh independent spec/quality review and corrections. Continue authorized execution after review; do not ask user to approve this internal plan.

## R1B completion limits

Done means both main and child shipping paths produce/restore v3 accepted facts and truthful provenance with safe barriers/references; schema-only exports or test-only consumers do not qualify. R1B does not claim native route/account compatibility certification, immutable snapshot admission, structural nonprefix compaction, transaction CAS/unknown resolution, attempt budgets, failure-ID-reuse recovery, new backend, full S20/CX1 decomposition or release readiness. These remain their already-authorized later phases with recorded interfaces and evidence.
